import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthzService } from '../authz/authz.service';
import { Capability, MemberRole } from '../common/enums';
import { AppConfig } from '../config/configuration';
import { DiscordBotSettings } from '../discord/entities/discord-bot-settings.entity';
import { DiscordGateway } from '../discord/gateway/discord-gateway';
import { GuildStatusDto } from './dto/guild-status.dto';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { AuthenticatedUser } from './types/authenticated-user.interface';

/**
 * How long a confirmed verdict is trusted before the bot is asked again.
 *
 * Fifteen minutes, not thirty seconds like the session cache: this is a call to
 * a THIRD PARTY, not a local table read, and a member's guild status changes on
 * the scale of days. Live join/leave events (T-0169) write through immediately,
 * so the TTL is only the backstop for changes Discord never told us about.
 */
const VERDICT_TTL_MS = 15 * 60_000;

/**
 * How long a DEGRADED (unconfirmed) verdict is held before retrying. Much
 * shorter than {@link VERDICT_TTL_MS} so the regiment recovers within a minute
 * of the bot coming back, rather than staying fail-open for a quarter of an
 * hour. Retrying this often is cheap because the breaker below short-circuits
 * the actual gateway call while the bot is down.
 */
const DEGRADED_TTL_MS = 60_000;

/**
 * Upper bound on a single bot lookup. Inherited from the sign-in path (T-0050)
 * and deliberately unchanged: sign-in still runs one of these inline, so raising
 * it would raise login latency when the bot is hung.
 */
const GUILD_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Consecutive gateway failures after which lookups stop being attempted at all.
 * Without this, every sign-in and every guild-status poll pays the full
 * {@link GUILD_LOOKUP_TIMEOUT_MS} while the bot is disconnected — 4s added to
 * every login for as long as the outage lasts.
 */
const BREAKER_FAILURE_THRESHOLD = 3;

/** How long the breaker stays open before letting a single probe through. */
const BREAKER_COOLDOWN_MS = 60_000;

/** The persisted half of a verdict, as any row carrying the pair provides it. */
export interface StoredGuildVerdict {
  guildMember: boolean;
  guildCheckedAt: Date | null;
}

/** A resolved verdict: what we believe, when it was confirmed, and how sure. */
export interface GuildVerdict {
  guildMember: boolean;
  checkedAt: Date | null;
  /** True when this is NOT a fresh confirmation (bot down / never checked). */
  degraded: boolean;
}

interface CacheEntry {
  verdict: GuildVerdict;
  expiresAt: number;
}

/**
 * Owns the answer to "is this identity in the regiment's Discord guild?" —
 * caching it, re-checking it on a TTL, writing live join/leave events through,
 * and deciding what to report when the bot cannot be reached (T-0167/T-0168).
 *
 * Two properties are load-bearing and neither is negotiable:
 *
 * 1. **It is never on the request path.** Nothing here is wired into
 *    JwtStrategy or SessionContextService, so an ordinary authenticated request
 *    can NEVER trigger a Discord call. The only entry points are sign-in (one
 *    bounded lookup, as before) and the explicit GET /auth/guild-status poll.
 * 2. **It fails OPEN.** The original sign-in code returned `false` for every
 *    degraded case — no guild configured, gateway threw, lookup timed out.
 *    That was harmless while the flag was informational, but this verdict now
 *    gates access, and "the bot is down" would have become "all 576 members are
 *    locked out". A lookup that did not complete keeps the last known verdict,
 *    and an identity that has never been confirmed is treated as a member.
 *    Only a COMPLETED lookup writes `guild_member`/`guild_checked_at`.
 */
@Injectable()
export class GuildMembershipService implements OnModuleInit {
  private readonly logger = new Logger(GuildMembershipService.name);
  /** identityId → the last verdict and when it goes stale. */
  private readonly cache = new Map<string, CacheEntry>();
  /** identityId → the lookup already running, so concurrent callers share one. */
  private readonly inFlight = new Map<string, Promise<GuildVerdict>>();

  private consecutiveFailures = 0;
  /** Epoch ms until which the breaker is open; 0 when closed. */
  private breakerOpenUntil = 0;
  private halfOpenProbeInFlight = false;
  /** Guards the degraded warning so an outage logs once, not once per request. */
  private degradedWarned = false;

  constructor(
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
    private readonly gateway: DiscordGateway,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly authz: AuthzService,
  ) {}

  /**
   * Subscribe to live membership events (T-0169). Registering here rather than
   * in the Discord module keeps the verdict's only writer in one class; the
   * gateway accumulates handlers, so onboarding's own join subscription is
   * unaffected.
   */
  onModuleInit(): void {
    this.gateway.registerMemberJoinHandler((discordUserId) => this.onGuildJoin(discordUserId));
    this.gateway.registerMemberLeaveHandler((discordUserId) => this.onGuildLeave(discordUserId));
  }

  /**
   * Read a stored verdict WITHOUT any I/O — the projection path (/auth/me) uses
   * this so rendering the session never costs a Discord call or a settings read.
   *
   * A null `guildCheckedAt` means the pair has never been confirmed (a fresh
   * identity, or every row in the database on the deploy that adds the column),
   * and is reported as a degraded `true`. That is the same fail-open rule the
   * live path applies, so /auth/me and /auth/guild-status can never disagree.
   */
  static verdictOf(stored: StoredGuildVerdict | null | undefined): GuildVerdict {
    if (!stored?.guildCheckedAt) {
      return { guildMember: true, checkedAt: null, degraded: true };
    }
    return { guildMember: stored.guildMember, checkedAt: stored.guildCheckedAt, degraded: false };
  }

  /** The full guild-status projection for a caller (GET /auth/guild-status). */
  async getStatus(user: AuthenticatedUser): Promise<GuildStatusDto> {
    const [verdict, flags] = await Promise.all([
      this.resolve(user.identityId),
      this.gateFlags(user.regimentId, user.role),
    ]);
    return {
      guildMember: verdict.guildMember,
      gateEnabled: flags.gateEnabled,
      exempt: flags.exempt,
      checkedAt: verdict.checkedAt ? verdict.checkedAt.toISOString() : null,
      degraded: verdict.degraded,
    };
  }

  /**
   * Server-side enforcement of the guild gate (LDA-M5). Returns true when this
   * caller must be denied: the gate is on, they do not hold the exempting
   * capability, and their STORED verdict is a confirmed non-member. Reads only the
   * persisted verdict (never probes the bot), so it is safe on the request path —
   * the same fail-open rule as /auth/me applies: an unconfirmed/degraded verdict is
   * treated as a member, so a bot outage never locks anyone out.
   */
  async isGatedOut(user: AuthenticatedUser): Promise<boolean> {
    if (!(await this.isGateEnabled(user.regimentId))) return false;
    if (await this.authz.can(user.regimentId, user.role, Capability.ManageSettings)) return false;
    const identity = await this.identities.findOne({ where: { id: user.identityId } });
    const verdict = GuildMembershipService.verdictOf(identity);
    return !verdict.guildMember && !verdict.degraded;
  }

  /**
   * Whether the gate is on for this regiment, and whether this caller bypasses
   * it. Exemption is unconditional for manage_settings holders: they are the
   * only people who can fix a bad invite, an unbound guild or a disconnected
   * bot, so gating them out of the settings screen would make the failure
   * unrecoverable through the product.
   */
  async gateFlags(
    regimentId: string,
    role: MemberRole,
  ): Promise<{ gateEnabled: boolean; exempt: boolean }> {
    const [gateEnabled, exempt] = await Promise.all([
      this.isGateEnabled(regimentId),
      this.authz.can(regimentId, role, Capability.ManageSettings),
    ]);
    return { gateEnabled, exempt };
  }

  /**
   * The regiment's master gate switch. A missing settings row reads as OFF —
   * the row is materialised lazily by the Discord module, and "not configured
   * yet" must never mean "gated".
   */
  async isGateEnabled(regimentId: string): Promise<boolean> {
    const settings = await this.settings.findOne({ where: { regimentId } });
    return settings?.guildGateEnabled ?? false;
  }

  /**
   * The verdict for an identity, re-checking against the bot at most once per
   * {@link VERDICT_TTL_MS}. Concurrent callers for the same identity share a
   * single in-flight lookup, so a client that opens five tabs at once still
   * costs the bot one call.
   */
  async resolve(identityId: string): Promise<GuildVerdict> {
    const cached = this.cache.get(identityId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.verdict;
    }
    const running = this.inFlight.get(identityId);
    if (running) return running;

    const lookup = this.lookup(identityId).finally(() => this.inFlight.delete(identityId));
    this.inFlight.set(identityId, lookup);
    return lookup;
  }

  /**
   * Ask the bot whether a Discord user is in the guild. Returns `null` for
   * "could not check" — the distinction from a confirmed `false` is the whole
   * point of this method, and callers MUST NOT collapse the two. Bounded by
   * {@link GUILD_LOOKUP_TIMEOUT_MS} and short-circuited by the breaker, so the
   * sign-in path keeps its latency budget even with the bot disconnected.
   */
  async probe(discordUserId: string): Promise<boolean | null> {
    const guildId = this.config.get('discord', { infer: true }).guildId;
    // Nothing to check against — not a negative verdict, an absent one.
    if (!guildId) return null;
    if (!this.breakerAllows()) {
      this.warnDegraded('circuit breaker open after repeated gateway failures');
      return null;
    }
    try {
      const member = await this.withTimeout(
        this.gateway.fetchMember(discordUserId),
        GUILD_LOOKUP_TIMEOUT_MS,
      );
      this.onLookupSuccess();
      return member !== null;
    } catch (error) {
      this.onLookupFailure();
      this.warnDegraded((error as Error).message);
      return null;
    }
  }

  /**
   * Align the cache with a row written outside this service (the sign-in
   * upsert). A confirmed pair is cached, so the guild-status call that follows
   * a login does not repeat the lookup sign-in just performed; an unconfirmed
   * one drops the entry so the next read re-resolves from the row.
   */
  syncCache(identity: StoredGuildVerdict & { id?: string }): void {
    if (!identity.id) return;
    if (!identity.guildCheckedAt) {
      this.cache.delete(identity.id);
      return;
    }
    this.cache.set(identity.id, {
      verdict: {
        guildMember: identity.guildMember,
        checkedAt: identity.guildCheckedAt,
        degraded: false,
      },
      expiresAt: identity.guildCheckedAt.getTime() + VERDICT_TTL_MS,
    });
  }

  /** Drop a cached verdict (or all of them) so the next read re-resolves. */
  invalidate(identityId?: string | null): void {
    if (identityId) {
      this.cache.delete(identityId);
    } else {
      this.cache.clear();
    }
  }

  /**
   * A member joined the guild (T-0169). The verdict is written through
   * immediately so a re-join clears the gate on the next dashboard visit instead
   * of at the end of the TTL. Onboarding is NOT triggered from here — it is its
   * own subscriber, so neither concern can break the other.
   */
  private async onGuildJoin(discordUserId: string): Promise<void> {
    await this.recordEventVerdict(discordUserId, true);
  }

  /** A member left the guild (T-0169) — the case nothing used to observe. */
  private async onGuildLeave(discordUserId: string): Promise<void> {
    await this.recordEventVerdict(discordUserId, false);
  }

  /**
   * Persist a verdict observed from a live gateway event and make it visible
   * at once. The cache entry is REPLACED rather than merely dropped: the event
   * is itself a confirmed observation, so dropping it would send the very next
   * request off to the bot to re-derive something Discord just told us.
   *
   * An event for a Discord user with no identity row (someone who joined the
   * server but has never signed in) is simply ignored — there is nothing to
   * record against, and throwing would surface as an unhandled rejection inside
   * discord.js's emitter.
   */
  private async recordEventVerdict(discordUserId: string, guildMember: boolean): Promise<void> {
    try {
      const identity = await this.identities.findOne({ where: { discordUserId } });
      if (!identity) return;
      const checkedAt = new Date();
      await this.identities.update({ id: identity.id }, { guildMember, guildCheckedAt: checkedAt });
      this.cache.set(identity.id, {
        verdict: { guildMember, checkedAt, degraded: false },
        expiresAt: checkedAt.getTime() + VERDICT_TTL_MS,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record guild membership for ${discordUserId}: ${(error as Error).message}`,
      );
    }
  }

  /** Cache miss: re-check against the bot, falling back to the stored verdict. */
  private async lookup(identityId: string): Promise<GuildVerdict> {
    const identity = await this.identities.findOne({ where: { id: identityId } });
    const stored = GuildMembershipService.verdictOf(identity);
    const confirmed = identity ? await this.probe(identity.discordUserId) : null;

    if (confirmed === null) {
      // FAIL OPEN: keep what we last knew (or the fail-open default), and mark
      // it degraded so the client can say "unverified" rather than "denied".
      const verdict: GuildVerdict = { ...stored, degraded: true };
      this.cache.set(identityId, { verdict, expiresAt: Date.now() + DEGRADED_TTL_MS });
      return verdict;
    }

    const checkedAt = new Date();
    await this.identities.update(
      { id: identityId },
      { guildMember: confirmed, guildCheckedAt: checkedAt },
    );
    const verdict: GuildVerdict = { guildMember: confirmed, checkedAt, degraded: false };
    this.cache.set(identityId, { verdict, expiresAt: checkedAt.getTime() + VERDICT_TTL_MS });
    return verdict;
  }

  /**
   * Whether a gateway call may be attempted. Closed → yes. Open → no, without
   * touching Discord. Half-open (the cooldown has elapsed) → exactly one probe
   * gets through; its outcome closes the breaker or re-opens it for another
   * cooldown.
   */
  private breakerAllows(): boolean {
    if (this.breakerOpenUntil === 0) return true;
    if (Date.now() < this.breakerOpenUntil) return false;
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  private onLookupSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    this.halfOpenProbeInFlight = false;
    if (this.degradedWarned) {
      this.logger.log('Guild-membership lookups have recovered; verdicts are authoritative again.');
      this.degradedWarned = false;
    }
  }

  private onLookupFailure(): void {
    this.halfOpenProbeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
      this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
  }

  /**
   * Log an outage ONCE per episode. Warning per failed lookup would emit a line
   * per sign-in and per guild-status poll for the whole outage, burying the one
   * message an operator needs to see.
   */
  private warnDegraded(reason: string): void {
    if (this.degradedWarned) return;
    this.degradedWarned = true;
    this.logger.warn(
      `Guild-membership lookups are DEGRADED (${reason}). Verdicts fail open: the last ` +
        'known membership is kept and never-checked identities are treated as members.',
    );
  }

  /** Reject with a timeout error if `promise` has not settled within `ms`. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`gateway lookup timed out after ${ms}ms`)),
        ms,
      );
      // Don't let the timer hold the event loop open (e.g. during shutdown/tests).
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}
