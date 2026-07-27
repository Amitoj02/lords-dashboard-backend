import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntry } from '../audit/entities/audit-log-entry.entity';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { AppConfig } from '../config/configuration';
import { EventAnnouncement } from '../events/entities/event-announcement.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordController } from './discord.controller';
import { DiscordOnboardingService } from './discord-onboarding.service';
import { DiscordRoleAdoptionService } from './discord-role-adoption.service';
import { DiscordRolePolicyService } from './discord-role-policy.service';
import { DiscordService } from './discord.service';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordSyncWorker } from './discord-sync.worker';
import { EventAnnouncementService } from './event-announcement.service';
import { EventRsvpInteractionService } from './event-rsvp-interaction.service';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';
import { DiscordGateway } from './gateway/discord-gateway';
import { MockDiscordGateway } from './gateway/mock-discord-gateway';
import { RealDiscordGateway } from './gateway/real-discord-gateway';

/**
 * The "Lord Adjutant" Discord bot: an outbox that syncs roles + posts
 * announcements (still NO slash commands — members use the webapp). Since
 * T-0205 it also has ONE inbound path: the RSVP buttons under an event
 * announcement, handled by {@link EventRsvpInteractionService}, which runs the
 * same authorization the HTTP route does. The in-process gateway is swapped for
 * MockDiscordGateway when `discord.botMock` is set, so the whole pipeline runs
 * with no real bot (mirrors the OAuth mock/real seam).
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
      // Event announcements are RE-RENDERED after they are posted (T-0205), so
      // the bot reads the event + its RSVP roster at drain time and owns the
      // delivery record of where each announcement landed. These are entity
      // registrations, not a module edge — EventsModule imports this one, and
      // the reverse would close a cycle.
      RegimentEvent,
      EventRsvp,
      EventAnnouncement,
      // A button press arrives as a Discord user id and has to become a member.
      DiscordIdentity,
    ]),
  ],
  controllers: [DiscordController],
  providers: [
    DiscordService,
    DiscordSyncService,
    DiscordSyncWorker,
    DiscordOnboardingService,
    DiscordRolePolicyService,
    DiscordRoleAdoptionService,
    EventAnnouncementService,
    EventRsvpInteractionService,
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
  exports: [
    DiscordSyncService,
    DiscordGateway,
    DiscordRolePolicyService,
    // ApplicationsModule reads a new member's existing guild roles on approval,
    // so an enlistment adopts the rank/medals they already wear (T-0202).
    DiscordRoleAdoptionService,
  ],
})
export class DiscordModule {}
