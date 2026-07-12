import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordGateway } from './gateway/discord-gateway';

/**
 * Guild-join onboarding. On GuildMemberAdd the bot sends a welcome and assigns
 * the Guest join-role — nothing else (the owner decided the bot has NO slash
 * commands; members use the webapp). Both actions go through the outbox, so a
 * flood of joins is rate-limited and failures are retried/surfaced. The real
 * gateway wires this to discord.js events; the mock exposes simulateMemberJoin
 * so the flow is testable with no bot.
 */
@Injectable()
export class DiscordOnboardingService implements OnModuleInit {
  private readonly logger = new Logger(DiscordOnboardingService.name);

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
      const regimentId = await this.resolveRegimentId();
      if (!regimentId) return;
      await this.sync.enqueueWelcome(regimentId, discordUserId);
      await this.sync.enqueueJoinRole(regimentId, discordUserId);
    } catch (error) {
      this.logger.error(`Onboarding for ${discordUserId} failed: ${(error as Error).message}`);
    }
  }

  /** THE regiment (single-tenant): the oldest non-dissolved row. */
  private async resolveRegimentId(): Promise<string | null> {
    const [regiment] = await this.regiments.find({ order: { createdAt: 'ASC' }, take: 1 });
    return regiment?.id ?? null;
  }
}
