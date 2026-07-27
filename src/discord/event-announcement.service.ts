import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { RsvpStatus } from '../common/enums';
import { EventAnnouncement } from '../events/entities/event-announcement.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { Member } from '../members/entities/member.entity';
import { EventRsvpRoster, EventSummary } from './embeds/notification-embeds';

/** One RSVP as the roster needs it: the choice, plus who made it. */
interface RosterRow {
  status: RsvpStatus;
  inGameName: string;
  discordUserId: string | null;
}

/**
 * The live state of an event's Discord announcement (T-0205): what the embed
 * should say RIGHT NOW, and where the message that says it lives.
 *
 * ── WHY THIS SITS IN THE DISCORD MODULE, READING EVENTS TABLES ──────────────
 * Since T-0173..T-0175 this module owns both "what a notification says" and
 * "what it needs to say it" — which is why {@link DiscordSyncService} already
 * reads members, ranks and regiments. The event announcement pushes that
 * further only in degree: it is the first notification that is RE-RENDERED, so
 * its inputs have to be re-read at drain time rather than frozen at enqueue.
 *
 * Putting the reader here (rather than exposing it from EventsService) is what
 * keeps the module graph a DAG. EventsModule already imports DiscordModule; the
 * reverse import would close a cycle, and Nest resolves those badly. Entity
 * classes are plain files, so reading `event_rsvps` costs no module edge.
 *
 * Everything here is READ-ONLY on the events aggregate. The one thing it
 * writes is the announcement's own delivery record, which nothing outside the
 * bot owns.
 */
@Injectable()
export class EventAnnouncementService {
  constructor(
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventAnnouncement)
    private readonly announcements: Repository<EventAnnouncement>,
  ) {}

  /**
   * The event, scoped to the regiment and excluding rows that must never be
   * announced (soft-deleted, draft, archived). Null means "say nothing" — every
   * caller treats that as a silent no-op, because an event deleted between
   * enqueue and drain is not an error.
   */
  loadEvent(regimentId: string, eventId: string): Promise<RegimentEvent | null> {
    return this.events.findOne({
      where: { id: eventId, regimentId, isDraft: false, isArchived: false },
    });
  }

  /**
   * Project an event onto what a notification needs.
   *
   * ⚠️ SECURITY: `serverPassword` is NOT projected, and {@link EventSummary} has
   * no field that could carry it. An event-announcement channel is readable by
   * the entire guild, while the password is deliberately gated behind an RSVP in
   * the app — so the announcement must not be the thing that hands it out.
   * Keeping the omission structural (rather than "remember not to add it") is
   * what makes that guarantee hold as this projection grows.
   *
   * The event's OWN timezone travels with the summary so the composer can render
   * a wall clock the attendees recognise; nothing here reads the process locale.
   */
  async summaryFor(event: RegimentEvent): Promise<EventSummary> {
    return {
      title: event.title,
      description: event.description,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt ? event.endsAt.toISOString() : null,
      timezone: event.timezone,
      bannerUrl: event.bannerUrl,
      eventType: eventTypeLabel(event),
      roster: await this.rosterFor(event.id),
    };
  }

  /**
   * The three RSVP sections, as display labels.
   *
   * A member with a linked Discord identity is rendered as a `<@id>` mention:
   * it shows their guild identity rather than a name they typed, and it cannot
   * notify anyone, because Discord does not resolve mentions inside an embed.
   * Everyone else falls back to their in-game name. Ordered by that name so a
   * re-render after a button press does not reshuffle the list under readers.
   *
   * `neutral` RSVPs are dropped: the button set never produces one, and a member
   * who cleared their answer on the website should read as having no answer.
   */
  async rosterFor(eventId: string): Promise<EventRsvpRoster> {
    const rows = await this.rsvps
      .createQueryBuilder('rsvp')
      // INNER JOIN, so an RSVP whose member row was soft-deleted disappears from
      // the roster rather than rendering as a nameless entry.
      .innerJoin(Member, 'member', 'member.id = rsvp.memberId AND member.deletedAt IS NULL')
      .leftJoin(DiscordIdentity, 'identity', 'identity.id = member.discordIdentityId')
      .select('rsvp.status', 'status')
      .addSelect('member.inGameName', 'inGameName')
      .addSelect('identity.discordUserId', 'discordUserId')
      .where('rsvp.eventId = :eventId', { eventId })
      .orderBy('member.inGameName', 'ASC')
      .getRawMany<RosterRow>();

    const roster: EventRsvpRoster = { attending: [], tentative: [], declined: [] };
    for (const row of rows) {
      const label = row.discordUserId ? `<@${row.discordUserId}>` : row.inGameName;
      if (row.status === RsvpStatus.Interested) roster.attending.push(label);
      else if (row.status === RsvpStatus.Tentative) roster.tentative.push(label);
      else if (row.status === RsvpStatus.Declined) roster.declined.push(label);
    }
    return roster;
  }

  /**
   * The Discord accounts to ping when the event is about to start: everyone who
   * said Attending or Tentative.
   *
   * ⚠️ DECLINED IS EXCLUDED BY CONSTRUCTION, not by a filter downstream. Someone
   * who took the trouble to say they are not coming has opted out of exactly
   * this notification, and pinging them anyway is the fastest way to make the
   * whole feature something the regiment mutes.
   *
   * Members with no linked identity are absent — there is nobody to ping — and
   * ids are de-duplicated so a shared identity cannot be pinged twice.
   */
  async pingTargets(eventId: string): Promise<string[]> {
    const rows = await this.rsvps
      .createQueryBuilder('rsvp')
      .innerJoin(Member, 'member', 'member.id = rsvp.memberId AND member.deletedAt IS NULL')
      .innerJoin(DiscordIdentity, 'identity', 'identity.id = member.discordIdentityId')
      .select('DISTINCT identity.discordUserId', 'discordUserId')
      .where('rsvp.eventId = :eventId', { eventId })
      .andWhere('rsvp.status IN (:...coming)', {
        coming: [RsvpStatus.Interested, RsvpStatus.Tentative],
      })
      .getRawMany<{ discordUserId: string }>();
    return rows.map((row) => row.discordUserId);
  }

  /** Where this event's announcement landed, or null if it was never posted. */
  findDelivery(eventId: string): Promise<EventAnnouncement | null> {
    return this.announcements.findOne({ where: { eventId } });
  }

  /**
   * Record where the announcement landed, so later RSVPs re-render THAT message
   * instead of posting a second one.
   *
   * An upsert rather than an insert: a re-announce (the same event posted again
   * after the first message was deleted in Discord) must repoint the record at
   * the live message, not collide with the old one.
   */
  async recordDelivery(eventId: string, channelId: string, messageId: string): Promise<void> {
    await this.announcements.upsert(
      { eventId, channelId, messageId, threadId: null, closedAt: null },
      ['eventId'],
    );
  }

  /** Remember the pre-event thread, which is also the guard against a second one. */
  async recordThread(eventId: string, threadId: string): Promise<void> {
    await this.announcements.update({ eventId }, { threadId });
  }

  /** Stamp an announcement as retired, so the close sweep stops revisiting it. */
  async markClosed(eventId: string, at: Date = new Date()): Promise<void> {
    await this.announcements.update({ eventId }, { closedAt: at });
  }
}

/** `One-off` / `Recurring (weekly)` / `Recurring occurrence` — the embed's Type field. */
export function eventTypeLabel(event: RegimentEvent): string {
  if (event.recurrenceTemplateId) return 'Recurring occurrence';
  if (event.isRecurring && event.recurrenceCadence) return `Recurring (${event.recurrenceCadence})`;
  if (event.isRecurring) return 'Recurring';
  return 'One-off';
}
