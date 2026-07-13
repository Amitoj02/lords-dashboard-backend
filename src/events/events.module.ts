import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordModule } from '../discord/discord.module';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { EventRecurrenceScheduler } from './event-recurrence.scheduler';
import { EventStatusScheduler } from './event-status.scheduler';
import { EventAttendee } from './entities/event-attendee.entity';
import { EventNotifyOffset } from './entities/event-notify-offset.entity';
import { EventPlatform } from './entities/event-platform.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventTag } from './entities/event-tag.entity';
import { RegimentEvent } from './entities/event.entity';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Events module. Registers the event aggregate + its child junctions (RSVPs,
 * attendees, platforms, tags, notify offsets), plus Member (attendee name
 * enrichment + regiment validation) and RegimentSettings (public-visibility gate
 * and create-time defaults). The EventStatusScheduler is provided here as a
 * background lifecycle sweep. AuditService is provided globally by AuditModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegimentEvent,
      EventRsvp,
      EventAttendee,
      EventPlatform,
      EventTag,
      EventNotifyOffset,
      Member,
      RegimentSettings,
    ]),
    // For best-effort event announcements to the event-announcements channel.
    DiscordModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, EventStatusScheduler, EventRecurrenceScheduler],
  exports: [EventsService],
})
export class EventsModule {}
