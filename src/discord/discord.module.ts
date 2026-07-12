import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntry } from '../audit/entities/audit-log-entry.entity';
import { AppConfig } from '../config/configuration';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordController } from './discord.controller';
import { DiscordOnboardingService } from './discord-onboarding.service';
import { DiscordService } from './discord.service';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordSyncWorker } from './discord-sync.worker';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';
import { DiscordGateway } from './gateway/discord-gateway';
import { MockDiscordGateway } from './gateway/mock-discord-gateway';
import { RealDiscordGateway } from './gateway/real-discord-gateway';

/**
 * The "Quartermaster" Discord bot: an outbox that syncs roles + posts
 * announcements (NO slash commands — members use the webapp). The in-process
 * gateway is swapped for MockDiscordGateway when `discord.botMock` is set, so the
 * whole pipeline runs with no real bot (mirrors the OAuth mock/real seam).
 * Exports DiscordSyncService so feature modules can enqueue syncs on
 * rank/role/medal changes and the ban→Ban-role action — without importing this
 * module's guts.
 * Also exports the DiscordGateway abstraction so AuthModule can resolve guild
 * membership from the bot at sign-in (T-0050) instead of the OAuth guilds scope.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiscordBotSettings,
      DiscordSyncJob,
      DiscordConnection,
      BotOperation,
      Member,
      Rank,
      Regiment,
      // Medal role reconciliation (award grants/revokes a linked role).
      Medal,
      MemberMedal,
      // Audit-mirror sync-status write-back (synced/failed) onto the source row.
      AuditLogEntry,
    ]),
  ],
  controllers: [DiscordController],
  providers: [
    DiscordService,
    DiscordSyncService,
    DiscordSyncWorker,
    DiscordOnboardingService,
    {
      // Swap the real discord.js gateway for the in-process mock when botMock is
      // set. Consumers depend on the DiscordGateway abstract class token, so
      // nothing downstream knows which implementation it got.
      provide: DiscordGateway,
      useFactory: (config: ConfigService<AppConfig, true>) =>
        config.get('discord', { infer: true }).botMock
          ? new MockDiscordGateway()
          : new RealDiscordGateway(config),
      inject: [ConfigService],
    },
  ],
  exports: [DiscordSyncService, DiscordGateway],
})
export class DiscordModule {}
