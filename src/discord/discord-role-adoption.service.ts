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
   * `entryPrecedence` is the precedence of the rank they would otherwise enlist
   * at, and it acts as a FLOOR: only a rank that strictly outranks it is adopted
   * (precedence 1 is the top of the ladder, so "outranks" means a smaller
   * number). Without the floor, a regiment whose ladder carries a rung below the
   * entry rank could have an approval quietly enlist someone BELOW where the
   * officer expected — this is a promotion mechanism or it is nothing.
   *
   * ⚠️ Reads Discord. Call it OUTSIDE a database transaction.
   */
  async resolveFromGuild(
    regimentId: string,
    discordUserId: string | null,
    entryPrecedence: number,
  ): Promise<AdoptedRoleState> {
    if (!discordUserId) return NOTHING;
    try {
      // The same master switch every other Discord read/write answers to. With
      // the bot off nothing reconciles either, so there is no strip to pre-empt
      // and no reason to trust role state the app is not maintaining.
      const settings = await this.settings.findOne({ where: { regimentId } });
      if (!settings?.botEnabled) return NOTHING;

      const ref = await this.gateway.fetchMember(discordUserId);
      if (!ref?.roles.length) return NOTHING;
      const held = new Set(ref.roles);

      return {
        rank: await this.highestHeldRank(regimentId, held, entryPrecedence),
        medals: await this.heldMedals(regimentId, held),
      };
    } catch (error) {
      this.logger.error(
        `Could not read existing Discord roles for ${discordUserId}: ${(error as Error).message}`,
      );
      return NOTHING;
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
   *    so a leftover `@Mercenary` role must not overrule that decision.
   */
  private async highestHeldRank(
    regimentId: string,
    held: Set<string>,
    entryPrecedence: number,
  ): Promise<Rank | null> {
    const ranks = await this.ranks.find({ where: { regimentId } });
    let best: Rank | null = null;
    for (const rank of ranks) {
      if (!rank.discordRoleId || !held.has(rank.discordRoleId)) continue;
      if (isProtectedRankName(rank.name)) continue;
      if (rank.precedence >= entryPrecedence) continue;
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
   */
  private async heldMedals(regimentId: string, held: Set<string>): Promise<Medal[]> {
    const medals = await this.medals.find({ where: { regimentId } });
    return medals.filter((medal) => medal.discordRoleId && held.has(medal.discordRoleId));
  }
}
