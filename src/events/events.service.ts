import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuthzService } from '../authz/authz.service';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability, EventStatus, Platform, RsvpStatus, StorageTarget } from '../common/enums';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { StorageService } from '../storage/storage.service';
import { AttendeeDto } from './dto/attendee.dto';
import { CompleteEventDto } from './dto/complete-event.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EventDto, MyRsvpDto, RsvpCountsDto } from './dto/event.dto';
import { EventQueryDto } from './dto/event-query.dto';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { RevealedPasswordDto } from './dto/revealed-password.dto';
import { RsvpDto } from './dto/rsvp.dto';
import { RsvpRosterEntryDto } from './dto/rsvp-roster-entry.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventAttendee } from './entities/event-attendee.entity';
import { EventNotifyOffset } from './entities/event-notify-offset.entity';
import { EventPlatform } from './entities/event-platform.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventTag } from './entities/event-tag.entity';
import { RegimentEvent } from './entities/event.entity';

/** New arrays of child rows to REPLACE on an event (undefined = leave untouched). */
interface ChildCollections {
  platforms?: Platform[];
  tags?: string[];
  notifyOffsets?: number[];
}

/** Which projection to render + whose RSVP to reflect. */
interface SerializeOptions {
  includeServer: boolean;
  memberId?: string | null;
}

/**
 * Events domain: the public calendar, the member-facing detail/RSVP flow, the
 * capability-gated authoring/lifecycle actions, attendance tracking and the
 * sensitive server-password reveal. Every authenticated query is scoped to the
 * caller's regiment and excludes soft-deleted rows; public reads resolve the
 * single-tenant regiment from its settings row and honour `publicEvents`. Child
 * collections (platforms/tags/notify offsets) and RSVP/attendee counts are
 * batched into grouped queries to avoid per-row N+1. The server password is
 * encrypted at rest and never projected except by {@link revealPassword}.
 */
@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventAttendee)
    private readonly attendees: Repository<EventAttendee>,
    @InjectRepository(EventPlatform)
    private readonly platforms: Repository<EventPlatform>,
    @InjectRepository(EventTag)
    private readonly tags: Repository<EventTag>,
    @InjectRepository(EventNotifyOffset)
    private readonly notifyOffsets: Repository<EventNotifyOffset>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
    private readonly dataSource: DataSource,
    // AuditService is global; used by every mutation below.
    private readonly audit: AuditService,
    // Best-effort: announce a newly published event to the event-announcements
    // channel (T-0044). No-ops when the bot is off or no channel is set.
    private readonly discordSync: DiscordSyncService,
    // Resolves an uploaded banner key to a public URL (namespace-validated).
    private readonly storage: StorageService,
    // Capability checks — archived events are visible only to ManageEvents holders.
    private readonly authz: AuthzService,
  ) {}

  // ── Public reads (no authenticated caller) ───────────────────────────────────

  /**
   * The public calendar: published (non-draft, non-archived, non-deleted) events
   * for the single-tenant regiment, ordered by start time. Honours the
   * `publicEvents` privacy flag (403 when off). Server binding is redacted.
   */
  async listPublic(query: EventQueryDto): Promise<PaginatedResponseDto<EventDto>> {
    const regimentId = await this.resolvePublicRegimentId();

    const qb = this.events
      .createQueryBuilder('event')
      .where('event.regimentId = :regimentId', { regimentId })
      .andWhere('event.isDraft = :isDraft', { isDraft: false })
      .andWhere('event.isArchived = :isArchived', { isArchived: false });

    if (query.status) {
      qb.andWhere('event.status = :status', { status: query.status });
    }

    const [rows, total] = await qb
      .orderBy('event.startsAt', 'ASC')
      .skip(query.skip)
      .take(query.limit)
      .getManyAndCount();

    const data = await this.serialize(rows, { includeServer: false });
    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /** A single published event, public view (404 for drafts/archived/deleted/missing). */
  async getPublic(id: string): Promise<EventDto> {
    const regimentId = await this.resolvePublicRegimentId();
    // isArchived is excluded here to match listPublic — an archived event is
    // hidden from the public calendar, so a direct fetch by id must 404 too.
    const event = await this.events.findOne({
      where: { id, regimentId, isDraft: false, isArchived: false },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return this.serializeOne(event, { includeServer: false });
  }

  // ── Authenticated member reads (JWT; member projection with myRsvp) ──────────

  /**
   * The member-facing calendar: every published (non-draft, non-archived) event
   * in the caller's regiment, ordered by start time. Enrolled members get the
   * member projection (server binding + their own RSVP); an authenticated but
   * non-enrolled caller (no memberId) gets the same redacted projection a public
   * caller would. The server password is never included (only the reveal
   * endpoint returns it). Unlike the public calendar this ignores `publicEvents`
   * — members always see their own regiment's events.
   */
  async listForMember(
    user: AuthenticatedUser,
    query: EventQueryDto,
  ): Promise<PaginatedResponseDto<EventDto>> {
    const qb = this.events
      .createQueryBuilder('event')
      .where('event.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('event.isDraft = :isDraft', { isDraft: false });

    // Archived events are included only when explicitly requested AND the caller
    // holds ManageEvents; every other caller sees active events only (T-0098).
    const includeArchived =
      query.archived === true &&
      (await this.authz.can(user.regimentId, user.role, Capability.ManageEvents));
    if (!includeArchived) {
      qb.andWhere('event.isArchived = :isArchived', { isArchived: false });
    }

    if (query.status) {
      qb.andWhere('event.status = :status', { status: query.status });
    }

    const [rows, total] = await qb
      .orderBy('event.startsAt', 'ASC')
      .skip(query.skip)
      .take(query.limit)
      .getManyAndCount();

    const includeServer = !!user.memberId;
    const data = await this.serialize(rows, { includeServer, memberId: user.memberId });
    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /**
   * A single event in the caller's regiment, member projection (404 when hidden
   * or missing). Enrolled members get the server binding + their own RSVP; a
   * non-enrolled authenticated caller gets the redacted projection.
   */
  async getForMember(user: AuthenticatedUser, id: string): Promise<EventDto> {
    const event = await this.events.findOne({
      where: { id, regimentId: user.regimentId, isDraft: false },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    // An archived event's detail is deep-linkable/fetchable only by a ManageEvents
    // holder (so the Unarchive control works); everyone else gets a 404 (T-0097).
    if (event.isArchived) {
      const canManage = await this.authz.can(user.regimentId, user.role, Capability.ManageEvents);
      if (!canManage) {
        throw new NotFoundException('Event not found');
      }
    }
    const includeServer = !!user.memberId;
    return this.serializeOne(event, { includeServer, memberId: user.memberId });
  }

  // ── Per-member reads (profile Event History / RSVPs tabs, T-0100) ────────────

  /**
   * Every event the given member has attended (via the attendee join), for the
   * profile Event History tab. Regiment-scoped, soft-deleted rows excluded,
   * most recent first. Uses the public (server-redacted) projection — a history
   * list never needs the server binding.
   */
  async listAttendedByMember(user: AuthenticatedUser, memberId: string): Promise<EventDto[]> {
    const rows = await this.attendees
      .createQueryBuilder('attendee')
      .innerJoinAndSelect('attendee.event', 'event')
      .where('attendee.memberId = :memberId', { memberId })
      .andWhere('event.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('event.deletedAt IS NULL')
      .orderBy('event.startsAt', 'DESC')
      .getMany();
    const events = rows.map((r) => r.event).filter((e): e is RegimentEvent => !!e);
    return this.serialize(events, { includeServer: false });
  }

  /**
   * Every event the given member has RSVP'd to, with THEIR OWN RSVP reflected on
   * each row (profile RSVPs tab). Regiment-scoped, soft-deleted rows excluded,
   * most recent first. Public projection otherwise (no server binding).
   */
  async listRsvpsByMember(user: AuthenticatedUser, memberId: string): Promise<EventDto[]> {
    const rows = await this.rsvps
      .createQueryBuilder('rsvp')
      .innerJoinAndSelect('rsvp.event', 'event')
      .where('rsvp.memberId = :memberId', { memberId })
      .andWhere('event.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('event.deletedAt IS NULL')
      .orderBy('event.startsAt', 'DESC')
      .getMany();
    const events = rows.map((r) => r.event).filter((e): e is RegimentEvent => !!e);
    const dtos = await this.serialize(events, { includeServer: false });
    // Reflect the member's own RSVP on each row (this is a view of THEIR RSVPs).
    const rsvpByEvent = new Map(rows.map((r) => [r.eventId, r]));
    for (const dto of dtos) {
      const r = rsvpByEvent.get(dto.id);
      dto.myRsvp = r ? { status: r.status, reminderOffsetMinutes: r.reminderOffsetMinutes } : null;
    }
    return dtos;
  }

  // ── Authoring + lifecycle (ManageEvents) ─────────────────────────────────────

  /**
   * Create an event with its child collections in one transaction. `timezone`
   * and `notifyOffsets` fall back to the regiment settings; `isDraft` defaults
   * to false. New events always start `upcoming` (the scheduler advances them).
   */
  async create(user: AuthenticatedUser, dto: CreateEventDto, ip: string | null): Promise<EventDto> {
    const settings = await this.settings.findOne({ where: { regimentId: user.regimentId } });
    const timezone = dto.timezone ?? settings?.eventDefaultTimezone ?? 'UTC';
    const notifyOffsets = dto.notifyOffsets ?? settings?.eventDefaultNotifyBefore ?? [];
    // A cadence turns this event into an active recurring template whose
    // occurrences the scheduler materializes (T-0074/T-0075). One-off events
    // carry no cadence and are never active.
    const cadence = dto.recurrenceCadence ?? null;

    const saved = await this.dataSource.transaction(async (manager) => {
      const eventRepo = manager.getRepository(RegimentEvent);
      const event = eventRepo.create({
        regimentId: user.regimentId,
        createdByMemberId: user.memberId,
        title: dto.title,
        description: dto.description ?? null,
        bannerUrl: dto.bannerKey
          ? this.storage.resolveKeyToPublicUrl(user, dto.bannerKey, StorageTarget.EventBanner)
          : null,
        startsAt: new Date(dto.startsAt),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        timezone,
        isRecurring: cadence !== null ? true : (dto.isRecurring ?? false),
        recurrenceRule: dto.recurrenceRule ?? null,
        recurrenceCadence: cadence,
        recurrenceActive: cadence !== null,
        recurrenceTemplateId: null,
        serverName: dto.serverName ?? null,
        serverPassword: dto.serverPassword ?? null,
        serverRegion: dto.serverRegion ?? null,
        status: EventStatus.Upcoming,
        expectedAttendance: dto.expectedAttendance ?? null,
        attendanceGoal: dto.attendanceGoal ?? null,
        twitchUrl: dto.twitchUrl ?? null,
        // Creation always publishes directly — there is no draft state (T-0072).
        isDraft: false,
        isArchived: false,
      });
      const saved = await eventRepo.save(event);
      await this.replaceChildren(manager, saved.id, {
        platforms: dto.platforms,
        tags: dto.tags,
        notifyOffsets,
      });
      return saved;
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.create',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'event', id: saved.id, label: saved.title },
      after: this.snapshot(saved),
    });

    // Best-effort: announce the newly published event to the dedicated
    // event-announcements channel (T-0044). No-ops when the bot is disabled.
    const desc = saved.description ? `\n${saved.description}` : '';
    await this.discordSync.enqueueEventAnnounce(
      user.regimentId,
      `📅 **New event: ${saved.title}**${desc}\nStarts: ${saved.startsAt.toISOString()}`,
    );

    return this.serializeOne(saved, { includeServer: true, memberId: user.memberId });
  }

  /**
   * Update scalar fields and optionally REPLACE child collections. Any of
   * `platforms`/`tags`/`notifyOffsets` that is provided wipes and rewrites that
   * event's rows; omitted collections are left as-is. The before/after snapshot
   * of scalar fields is audited (the server password is never snapshotted).
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateEventDto,
    ip: string | null,
  ): Promise<EventDto> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    const before = this.snapshot(event);

    const saved = await this.dataSource.transaction(async (manager) => {
      const eventRepo = manager.getRepository(RegimentEvent);

      if (dto.title !== undefined) event.title = dto.title;
      if (dto.description !== undefined) event.description = dto.description ?? null;
      if (dto.bannerKey !== undefined) {
        event.bannerUrl = dto.bannerKey
          ? this.storage.resolveKeyToPublicUrl(user, dto.bannerKey, StorageTarget.EventBanner)
          : null;
      }
      if (dto.startsAt !== undefined) event.startsAt = new Date(dto.startsAt);
      if (dto.endsAt !== undefined) event.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
      if (dto.timezone !== undefined) event.timezone = dto.timezone;
      if (dto.isRecurring !== undefined) event.isRecurring = dto.isRecurring;
      if (dto.recurrenceRule !== undefined) event.recurrenceRule = dto.recurrenceRule ?? null;
      // Setting a cadence turns the row into an ACTIVE template (mirrors create,
      // so converting a one-off → recurring via PATCH actually generates);
      // clearing it drops recurrence and stops generation. An explicit
      // recurrenceActive in the same request still wins (applied just below).
      if (dto.recurrenceCadence !== undefined) {
        event.recurrenceCadence = dto.recurrenceCadence ?? null;
        if (dto.recurrenceCadence != null) {
          event.isRecurring = true;
          event.recurrenceActive = true;
        } else {
          event.recurrenceActive = false;
        }
      }
      if (dto.recurrenceActive !== undefined) event.recurrenceActive = dto.recurrenceActive;
      if (dto.serverName !== undefined) event.serverName = dto.serverName ?? null;
      // Written as plaintext; the column transformer encrypts it at rest.
      if (dto.serverPassword !== undefined) event.serverPassword = dto.serverPassword ?? null;
      if (dto.serverRegion !== undefined) event.serverRegion = dto.serverRegion ?? null;
      if (dto.expectedAttendance !== undefined)
        event.expectedAttendance = dto.expectedAttendance ?? null;
      if (dto.attendanceGoal !== undefined) event.attendanceGoal = dto.attendanceGoal ?? null;
      if (dto.twitchUrl !== undefined) event.twitchUrl = dto.twitchUrl ?? null;

      const saved = await eventRepo.save(event);
      await this.replaceChildren(manager, saved.id, {
        platforms: dto.platforms,
        tags: dto.tags,
        notifyOffsets: dto.notifyOffsets,
      });
      return saved;
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'event', id: saved.id, label: saved.title },
      before,
      after: this.snapshot(saved),
    });

    return this.serializeOne(saved, { includeServer: true, memberId: user.memberId });
  }

  /** Archive an event (isArchived=true) — hides it from the public calendar. */
  async archive(user: AuthenticatedUser, id: string, ip: string | null): Promise<EventDto> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    event.isArchived = true;
    const saved = await this.events.save(event);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.archive',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'event', id: saved.id, label: saved.title },
    });

    return this.serializeOne(saved, { includeServer: true, memberId: user.memberId });
  }

  /** Unarchive an event (isArchived=false) — restores it to the public calendar. */
  async unarchive(user: AuthenticatedUser, id: string, ip: string | null): Promise<EventDto> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    event.isArchived = false;
    const saved = await this.events.save(event);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.unarchive',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'event', id: saved.id, label: saved.title },
    });

    return this.serializeOne(saved, { includeServer: true, memberId: user.memberId });
  }

  /**
   * Close an event out: status → previous, stamping `startedAt`/`endsAt` (only
   * when not already set) and recording the outcome + final in-line count.
   */
  async complete(
    user: AuthenticatedUser,
    id: string,
    dto: CompleteEventDto,
    ip: string | null,
  ): Promise<EventDto> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    const before = this.snapshot(event);

    const now = new Date();
    event.status = EventStatus.Previous;
    event.startedAt = event.startedAt ?? now;
    event.endsAt = event.endsAt ?? now;
    if (dto.outcome !== undefined) event.outcome = dto.outcome ?? null;
    if (dto.inLineCount !== undefined) event.inLineCount = dto.inLineCount ?? null;
    const saved = await this.events.save(event);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.completed',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'event', id: saved.id, label: saved.title },
      before,
      after: this.snapshot(saved),
    });

    return this.serializeOne(saved, { includeServer: true, memberId: user.memberId });
  }

  /** Soft-delete an event (children cascade-delete at the DB level on hard delete). */
  async remove(user: AuthenticatedUser, id: string, ip: string | null): Promise<void> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    const target = { type: 'event', id: event.id, label: event.title };
    const before = this.snapshot(event);
    await this.events.softRemove(event);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.delete',
      actor: AuditService.actorFromUser(user, ip),
      target,
      before,
    });
  }

  /**
   * Soft-delete a whole recurring series: the recurrence template and every
   * occurrence sharing it, in one transaction. Accepts either the template id
   * or the id of any of its generated occurrences. Soft-deleting the template
   * row is what halts future generation (the recurrence scheduler skips
   * soft-deleted templates). One-off (non-recurring) events are rejected.
   */
  async removeSeries(user: AuthenticatedUser, id: string, ip: string | null): Promise<void> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });

    let templateId: string;
    if (event.recurrenceTemplateId != null) {
      templateId = event.recurrenceTemplateId; // an occurrence → resolve to its template
    } else if (event.recurrenceCadence != null) {
      templateId = event.id; // the template itself (a stopped template still has a cadence)
    } else {
      throw new BadRequestException('Event is not part of a recurring series');
    }

    const target = { type: 'event', id: templateId, label: event.title };

    await this.dataSource.transaction(async (manager) => {
      const eventRepo = manager.getRepository(RegimentEvent);
      // The template row (regiment-scoped) …
      await eventRepo.softDelete({ id: templateId, regimentId: user.regimentId });
      // … plus every occurrence that points at it.
      await eventRepo.softDelete({ recurrenceTemplateId: templateId, regimentId: user.regimentId });
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'event.delete-series',
      actor: AuditService.actorFromUser(user, ip),
      target,
    });
  }

  // ── RSVP (RsvpToEvents) ──────────────────────────────────────────────────────

  /** Upsert the caller's RSVP and return the event with that RSVP reflected. */
  async rsvp(user: AuthenticatedUser, id: string, dto: RsvpDto): Promise<EventDto> {
    if (!user.memberId) {
      throw new ForbiddenException('Only enrolled members can RSVP');
    }
    const event = await this.loadEvent(id, user.regimentId);

    let rsvp = await this.rsvps.findOne({ where: { eventId: event.id, memberId: user.memberId } });
    if (rsvp) {
      rsvp.status = dto.status;
      rsvp.reminderOffsetMinutes = dto.reminderOffsetMinutes ?? null;
      rsvp.respondedAt = new Date();
    } else {
      rsvp = this.rsvps.create({
        eventId: event.id,
        memberId: user.memberId,
        status: dto.status,
        reminderOffsetMinutes: dto.reminderOffsetMinutes ?? null,
        respondedAt: new Date(),
      });
    }
    await this.rsvps.save(rsvp);

    return this.serializeOne(event, { includeServer: true, memberId: user.memberId });
  }

  /** Remove the caller's RSVP (idempotent — a no-op when none exists). */
  async removeRsvp(user: AuthenticatedUser, id: string): Promise<void> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    if (user.memberId) {
      await this.rsvps.delete({ eventId: event.id, memberId: user.memberId });
    }
  }

  // ── Attendance ───────────────────────────────────────────────────────────────

  /** The confirmed attendee list for an event (ViewMembersDirectory). */
  async listAttendees(user: AuthenticatedUser, id: string): Promise<AttendeeDto[]> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    return this.attendeeListFor(event.id);
  }

  /**
   * The RSVP roster for an event (T-0127): everyone who has RSVP'd, with their
   * name, avatar and choice. Gated on ViewMembersDirectory (same audience as the
   * attendee list) because it surfaces member identities. Members who never
   * RSVP'd are naturally absent (there is no row for them). Ordered by name.
   */
  async listRsvpRoster(user: AuthenticatedUser, id: string): Promise<RsvpRosterEntryDto[]> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    const rows = await this.rsvps.find({
      where: { eventId: event.id },
      // Nested identity so the avatar can fall back to the linked Discord avatar.
      relations: { member: { discordIdentity: true } },
    });
    return rows
      .map((rsvp) => RsvpRosterEntryDto.from(rsvp))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }

  /**
   * Idempotently check members in as attendees (ManageEvents). Every member id is
   * validated to belong to the caller's regiment; unknown ids are rejected. Ids
   * that are already checked in keep their original timestamp.
   */
  async addAttendees(
    user: AuthenticatedUser,
    id: string,
    dto: MarkAttendanceDto,
  ): Promise<AttendeeDto[]> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });

    const requestedIds = [...new Set(dto.memberIds)];
    const members = await this.members.find({
      where: { id: In(requestedIds), regimentId: user.regimentId },
    });
    const validIds = new Set(members.map((m) => m.id));
    const invalid = requestedIds.filter((memberId) => !validIds.has(memberId));
    if (invalid.length > 0) {
      throw new BadRequestException(`Members not in this regiment: ${invalid.join(', ')}`);
    }

    const existing = await this.attendees.find({
      where: { eventId: event.id, memberId: In([...validIds]) },
    });
    const existingIds = new Set(existing.map((a) => a.memberId));
    const toInsert = [...validIds].filter((memberId) => !existingIds.has(memberId));
    if (toInsert.length > 0) {
      const now = new Date();
      await this.attendees.insert(
        toInsert.map((memberId) => ({ eventId: event.id, memberId, checkedInAt: now })),
      );
    }

    return this.attendeeListFor(event.id);
  }

  /** Remove one attendee (ManageEvents; idempotent). */
  async removeAttendee(user: AuthenticatedUser, id: string, memberId: string): Promise<void> {
    const event = await this.loadEvent(id, user.regimentId, { withDrafts: true });
    await this.attendees.delete({ eventId: event.id, memberId });
  }

  // ── Sensitive: server-password reveal (RevealEventPasswords) ─────────────────

  /**
   * Reveal the decrypted server password. SENSITIVE and double-gated: beyond the
   * RevealEventPasswords capability, the caller must have an RSVP to the event
   * that is not `declined`. 404 when no password is set. Reveals are NOT audited
   * (T-0126) — legitimate members reveal on every session, so the reveal event
   * added noise without moderation value; the historical `event.password.reveal`
   * rows still render, but no new ones are written.
   */
  async revealPassword(user: AuthenticatedUser, id: string): Promise<RevealedPasswordDto> {
    const event = await this.loadEvent(id, user.regimentId);

    const rsvp = user.memberId
      ? await this.rsvps.findOne({ where: { eventId: event.id, memberId: user.memberId } })
      : null;
    if (!rsvp || rsvp.status === RsvpStatus.Declined) {
      throw new ForbiddenException('RSVP required to reveal the server password');
    }

    if (event.serverPassword === null || event.serverPassword === undefined) {
      throw new NotFoundException('No server password set');
    }

    return RevealedPasswordDto.from(event);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve the single-tenant regiment id from its settings row and enforce the
   * public visibility gate. Blocks (403) only when a settings row exists and
   * `publicEvents` is off; 404 when the regiment is not configured at all.
   */
  private async resolvePublicRegimentId(): Promise<string> {
    const [settings] = await this.settings.find({ take: 1 });
    if (!settings) {
      throw new NotFoundException('Regiment not found');
    }
    if (settings.publicEvents === false) {
      throw new ForbiddenException('Events are private');
    }
    return settings.regimentId;
  }

  /** Load a regiment-scoped, non-deleted event (drafts excluded unless asked). */
  private async loadEvent(
    id: string,
    regimentId: string,
    opts: { withDrafts?: boolean } = {},
  ): Promise<RegimentEvent> {
    const where: FindOptionsWhere<RegimentEvent> = { id, regimentId };
    if (!opts.withDrafts) {
      where.isDraft = false;
    }
    const event = await this.events.findOne({ where });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  /**
   * Replace an event's child rows in a transaction. Only the collections that are
   * provided (not undefined) are wiped and rewritten; each is de-duplicated to
   * respect the junctions' composite primary keys.
   */
  private async replaceChildren(
    manager: EntityManager,
    eventId: string,
    data: ChildCollections,
  ): Promise<void> {
    if (data.platforms !== undefined) {
      const repo = manager.getRepository(EventPlatform);
      await repo.delete({ eventId });
      const unique = [...new Set(data.platforms)];
      if (unique.length > 0) {
        await repo.insert(unique.map((platform) => ({ eventId, platform })));
      }
    }
    if (data.tags !== undefined) {
      const repo = manager.getRepository(EventTag);
      await repo.delete({ eventId });
      const unique = [...new Set(data.tags)];
      if (unique.length > 0) {
        await repo.insert(unique.map((tag) => ({ eventId, tag })));
      }
    }
    if (data.notifyOffsets !== undefined) {
      const repo = manager.getRepository(EventNotifyOffset);
      await repo.delete({ eventId });
      const unique = [...new Set(data.notifyOffsets)];
      if (unique.length > 0) {
        await repo.insert(unique.map((minutes) => ({ eventId, minutes })));
      }
    }
  }

  /** Project a page of events, batching every child collection + count query. */
  private async serialize(events: RegimentEvent[], opts: SerializeOptions): Promise<EventDto[]> {
    if (events.length === 0) return [];
    const ids = events.map((e) => e.id);

    const [platforms, tags, rsvpCounts, attendeeCounts] = await Promise.all([
      this.platformsFor(ids),
      this.tagsFor(ids),
      this.rsvpCountsFor(ids),
      this.attendeeCountsFor(ids),
    ]);
    const notifyOffsets = opts.includeServer
      ? await this.notifyOffsetsFor(ids)
      : new Map<string, number[]>();
    const myRsvps = opts.memberId
      ? await this.myRsvpsFor(ids, opts.memberId)
      : new Map<string, MyRsvpDto>();

    return events.map((event) =>
      EventDto.from(event, {
        platforms: platforms.get(event.id) ?? [],
        tags: tags.get(event.id) ?? [],
        rsvpCounts: rsvpCounts.get(event.id) ?? this.emptyRsvpCounts(),
        attendeesCount: attendeeCounts.get(event.id) ?? 0,
        notifyOffsets: notifyOffsets.get(event.id) ?? [],
        includeServer: opts.includeServer,
        myRsvp: myRsvps.get(event.id) ?? null,
      }),
    );
  }

  /** Project a single event (thin wrapper over {@link serialize}). */
  private async serializeOne(event: RegimentEvent, opts: SerializeOptions): Promise<EventDto> {
    const [dto] = await this.serialize([event], opts);
    return dto;
  }

  /** The attendee list for one event, joined to member display names. */
  private async attendeeListFor(eventId: string): Promise<AttendeeDto[]> {
    const rows = await this.attendees.find({ where: { eventId } });
    const memberIds = rows.map((r) => r.memberId);
    const members = memberIds.length
      ? await this.members.find({ where: { id: In(memberIds) } })
      : [];
    const nameById = new Map(members.map((m) => [m.id, m.inGameName]));
    return rows
      .map((row) => AttendeeDto.from(row, nameById.get(row.memberId) ?? null))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }

  /** One query → eventId → its platforms. */
  private async platformsFor(eventIds: string[]): Promise<Map<string, Platform[]>> {
    const map = new Map<string, Platform[]>();
    if (eventIds.length === 0) return map;
    const rows = await this.platforms.find({ where: { eventId: In(eventIds) } });
    for (const row of rows) {
      const list = map.get(row.eventId) ?? [];
      list.push(row.platform);
      map.set(row.eventId, list);
    }
    return map;
  }

  /** One query → eventId → its tags. */
  private async tagsFor(eventIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (eventIds.length === 0) return map;
    const rows = await this.tags.find({ where: { eventId: In(eventIds) } });
    for (const row of rows) {
      const list = map.get(row.eventId) ?? [];
      list.push(row.tag);
      map.set(row.eventId, list);
    }
    return map;
  }

  /** One query → eventId → its notify offsets (minutes). */
  private async notifyOffsetsFor(eventIds: string[]): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (eventIds.length === 0) return map;
    const rows = await this.notifyOffsets.find({ where: { eventId: In(eventIds) } });
    for (const row of rows) {
      const list = map.get(row.eventId) ?? [];
      list.push(row.minutes);
      map.set(row.eventId, list);
    }
    return map;
  }

  /** One grouped query → eventId → RSVP tallies by status (zero-filled). */
  private async rsvpCountsFor(eventIds: string[]): Promise<Map<string, RsvpCountsDto>> {
    const map = new Map<string, RsvpCountsDto>();
    if (eventIds.length === 0) return map;
    for (const id of eventIds) {
      map.set(id, this.emptyRsvpCounts());
    }

    const rows = await this.rsvps
      .createQueryBuilder('rsvp')
      .select('rsvp.eventId', 'eventId')
      .addSelect('rsvp.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('rsvp.eventId IN (:...eventIds)', { eventIds })
      .groupBy('rsvp.eventId')
      .addGroupBy('rsvp.status')
      .getRawMany<{ eventId: string; status: RsvpStatus; count: string }>();

    for (const row of rows) {
      const counts = map.get(row.eventId);
      if (counts) {
        // RsvpStatus values match RsvpCountsDto's keys exactly.
        counts[row.status as keyof RsvpCountsDto] = Number(row.count);
      }
    }
    return map;
  }

  /** One grouped query → eventId → confirmed attendee count. */
  private async attendeeCountsFor(eventIds: string[]): Promise<Map<string, number>> {
    if (eventIds.length === 0) return new Map();
    const rows = await this.attendees
      .createQueryBuilder('attendee')
      .select('attendee.eventId', 'eventId')
      .addSelect('COUNT(*)', 'count')
      .where('attendee.eventId IN (:...eventIds)', { eventIds })
      .groupBy('attendee.eventId')
      .getRawMany<{ eventId: string; count: string }>();
    return new Map(rows.map((r) => [r.eventId, Number(r.count)]));
  }

  /** One query → eventId → the given member's RSVP (for the member view). */
  private async myRsvpsFor(eventIds: string[], memberId: string): Promise<Map<string, MyRsvpDto>> {
    const map = new Map<string, MyRsvpDto>();
    if (eventIds.length === 0) return map;
    const rows = await this.rsvps.find({ where: { eventId: In(eventIds), memberId } });
    for (const row of rows) {
      map.set(row.eventId, {
        status: row.status,
        reminderOffsetMinutes: row.reminderOffsetMinutes,
      });
    }
    return map;
  }

  /** A zero-filled RSVP tally. */
  private emptyRsvpCounts(): RsvpCountsDto {
    return { interested: 0, tentative: 0, declined: 0, neutral: 0 };
  }

  /** The audited, human-meaningful scalar fields of an event (never the password). */
  private snapshot(event: RegimentEvent): Record<string, unknown> {
    return {
      title: event.title,
      description: event.description,
      startsAt: event.startsAt ? event.startsAt.toISOString() : null,
      endsAt: event.endsAt ? event.endsAt.toISOString() : null,
      timezone: event.timezone,
      status: event.status,
      recurrenceCadence: event.recurrenceCadence,
      recurrenceActive: event.recurrenceActive,
      serverName: event.serverName,
      serverRegion: event.serverRegion,
      expectedAttendance: event.expectedAttendance,
      attendanceGoal: event.attendanceGoal,
      outcome: event.outcome,
      inLineCount: event.inLineCount,
      isDraft: event.isDraft,
      isArchived: event.isArchived,
    };
  }
}
