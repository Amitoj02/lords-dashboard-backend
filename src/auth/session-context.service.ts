import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordIdentity } from './entities/discord-identity.entity';

/**
 * The authorization context resolved fresh for a Discord identity: the caller's
 * current member (if any), effective role, regiment and the session cutoff.
 */
export interface ResolvedSessionContext {
  identityId: string;
  discordUserId: string;
  memberId: string | null;
  role: MemberRole;
  regimentId: string;
  /** discord_identities.sessions_valid_from as epoch seconds, or 0 if unset. */
  sessionsValidFromSec: number;
}

interface CacheEntry {
  context: ResolvedSessionContext;
  expiresAt: number;
}

/** How long a resolved context is trusted before a fresh DB read (safety net). */
const CACHE_TTL_MS = 30_000;

/**
 * Resolves a request's authorization context from ONLY the identity id in a
 * validated JWT (T-0046). Given `sub`, it looks up the identity, its current
 * roster member (by discordIdentityId), and derives the live role/regiment/
 * memberId — so stale token claims are unnecessary. Results are cached per
 * identity (short TTL + explicit {@link invalidate}) to avoid a DB round-trip on
 * every authenticated request; any change to a member's role/existence or the
 * session cutoff MUST invalidate the identity so the next request re-resolves.
 *
 * This is the single choke point every protected route depends on, so it is
 * defensive: an identity with no member resolves as an Applicant against the
 * single default regiment (parity with today's identity-only session).
 */
@Injectable()
export class SessionContextService {
  private readonly logger = new Logger(SessionContextService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private defaultRegimentId: string | null = null;

  constructor(
    @InjectRepository(DiscordIdentity)
    private readonly identities: Repository<DiscordIdentity>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
  ) {}

  /**
   * Resolve the caller's live context, or null when the identity no longer
   * exists (the token should then be rejected). Cached for CACHE_TTL_MS.
   */
  async resolve(identityId: string): Promise<ResolvedSessionContext | null> {
    const now = Date.now();
    const cached = this.cache.get(identityId);
    if (cached && cached.expiresAt > now) {
      return cached.context;
    }

    const identity = await this.identities.findOne({ where: { id: identityId } });
    if (!identity) {
      this.cache.delete(identityId);
      return null;
    }

    // Resolve the roster member fresh (a member links an identity 0..1). Role,
    // regiment and memberId always come from the live row, never the token.
    const member = await this.members.findOne({
      where: { discordIdentityId: identity.id },
    });

    // Enforce moderation state at the single authorization choke point: a banned
    // member — or one under an active suspension — is DENIED (null → JwtStrategy
    // 401), so a ban/suspend can never be defeated by simply re-authenticating.
    // Not cached, so access re-enables immediately once a suspension lapses.
    if (member && this.isBlocked(member)) {
      this.cache.delete(identityId);
      return null;
    }

    const context: ResolvedSessionContext = {
      identityId: identity.id,
      discordUserId: identity.discordUserId,
      memberId: member?.id ?? null,
      role: member?.role ?? MemberRole.Applicant,
      regimentId: member?.regimentId ?? (await this.getDefaultRegimentId()),
      sessionsValidFromSec: identity.sessionsValidFrom
        ? Math.floor(identity.sessionsValidFrom.getTime() / 1000)
        : 0,
    };

    this.cache.set(identityId, { context, expiresAt: now + CACHE_TTL_MS });
    return context;
  }

  /**
   * Drop the cached context for an identity (or all) so the next request
   * re-resolves. Call after any role/member change or session-cutoff bump.
   */
  invalidate(identityId?: string | null): void {
    if (identityId) {
      this.cache.delete(identityId);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Hard-invalidate every outstanding token for an identity by advancing its
   * `sessions_valid_from` cutoff to now (T-0048). Used on logout and sensitive
   * events (ban/suspend). Best-effort + also drops the cache so the new cutoff
   * takes effect on the very next request. No-op for a null identity id.
   */
  async invalidateSessions(identityId: string | null | undefined): Promise<void> {
    if (!identityId) return;
    try {
      await this.identities.update({ id: identityId }, { sessionsValidFrom: new Date() });
    } catch (error) {
      this.logger.error(
        `Failed to bump session cutoff for ${identityId}: ${(error as Error).message}`,
      );
    } finally {
      this.invalidate(identityId);
    }
  }

  /** True when a member is banned or currently under an active suspension. */
  private isBlocked(member: Member): boolean {
    if (member.bannedAt) return true;
    return !!member.suspendedUntil && member.suspendedUntil.getTime() > Date.now();
  }

  /** Resolve (and cache) the single regiment's id for identity-only sessions. */
  private async getDefaultRegimentId(): Promise<string> {
    if (this.defaultRegimentId) return this.defaultRegimentId;
    const regiment = await this.regiments.findOne({
      where: { id: Not(IsNull()) },
      order: { createdAt: 'ASC' },
    });
    if (!regiment) {
      // Should never happen once seeded; surface loudly rather than guessing.
      throw new Error('No regiment configured');
    }
    this.defaultRegimentId = regiment.id;
    return regiment.id;
  }
}
