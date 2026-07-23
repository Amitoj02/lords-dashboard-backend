import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordGateway } from './gateway/discord-gateway';

/**
 * Minimum gap between two onboardings of the same Discord user. Discord can
 * redeliver GuildMemberAdd, and a member who leaves and re-joins in the same
 * sitting would otherwise be welcomed (and re-Guest-roled) every time — so a
 * repeat within this window is dropped (T-0169). Deliberately in-memory and
 * local: it must not depend on the stored membership verdict, because the
 * verdict writer is a SEPARATE subscriber to the same event and there is no
 * defined order between them.
 */
const ONBOARD_DEDUPE_MS = 5 * 60_000;

/**
 * Guild-join onboarding. On GuildMemberAdd the bot sends a welcome and assigns
 * the Guest join-role — nothing else (the owner decided the bot has NO slash
 * commands; members use the webapp). Both actions go through the outbox, so a
 * flood of joins is rate-limited and failures are retried/surfaced. The real
 * gateway wires this to discord.js events; the mock exposes simulateMemberJoin
 * so the flow is testable with no bot.
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
  ) {}

  onModuleInit(): void {
    this.gateway.registerMemberJoinHandler((discordUserId) => this.onMemberJoin(discordUserId));
  }

  /** Handle a member joining the guild: enqueue welcome + Guest role. Never throws. */
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
      await this.sync.enqueueJoinRole(regimentId, discordUserId);
    } catch (error) {
      this.logger.error(`Onboarding for ${discordUserId} failed: ${(error as Error).message}`);
    }
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
