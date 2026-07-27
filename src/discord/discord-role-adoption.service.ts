import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Medal } from '../medals/entities/medal.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { isProtectedRankName } from '../ranks/protected-ranks';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordGateway } from './gateway/discord-gateway';

/** What someone's existing Discord roles say the roster should already credit them with. */
export interface AdoptedRoleState {
  /** The rank their highest held rank role maps to; null when there is nothing to adopt. */
  rank: Rank | null;
  /** Every medal whose linked role they already hold. */
  medals: Medal[];
}

/** Nothing to carry over — the answer for every degraded path. */
const NOTHING: AdoptedRoleState = { rank: null, medals: [] };

/**
 * Why a guild read produced no usable answer. Each one is a DIFFERENT thing for
 * an operator to do about it, which is the whole reason they are distinguished:
 * "they never linked Discord" and "Discord did not answer" both look like an
 * empty result to the enlistment path, and an admin pressing a button needs to
 * be told which one they hit (T-0204).
 */
export type AdoptionUnavailableReason =
  /** The member has no linked Discord identity, so there is nobody to look up. */
  | 'not-linked'
  /** The regiment's bot master switch is off — role state is not being maintained. */
  | 'bot-disabled'
  /** The gateway does not see that user in the guild (left, or never joined). */
  | 'not-in-guild'
  /** The gateway threw: no token, no connection, rate limited, unknown guild. */
  | 'unreachable';

/**
 * A guild read that either succeeded (possibly finding nothing to adopt, which
 * is a real answer) or failed for a stated reason.
 */
export type AdoptionRead =
  { ok: true; state: AdoptedRoleState } | { ok: false; reason: AdoptionUnavailableReason };

/**
 * Read a Discord member's CURRENT guild roles and translate them back into
 * roster state (T-0202).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Sync ran one way. A rank or medal recorded on the dashboard became a Discord
 * role, and `DiscordSyncWorker.reconcileRoles` then treats the dashboard as the
 * only record there is: on the first reconcile of a member's life it strips
 * every MANAGED role they hold that the roster does not account for.
 *
 * For a regiment that existed on Discord before this dashboard did, that first
 * reconcile lands at the exact worst moment — enlistment approval. A veteran
 * who has been decorated by hand in the guild for two years signs up, an
 * officer approves them, and the bot takes every medal role off them, because a
 * brand-new member row credits them with nothing. The roles were the only place
 * that history was ever written down, and the strip erased it.
 *
 * So before the roster becomes the record, the roster LEARNS from what is
 * already there. What comes back here is written to the member row, which makes
 * the reconcile that follows agree with Discord instead of overruling it.
 *
 * Best-effort in the strictest sense: every failure path returns
 * {@link NOTHING} rather than throwing, because a gateway hiccup must never
 * cost the regiment an approval. The cost of returning nothing is the old
 * behaviour, which staff can still fix by hand.
 *
 * ── AND WHY IT IS NOT ONLY FOR ENLISTMENT (T-0204) ──────────────────────────
 * "Staff can still fix it by hand" turned out to be a real bill. Approvals taken
 * before T-0202 shipped — and any taken while the gateway was unreachable —
 * enlisted veterans at the entry rank with none of their decorations, and the
 * reconcile then stripped the roles that were the only record of them. So the
 * same read now also backs an explicit admin action on an EXISTING member
 * ("Derive data from Discord"), which is why {@link readGuildState} exists
 * alongside the swallow-everything wrapper: same rules, stated failures.
 */
@Injectable()
export class DiscordRoleAdoptionService {
  private readonly logger = new Logger(DiscordRoleAdoptionService.name);

  constructor(
    private readonly gateway: DiscordGateway,
    @InjectRepository(Rank)
    private readonly ranks: Repository<Rank>,
    @InjectRepository(Medal)
    private readonly medals: Repository<Medal>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
  ) {}

  /**
   * What this Discord user's guild roles say they have already earned.
   *
   * BEST-EFFORT: every failure flattens to {@link NOTHING}, which is what the
   * enlistment path wants — a gateway hiccup must not cost the regiment an
   * approval. An INTERACTIVE caller wants the reason instead; see
   * {@link readGuildState}.
   *
   * ⚠️ Reads Discord. Call it OUTSIDE a database transaction.
   */
  async resolveFromGuild(
    regimentId: string,
    discordUserId: string | null,
    entryPrecedence: number,
  ): Promise<AdoptedRoleState> {
    const read = await this.readGuildState(regimentId, discordUserId, entryPrecedence);
    return read.ok ? read.state : NOTHING;
  }

  /**
   * The same read as {@link resolveFromGuild}, but it SAYS WHY when it comes back
   * empty-handed (T-0204).
   *
   * An enlistment is right to shrug off a failed read: the approval matters more
   * than the carry-over. An admin who pressed "Derive data from Discord" is in
   * the opposite position — for them "nothing was derived" and "the bot is
   * switched off" are completely different facts, and collapsing the two into an
   * empty result is how a broken integration comes to look like a member who
   * simply had no roles.
   *
   * `floorPrecedence` is the precedence of the rank the member already holds (or
   * would enlist at), and it acts as a FLOOR: only a rank that strictly outranks
   * it is adopted (precedence 1 is the top of the ladder, so "outranks" means a
   * smaller number). Without the floor, a regiment whose ladder carries a rung
   * below the member's current one could have a derive quietly DEMOTE them —
   * this is a promotion mechanism or it is nothing. Pass `Infinity` for a member
   * who holds no rank at all, so any linked rank role qualifies.
   *
   * ⚠️ Reads Discord. Call it OUTSIDE a database transaction.
   */
  async readGuildState(
    regimentId: string,
    discordUserId: string | null,
    floorPrecedence: number,
  ): Promise<AdoptionRead> {
    if (!discordUserId) return { ok: false, reason: 'not-linked' };
    try {
      // The same master switch every other Discord read/write answers to. With
      // the bot off nothing reconciles either, so there is no strip to pre-empt
      // and no reason to trust role state the app is not maintaining.
      const settings = await this.settings.findOne({ where: { regimentId } });
      if (!settings?.botEnabled) return { ok: false, reason: 'bot-disabled' };

      const ref = await this.gateway.fetchMember(discordUserId);
      // Absent from the guild is a FAILED read: there is no role state to learn
      // from, and saying so beats reporting that they had earned nothing.
      if (!ref) return { ok: false, reason: 'not-in-guild' };
      // Present but bare is a SUCCESSFUL read of an empty hand — short-circuited
      // so it costs no catalogue queries to conclude the obvious.
      if (!ref.roles.length) return { ok: true, state: NOTHING };
      const held = new Set(ref.roles);

      return {
        ok: true,
        state: {
          rank: await this.highestHeldRank(regimentId, held, floorPrecedence),
          medals: await this.heldMedals(regimentId, held),
        },
      };
    } catch (error) {
      this.logger.error(
        `Could not read existing Discord roles for ${discordUserId}: ${(error as Error).message}`,
      );
      return { ok: false, reason: 'unreachable' };
    }
  }

  /**
   * The best rank whose linked role this member already wears, or null.
   *
   * PROTECTED ranks are never adopted. Each of the three is disqualified on its
   * own terms and not merely by the precedence floor, which the default ladder
   * happens to satisfy but an admin is free to reorder:
   *  - the entry rank is where enlistment already starts;
   *  - the Applicant rank's role marks an application in flight — the very role
   *    this applicant is wearing right now, and nobody is ever placed on that
   *    rank;
   *  - mercenary status is chosen by the enlistment track the officer approved,
   *    so a leftover `@Mercenary` role must not overrule that decision. The same
   *    holds for a later derive: whether someone is a mercenary is a roster
   *    decision, never one a stale guild role gets to make.
   */
  private async highestHeldRank(
    regimentId: string,
    held: Set<string>,
    floorPrecedence: number,
  ): Promise<Rank | null> {
    const ranks = await this.ranks.find({ where: { regimentId } });
    let best: Rank | null = null;
    for (const rank of ranks) {
      if (!rank.discordRoleId || !held.has(rank.discordRoleId)) continue;
      if (isProtectedRankName(rank.name)) continue;
      if (rank.precedence >= floorPrecedence) continue;
      if (!best || rank.precedence < best.precedence) best = rank;
    }
    return best;
  }

  /**
   * Every medal whose linked role this member wears. ALL of them, with no floor
   * and no cap: a medal is a record of something that happened, so unlike a rank
   * there is no such thing as adopting too many.
   *
   * One award per medal, even though the schema allows repeats — a role is a
   * boolean and cannot say how many times it was earned. Staff can add the rest.
   *
   * ⚠️ Every held medal is returned, including ones the member has ALREADY been
   * credited with on the roster: this read knows about Discord, not about
   * `member_medals`. A caller acting on an existing member must diff against
   * what they hold, or running it twice awards everything twice.
   */
  private async heldMedals(regimentId: string, held: Set<string>): Promise<Medal[]> {
    const medals = await this.medals.find({ where: { regimentId } });
    return medals.filter((medal) => medal.discordRoleId && held.has(medal.discordRoleId));
  }
}
