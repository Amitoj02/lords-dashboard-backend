import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';
import { Member } from './entities/member.entity';
import { ServiceRecordEntry } from './entities/service-record-entry.entity';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * Roster module. Registers the repositories the service reads from/writes to:
 * members + joined rank/identity, events + attendees (attendance metrics),
 * medals + member_medals (award/remove + medal display), service-record and
 * account-deletion (admin actions + GDPR), and the regiment (owner guard).
 * AuditService is provided globally by AuditModule, so it is not imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Member,
      Rank,
      DiscordIdentity,
      EventAttendee,
      RegimentEvent,
      Medal,
      MemberMedal,
      ServiceRecordEntry,
      AccountDeletionRequest,
      Regiment,
    ]),
  ],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
