import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordGateway } from './gateway/discord-gateway';

/**
 * Minimum gap between two onboardings of the same Discord user. Discord can
 * redeliver GuildMemberAdd, and a member who leaves and re-joins in the same
 * sitting would otherwise be welcomed (and re-roled) every time — so a repeat
 * within this window is dropped (T-0169). Deliberately in-memory and local: it
 * must not depend on the stored membership verdict, because the verdict writer
 * is a SEPARATE subscriber to the same event and there is no defined order
 * between them.
 */
const ONBOARD_DEDUPE_MS = 5 * 60_000;

/**
 * Guild-join onboarding. On GuildMemberAdd the bot sends a welcome and, for
 * someone already on the roster, puts their Discord roles back — nothing else
 * (the owner decided the bot has NO slash commands; members use the webapp).
 * Everything goes through the outbox, so a flood of joins is rate-limited and
 * failures are retried/surfaced. The real gateway wires this to discord.js
 * events; the mock exposes simulateMemberJoin so the flow is testable with no
 * bot.
 *
 * ⚠️ NOTHING IS GRANTED TO A STRANGER ANY MORE (T-0191). This used to assign the
 * configured join role to every account that walked in, which is what made that
 * role meaningless as a permission anchor — a visitor who had never applied held
 * the same role as an enlisted member. Roles now come from ROSTER STATE alone.
 *
 * This is one of two independent subscribers to GuildMemberAdd; the other
 * (GuildMembershipService) writes the membership verdict. They are kept apart on
 * purpose: a failing welcome must not cost the regiment an accurate verdict, and
 * vice versa.
 */
@Injectable()
export class DiscordOnboardingService implements OnModuleInit {
  private readonly logger = new Logger(DiscordOnboardingService.name);
  /** discordUserId → epoch ms of the last onboarding (duplicate-join guard). */
  private readonly onboardedAt = new Map<string, number>();

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly sync: DiscordSyncService,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
  ) {}

  onModuleInit(): void {
    this.gateway.registerMemberJoinHandler((discordUserId) => this.onMemberJoin(discordUserId));
  }

  /** Handle a member joining the guild: welcome, then restore roles. Never throws. */
  async onMemberJoin(discordUserId: string): Promise<void> {
    try {
      if (this.recentlyOnboarded(discordUserId)) {
        this.logger.log(`Skipping repeat onboarding for ${discordUserId} (joined again)`);
        return;
      }
      const regimentId = await this.resolveRegimentId();
      if (!regimentId) return;
      // Stamp BEFORE the enqueues so two joins arriving together cannot both
      // pass the check while the first is still awaiting the regiment lookup.
      this.onboardedAt.set(discordUserId, Date.now());
      await this.sync.enqueueWelcome(regimentId, discordUserId);
      await this.restoreRoles(regimentId, discordUserId);
    } catch (error) {
      this.logger.error(`Onboarding for ${discordUserId} failed: ${(error as Error).message}`);
    }
  }

  /**
   * Give a RETURNING member their Discord roles back (T-0193).
   *
   * Leaving a guild strips every role Discord holds for you, and rejoining gives
   * none of them back — so a veteran who left and returned reappeared with the
   * rank, medals and membership the dashboard still credited them with and no
   * role to show for any of it. The roster is the record; this makes Discord
   * agree with it again.
   *
   * Three outcomes, and the ORDER of the checks is the rule:
   *  - not on the roster (a stranger, or an applicant with no member row yet) —
   *    nothing at all. This is the case the retired join-role grant got wrong.
   *  - BANNED — the Ban role, never the rank/medal set. Checked FIRST, because a
   *    banned member is still a roster row and a reconcile would hand their
   *    whole managed role set straight back. (`reconcileRoles` also refuses a
   *    banned member, so this is belt and braces — but the belt is what decides
   *    which of the two jobs is enqueued.) Still subject to the owner-gated
   *    `applyBanRoleOnBan` switch: with it off no Ban role was ever applied, so
   *    there is nothing to restore.
   *  - actively SUSPENDED — nothing. A suspension is a withdrawal of standing,
   *    and handing the roles back at the door would quietly end it early.
   *  - otherwise — a full reconcile, which grants rank role, medal roles and the
   *    Membership role from current roster state.
   *
   * Soft-deleted members are excluded by the default scope: a removed member is
   * not a member.
   */
  private async restoreRoles(regimentId: string, discordUserId: string): Promise<void> {
    const member = await this.members.findOne({
      where: { regimentId, discordIdentity: { discordUserId } },
      relations: { discordIdentity: true },
    });
    if (!member) return;

    if (member.bannedAt) {
      this.logger.warn(`Returning member ${discordUserId} is BANNED — restoring the Ban role only`);
      await this.sync.enqueueMemberBanRole(regimentId, discordUserId, 'Rejoined while banned');
      return;
    }
    if (member.suspendedUntil && member.suspendedUntil.getTime() > Date.now()) {
      this.logger.log(`Returning member ${discordUserId} is suspended — no roles restored`);
      return;
    }

    this.logger.log(`Restoring Discord roles for returning member ${discordUserId}`);
    await this.sync.enqueueRoleSync(regimentId, member.id, discordUserId);
  }

  /** True when this user was already onboarded inside {@link ONBOARD_DEDUPE_MS}. */
  private recentlyOnboarded(discordUserId: string): boolean {
    const now = Date.now();
    const last = this.onboardedAt.get(discordUserId);
    if (last !== undefined && now - last < ONBOARD_DEDUPE_MS) return true;
    // Opportunistically drop entries that can no longer suppress anything, so a
    // long-lived process does not keep one per user who has ever joined.
    for (const [key, at] of this.onboardedAt) {
      if (now - at >= ONBOARD_DEDUPE_MS) this.onboardedAt.delete(key);
    }
    return false;
  }

  /** THE regiment (single-tenant): the oldest non-dissolved row. */
  private async resolveRegimentId(): Promise<string | null> {
    const [regiment] = await this.regiments.find({ order: { createdAt: 'ASC' }, take: 1 });
    return regiment?.id ?? null;
  }
}
