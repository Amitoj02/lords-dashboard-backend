import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Member } from './entities/member.entity';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * Roster module. Registers the repositories the service reads from (members and
 * the joined rank/identity, plus events + attendees for the attendance metrics).
 * AuditService is provided globally by AuditModule, so it is not imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Member, Rank, DiscordIdentity, EventAttendee, RegimentEvent]),
  ],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
