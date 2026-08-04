import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { SessionContextService } from '../auth/session-context.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuthzService } from '../authz/authz.service';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { DiscordSyncService } from '../discord/discord-sync.service';
import {
  AdoptionUnavailableReason,
  DiscordRoleAdoptionService,
} from '../discord/discord-role-adoption.service';
import {
  AccountDeletionStatus,
  Capability,
  MemberRole,
  MemberStatus,
  StorageTarget,
} from '../common/enums';
import { StorageService } from '../storage/storage.service';
import { EventDto } from '../events/dto/event.dto';
import { EventsService } from '../events/events.service';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { MemberDto, MemberMedalSummary, PermittedActionsDto } from './dto/member.dto';
import { MemberQueryDto } from './dto/member-query.dto';
import {
  MEMBER_ADMIN_CAPABILITIES,
  MemberAdminAction,
  assertCanActOn,
  canGrantRole,
  permittedActions,
} from './member-hierarchy';
import {
  AwardMedalDto,
  BanMemberDto,
  ChangeRankDto,
  ChangeRoleDto,
  ConfirmDeletionDto,
  DeletionRequestDto,
  DeriveFromDiscordResultDto,
  SuspendMemberDto,
} from './dto/member-admin.dto';
import { CommandInfoDto, ServiceRecordEntryDto } from './dto/member-detail.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MemberAvatarService } from './public/member-avatar.service';
import { UsernameAvailability, UsernameService } from './username.service';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';
import { Member } from './entities/member.entity';
import { ServiceRecordEntry } from './entities/service-record-entry.entity';

/**
 * Written onto every award and service-record entry a derive creates (T-0204),
 * so nobody later mistakes a decoration inferred from a Discord role for one an
 * officer sat down and awarded. Deliberately worded like the enlistment
 * carry-over's own marker — same provenance, different moment.
 */
const DERIVED_DETAIL = 'Derived from their existing Discord roles';

/** One human sentence naming what a derive applied — audited AND shown to the admin. */
function describeDerived(name: string, rank: Rank | null, medals: Medal[]): string {
  const parts: string[] = [];
  if (rank) parts.push(`promoted to ${rank.name}`);
  // Named rather than counted: the admin pressed a button without knowing what
  // it would do, so the answer has to be specific enough to check.
  if (medals.length) parts.push(`awarded ${medals.map((medal) => medal.title).join(', ')}`);
  return `Derived from Discord: ${name} ${parts.join(' and ')}.`;
}

/**
 * Turn a failed guild read into the answer the admin gets. Each reason is a
 * different thing for them to go and do, so each gets its own sentence and its
 * own status — 409 for a state they can fix (link an account, switch the bot on),
 * 503 for a Discord that simply did not answer and may on the next press.
 */
function deriveUnavailable(reason: AdoptionUnavailableReason, name: string): HttpException {
  switch (reason) {
    case 'not-linked':
      return new ConflictException(
        `${name} has not linked a Discord account, so there are no roles to read. ` +
          'They need to sign in with Discord first.',
      );
    case 'bot-disabled':
      return new ConflictException(
        'The Discord bot is switched off for this regiment, so its roles are not being ' +
          'maintained. Enable it under Settings → Discord, then try again.',
      );
    case 'not-in-guild':
      return new ConflictException(
        `${name} is not in the regiment's Discord server, so there are no roles to read.`,
      );
    case 'unreachable':
      return new ServiceUnavailableException(
        'Could not reach Discord to read their roles. Try again in a moment.',
      );
  }
}

/**
 * Roster read/profile + admin actions. Every query is scoped to the caller's
 * regiment (single-tenant) and excludes soft-deleted rows. Derived fields —
 * rank, rank image, medals and confirmed attendance count — are computed
 * server-side; the client is never trusted for them. List lookups (attendance,
 * medals) are batched into grouped queries to avoid N+1. Every admin mutation
 * writes a service-record entry and an audit row.
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(EventAttendee)
    private readonly attendees: Repository<EventAttendee>,
    @InjectRepository(Rank)
    private readonly ranks: Repository<Rank>,
    @InjectRepository(Medal)
    private readonly medals: Repository<Medal>,
    @InjectRepository(MemberMedal)
    private readonly memberMedals: Repository<MemberMedal>,
    @InjectRepository(ServiceRecordEntry)
    private readonly serviceRecords: Repository<ServiceRecordEntry>,
    @InjectRepository(AccountDeletionRequest)
    private readonly deletionRequests: Repository<AccountDeletionRequest>,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    private readonly audit: AuditService,
    // Best-effort Discord side effects (role sync / ban role). Every call no-ops
    // unless the bot is enabled and the relevant switch is on; never throws.
    private readonly discordSync: DiscordSyncService,
    // Reads a member's CURRENT guild roles so an admin can pull the rank and
    // medals they already wear onto the roster (T-0204) — the same reader an
    // enlistment uses, asked for its failure reasons instead of its shrug.
    private readonly roleAdoption: DiscordRoleAdoptionService,
    // Drops/rotates the caller-resolution cache so role/ban changes take effect
    // on the member's next request without a re-login (T-0046/48).
    private readonly sessionContext: SessionContextService,
    // Resolves uploaded avatar/banner keys to public URLs (namespace-validated).
    private readonly storage: StorageService,
    // Capability checks for self-OR-admin gating (service-record read, T-0101).
    private readonly authz: AuthzService,
    // Reuses the events projection machinery for the per-member events/RSVP tabs.
    private readonly eventsService: EventsService,
    // Owns every rule about claiming, releasing and blocking a vanity handle.
    private readonly usernames: UsernameService,
    // Cached proxy bytes have to be evicted when a member changes their avatar —
    // the proxy URL is stable by design, so nothing else would ever evict them.
    private readonly avatars: MemberAvatarService,
  ) {}

  /**
   * Paginated, filtered roster for the caller's regiment. Joins rank + Discord
   * identity, applies search/role/status/rank filters, orders by rank precedence
   * then name, and enriches each row with attendance metrics + medals.
   */
  async findAll(
    query: MemberQueryDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedResponseDto<MemberDto>> {
    const qb = this.members
      .createQueryBuilder('member')
      .leftJoinAndSelect('member.rank', 'rank')
      .leftJoinAndSelect('member.discordIdentity', 'identity')
      .where('member.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('member.deletedAt IS NULL');

    if (query.search) {
      // Escape LIKE wildcards so a user-supplied % / _ is matched literally rather
      // than turning the search into a leading-wildcard scan, and bound the length
      // (LDA-L7). Parameterised already, so this is about correctness/DoS, not
      // injection. `\` is MySQL's default LIKE escape character.
      const escaped = query.search
        .toLowerCase()
        .slice(0, 100)
        .replace(/[\\%_]/g, '\\$&');
      const term = `%${escaped}%`;
      qb.andWhere(
        '(LOWER(member.inGameName) LIKE :term OR LOWER(identity.discordTag) LIKE :term)',
        { term },
      );
    }
    if (query.role) {
      qb.andWhere('member.role = :role', { role: query.role });
    }
    if (query.status) {
      qb.andWhere('member.status = :status', { status: query.status });
    }
    if (query.rankId) {
      qb.andWhere('member.rankId = :rankId', { rankId: query.rankId });
    }

    qb.orderBy('rank.precedence', 'ASC')
      .addOrderBy('member.inGameName', 'ASC')
      .skip(query.skip)
      .take(query.limit);

    const [rows, total] = await qb.getManyAndCount();

    // Batch the attendance counts + medals for the whole page in single grouped
    // queries (no per-row N+1).
    const memberIds = rows.map((m) => m.id);
    const attendanceByMember = await this.attendanceCounts(memberIds);
    const medalsByMember = await this.medalsByMember(memberIds);
    // Resolved ONCE for the page (owner pointer + capability lookups), then
    // applied per row as a pure function — the flags must not cost a query per
    // member (T-0177).
    const permitted = await this.permittedActionsResolver(user);

    const data = rows.map((member) =>
      MemberDto.from(
        member,
        { eventsAttended: attendanceByMember.get(member.id) ?? 0 },
        medalsByMember.get(member.id) ?? [],
        permitted(member),
      ),
    );

    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /**
   * Single member projection. 404 when the member does not exist, belongs to a
   * different regiment, or is soft-deleted.
   */
  async findOne(id: string, user: AuthenticatedUser): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    return this.project(member, user);
  }

  /**
   * Self-service profile update. A member may only edit their own profile — any
   * mismatch with the authenticated member id is forbidden. Only the restricted
   * set of fields (inGameName + avatar/banner via an uploaded storage key) is
   * mutable here. Changing role/status/rank belongs to the admin actions below
   * and is not permitted through this handler.
   */
  async updateSelf(id: string, dto: UpdateMemberDto, user: AuthenticatedUser): Promise<MemberDto> {
    if (user.memberId !== id) {
      throw new ForbiddenException('You can only edit your own profile');
    }

    const member = await this.loadMember(id, user.regimentId);

    // In-game name is self-editable; like the avatar/banner below it is
    // intentionally not audited (no security-relevant role/status/rank change).
    if (dto.inGameName !== undefined) member.inGameName = dto.inGameName;
    // The handle is claimed in memory here and RESERVED only after the save
    // lands (below) — reserving the old one first would release a handle the
    // member still holds if the write then failed.
    let releasedHandle: string | null = null;
    if (dto.username !== undefined) {
      releasedHandle = await this.usernames.claimFor(member, dto.username);
    }
    // Avatar/banner are set from an uploaded storage key; the key's namespace is
    // re-validated (it must live under THIS member's prefix) before it is
    // resolved to the public URL persisted on the row (T-0067).
    if (dto.avatarKey !== undefined) {
      member.avatarUrl = dto.avatarKey
        ? this.storage.resolveKeyToPublicUrl(user, dto.avatarKey, StorageTarget.MemberAvatar)
        : null;
    }
    if (dto.bannerKey !== undefined) {
      member.bannerUrl = dto.bannerKey
        ? this.storage.resolveKeyToPublicUrl(user, dto.bannerKey, StorageTarget.MemberBanner)
        : null;
    }

    let saved: Member;
    try {
      saved = await this.members.save(member);
    } catch (error) {
      // Two callers can pass the availability probe and race to the same
      // handle; only the UNIQUE index is authoritative. Both losers get the
      // identical 409 the probe would have given, so the race is invisible.
      if (this.usernames.isDuplicateHandleError(error)) {
        throw new ConflictException('That username is already taken');
      }
      throw error;
    }
    // Now that the new handle is committed, put the old one beyond reach for
    // the cooldown window.
    await this.usernames.holdAfterRelease(releasedHandle, member.id);
    // A changed avatar invalidates the proxy's cached bytes; the URL is stable
    // by design, so nothing else would ever evict them.
    if (dto.avatarKey !== undefined) this.avatars.invalidate(member.id);
    // No audit row: a self profile edit never touches role/status/rank, so there
    // is no security-relevant change to record.
    return this.project(saved, user);
  }

  /** Live availability probe for the account form. Never throws on a refusal. */
  async checkUsername(candidate: string, user: AuthenticatedUser): Promise<UsernameAvailability> {
    const member = user.memberId
      ? await this.members.findOne({ where: { id: user.memberId } })
      : null;
    return this.usernames.check(candidate, member);
  }

  // ── Admin actions (capability-gated in the controller; each is audited) ──────
  //
  // Every one of them opens with `assertMayActOn` (T-0176): the capability
  // guard in the controller only asks "may this ROLE do this at all", it has no
  // notion of the target, so the target-scoped rule lives here, ahead of every
  // write. What that rule IS depends on the action (T-0211) — the full hierarchy
  // for the ones that move authority, and NO target rule at all for the ones
  // that only write a rank or a medal. The guard is passed the action for
  // exactly that reason; see `member-hierarchy.ts`.

  /**
   * Change a member's rank. Records a service-record entry + audit row. The
   * entry is typed 'promotion' or 'demotion' by comparing rank precedence
   * (T-0157) — see {@link rankChangeType}.
   */
  async changeRank(
    id: string,
    dto: ChangeRankDto,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'changeRank');
    const rank = await this.ranks.findOne({
      where: { id: dto.rankId, regimentId: user.regimentId },
    });
    if (!rank) throw new NotFoundException('Rank not found');

    const before = { rankId: member.rankId, rank: member.rank?.name ?? null };
    // Resolved BEFORE the row is mutated — the old rank is what decides whether
    // this move reads as a promotion or a demotion.
    const type = this.rankChangeType(member.rank ?? null, rank);
    // Captured pre-mutation for the same reason (T-0209): the outgoing rank's
    // Discord role is half the scope of the sync below, and once `member.rank`
    // is reassigned there is nothing left to read it from.
    const previousRankRoleId = member.rank?.discordRoleId ?? null;
    member.rankId = rank.id;
    member.rank = rank;
    await this.members.save(member);

    await this.addServiceRecord(member, type, `Rank set to ${rank.name}`, dto.note ?? null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.rank.change',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      before,
      after: { rankId: rank.id, rank: rank.name },
      detail: dto.note ?? null,
    });

    // A rank change moves the rank role and NOTHING else (T-0209).
    await this.discordSync.enqueueScopedRoleSync(
      member.regimentId,
      member.id,
      member.discordIdentity?.discordUserId ?? null,
      [previousRankRoleId, rank.discordRoleId],
    );
    return this.project(member, user, ownerMemberId);
  }

  /**
   * Change a member's role. Two independent ceilings apply: the caller must
   * outrank the target's CURRENT role (the hierarchy guard), and the role they
   * hand out may not exceed their OWN tier — equal is allowed, so a manage_roles
   * holder may appoint their own kind (T-0203).
   *
   * Ownership is protected on both: the regiment owner's role cannot be changed
   * here, and this endpoint cannot grant the Owner role at all — there is no API
   * path that assigns it (the ownership-transfer endpoint was removed in
   * T-0170), so the role is only ever set by provisioning.
   */
  async changeRole(
    id: string,
    dto: ChangeRoleDto,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<MemberDto> {
    if (dto.role === MemberRole.Owner) {
      throw new ForbiddenException('The Owner role cannot be assigned through the API');
    }
    const member = await this.loadMember(id, user.regimentId);
    // Rejected outright rather than allowed through as a same-role no-op below:
    // self-targeting this endpoint always gets one predictable answer (T-0150),
    // and the same holds for the owner/hierarchy refusals (T-0176).
    const ownerMemberId = await this.assertMayActOn(member, user, 'changeRole');

    // Cap the GRANTED role at the caller's own tier (LDA-M4, relaxed to include
    // that tier in T-0203). assertMayActOn only checks that the caller
    // outranks the target's CURRENT role; without this a manage_roles holder
    // could mint a SUPERIOR — a Moderator promoting a Member straight to Admin.
    // Their own tier is deliberately allowed: appointing a peer is what holding
    // manage_roles buys, and the appointee is capped by the same ceiling.
    if (!canGrantRole(user.role, dto.role)) {
      throw new ForbiddenException('You cannot grant a role above your own');
    }

    // A no-op change (same role) records nothing — no service-record entry, no
    // audit row, no session invalidation or Discord role sync (T-0101).
    if (dto.role === member.role) {
      return this.project(member, user, ownerMemberId);
    }

    const before = { role: member.role };
    member.role = dto.role;
    await this.members.save(member);

    await this.addServiceRecord(member, 'role', `Role set to ${dto.role}`, dto.note ?? null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.role.change',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      before,
      after: { role: dto.role },
      detail: dto.note ?? null,
    });

    // The caller's resolved authorization context is cached by identity; drop it
    // so the new role takes effect on their next request without a re-login.
    this.sessionContext.invalidate(member.discordIdentityId);

    // The ONLY Discord role an app-level role maps onto is the Membership role
    // (T-0209). A move that stays inside the enrolled tiers — Moderator to Admin,
    // say — therefore converges one id that was desired before and is desired
    // after, and touches Discord not at all. This used to be a whole-member
    // reconcile, which is how a promotion came to strip a member's decorations.
    await this.discordSync.enqueueMembershipRoleSync(
      member.regimentId,
      member.id,
      member.discordIdentity?.discordUserId ?? null,
    );
    return this.project(member, user, ownerMemberId);
  }

  /** Award a medal to a member. Medals are repeatable — each award is a new row. */
  async awardMedal(
    id: string,
    dto: AwardMedalDto,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'awardMedal');
    const medal = await this.medals.findOne({
      where: { id: dto.medalId, regimentId: user.regimentId },
    });
    if (!medal) throw new NotFoundException('Medal not found');

    await this.memberMedals.save(
      this.memberMedals.create({
        memberId: member.id,
        medalId: medal.id,
        detail: dto.detail ?? null,
        awardedByMemberId: user.memberId,
      }),
    );

    await this.addServiceRecord(member, 'award', `Awarded ${medal.title}`, dto.detail ?? null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.award',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      detail: `Awarded ${medal.title}`,
    });

    // Only this medal's role is in scope (T-0209).
    await this.discordSync.enqueueScopedRoleSync(
      member.regimentId,
      member.id,
      member.discordIdentity?.discordUserId ?? null,
      [medal.discordRoleId],
    );
    return this.project(member, user, ownerMemberId);
  }

  /**
   * Remove a medal from a member. Because medals are repeatable, this removes
   * the member's MOST RECENT award of the given medal (404 if they hold none).
   */
  async removeMedal(
    id: string,
    medalId: string,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'removeMedal');
    const award = await this.memberMedals.findOne({
      where: { memberId: member.id, medalId },
      order: { awardedAt: 'DESC' },
      relations: { medal: true },
    });
    if (!award) throw new NotFoundException('Member does not hold that medal');

    await this.memberMedals.remove(award);

    const title = award.medal?.title ?? 'medal';
    await this.addServiceRecord(member, 'award', `Removed ${title}`, null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.remove',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      detail: `Removed ${title}`,
    });

    // Only this medal's role is in scope (T-0209) — and because the worker
    // re-derives what the member should hold at drain time, a member who still
    // has ANOTHER award of the same repeatable medal keeps the role.
    await this.discordSync.enqueueScopedRoleSync(
      member.regimentId,
      member.id,
      member.discordIdentity?.discordUserId ?? null,
      [award.medal?.discordRoleId ?? null],
    );
    return this.project(member, user, ownerMemberId);
  }

  /**
   * Credit a member with the rank and medals their Discord roles say they have
   * already earned (T-0204) — the manual counterpart to the carry-over an
   * enlistment performs, for the members who never got one.
   *
   * ── WHY THIS BUTTON EXISTS ───────────────────────────────────────────────────
   * The roster is meant to be the record and Discord the mirror, and for a
   * regiment that lived on Discord first that only works if the roster starts by
   * LEARNING what the guild already knows. Enlistment does that now (T-0202) —
   * but every approval taken before it did, and any taken while the gateway was
   * unreachable, enlisted a veteran at the entry rank with none of their
   * decorations — and until T-0209 the reconcile that followed then stripped the
   * roles that were the only place that history was written down. This is the
   * repair, run one member at a time by someone who can see the result.
   *
   * ── WHAT IT WILL AND WILL NOT DO ────────────────────────────────────────────
   *  - PROMOTION ONLY. The member's current rank is the floor, so a derive can
   *    raise a rank and can never lower one. A guild whose roles have drifted
   *    below the roster is not evidence of a demotion nobody recorded.
   *  - ADDITIVE ONLY on medals: it credits medals whose role the member wears and
   *    the roster does not have, and never removes an award the guild has no role
   *    for. A medal is a record of something that happened; a missing role is not
   *    a retraction.
   *  - IDEMPOTENT. Awards are diffed against what the member already holds, so
   *    pressing it twice credits nothing twice — the second press reports that
   *    there was nothing left to derive.
   *  - ⚠️ NO TARGET RULE AT ALL, YOUR OWN RECORD INCLUDED (T-0211, owner
   *    decision). This used to refuse self, and that refusal was the whole of
   *    LDA-H1: a derive hands out whatever the target's Discord roles say they
   *    have earned, so run on yourself it is a self-promotion whose trigger —
   *    getting a role added to your own account in the guild — lives outside
   *    this application. What still bounds it is the capability (Owner+Admin by
   *    default), the promotion-only floor and additive-only medal diff below,
   *    the role-link policy that refuses a role the bot cannot manage, and the
   *    audit row. Read `DECORATION_ACTIONS` before narrowing or widening this.
   *
   * A failed READ is reported, not swallowed (unlike the enlistment path): an
   * admin who pressed a button and got "nothing to derive" must not be looking at
   * a disabled bot or an unreachable gateway.
   */
  async deriveFromDiscord(
    id: string,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<DeriveFromDiscordResultDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'deriveFromDiscord');

    // ⚠️ Reads Discord — deliberately BEFORE any transaction is opened, so an
    // unreachable gateway can never hold the roster's locks open.
    const read = await this.roleAdoption.readGuildState(
      user.regimentId,
      member.discordIdentity?.discordUserId ?? null,
      // A member with no rank at all has no floor, so any linked rank qualifies.
      member.rank?.precedence ?? Number.POSITIVE_INFINITY,
    );
    if (!read.ok) throw deriveUnavailable(read.reason, member.inGameName);

    // The adoption read knows Discord, not `member_medals`: keep only the medals
    // the roster is actually missing, or a second press double-awards every one.
    const existing = await this.memberMedals.find({ where: { memberId: member.id } });
    const alreadyHeld = new Set(existing.map((award) => award.medalId));
    const medals = read.state.medals.filter((medal) => !alreadyHeld.has(medal.id));
    const rank = read.state.rank;

    // Nothing to do is a SUCCESS, and a common one — an admin sweeping a roster
    // will hit it on most members. Say so and write nothing: no service-record
    // entry, no audit row, no sync job for a no-op.
    if (!rank && medals.length === 0) {
      return {
        member: await this.project(member, user, ownerMemberId),
        rank: null,
        medals: [],
        summary: `Nothing to derive — ${member.inGameName}'s Discord roles are already reflected on their record.`,
      };
    }

    const previousRank = member.rank ?? null;
    const type = rank ? this.rankChangeType(previousRank, rank) : null;
    const now = new Date();

    // All of it or none of it. A reconcile is enqueued once this commits and it
    // reads the roster to decide which roles are WANTED — so a medal that failed
    // to land here is a medal the bot takes off the member seconds later. A
    // half-applied derive is worse than one the admin can simply press again.
    await this.members.manager.transaction(async (manager) => {
      const records = manager.getRepository(ServiceRecordEntry);
      if (rank && type) {
        await manager.getRepository(Member).update({ id: member.id }, { rankId: rank.id });
        await records.save(
          records.create({
            memberId: member.id,
            regimentId: member.regimentId,
            occurredAt: now,
            type,
            event: `Rank set to ${rank.name}`,
            note: DERIVED_DETAIL,
          }),
        );
      }

      const awards = manager.getRepository(MemberMedal);
      for (const medal of medals) {
        await awards.save(
          awards.create({
            memberId: member.id,
            medalId: medal.id,
            detail: DERIVED_DETAIL,
            // The admin who pressed the button owns these awards: they are who
            // decided this member's Discord history is the regiment's record.
            awardedByMemberId: user.memberId,
          }),
        );
        await records.save(
          records.create({
            memberId: member.id,
            regimentId: member.regimentId,
            occurredAt: now,
            type: 'award',
            event: `Awarded ${medal.title}`,
            note: DERIVED_DETAIL,
          }),
        );
      }
    });

    // Reflect the committed rank on the loaded entity so the projection and the
    // role sync below both see the member as they now are.
    if (rank) {
      member.rankId = rank.id;
      member.rank = rank;
    }

    const summary = describeDerived(member.inGameName, rank, medals);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.derive_from_discord',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      before: { rank: previousRank?.name ?? null, medalCount: alreadyHeld.size },
      after: {
        rank: member.rank?.name ?? null,
        medalCount: alreadyHeld.size + medals.length,
      },
      detail: summary,
    });

    // Push the derived state back out to Discord. Mostly a no-op by construction
    // — these roles came FROM the guild — plus a targeted swap when the derive
    // promoted them, so the superseded rank role does not linger.
    //
    // ⚠️ ADDITIVE, DELIBERATELY (T-0209). A derive adopts what the guild already
    // says, and it adopts SELECTIVELY: a protected rank's role and any rank below
    // the member's current one are excluded by design. Following it with a
    // destructive reconcile — which is what this did — took those very roles back
    // off, so the button advertised as "pull their history in" quietly deleted
    // the parts of it the roster had declined to adopt.
    await this.discordSync.enqueueScopedRoleSync(
      member.regimentId,
      member.id,
      member.discordIdentity?.discordUserId ?? null,
      [previousRank?.discordRoleId ?? null, rank?.discordRoleId ?? null],
    );
    await this.discordSync.enqueueRoleGrant(
      member.regimentId,
      member.id,
      member.discordIdentity?.discordUserId ?? null,
    );

    return {
      member: await this.project(member, user, ownerMemberId),
      rank: rank?.name ?? null,
      medals: medals.map((medal) => medal.title),
      summary,
    };
  }

  /** Suspend a member until a future timestamp. */
  async suspend(
    id: string,
    dto: SuspendMemberDto,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<MemberDto> {
    const until = new Date(dto.until);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new BadRequestException('Suspension end must be a future date');
    }
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'suspend');

    const before = {
      suspendedUntil: member.suspendedUntil ? member.suspendedUntil.toISOString() : null,
    };
    member.suspendedUntil = until;
    await this.members.save(member);

    await this.addServiceRecord(
      member,
      'suspension',
      `Suspended until ${until.toISOString()}`,
      dto.reason ?? null,
    );
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.suspend',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      before,
      after: { suspendedUntil: until.toISOString() },
      detail: dto.reason ?? null,
    });

    // Revoke the suspended member's outstanding sessions (T-0048).
    await this.sessionContext.invalidateSessions(member.discordIdentityId);

    return this.project(member, user, ownerMemberId);
  }

  /**
   * Ban a member (app-side). Marks bannedAt + sets status Inactive.
   *
   * ⚠️ SENSITIVE — owner decision (questionnaire T-0027 Q4 → reshaped by T-0035):
   * an app-side ban may ALSO strip the member's managed Discord roles and apply a
   * configured "Ban" role. That is wired as a best-effort outbox job
   * (enqueueMemberBanRole), GATED behind the regiment's `applyBanRoleOnBan`
   * switch (DEFAULTS OFF) and requiring a Ban role to be set — so by default a
   * ban never touches Discord. The owner asked to re-review this flow every time
   * it is touched before enabling it in production; the enqueue no-ops until then.
   */
  async ban(
    id: string,
    dto: BanMemberDto,
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'ban');
    if (member.bannedAt) throw new ConflictException('Member is already banned');

    member.bannedAt = new Date();
    member.status = MemberStatus.Inactive;
    await this.members.save(member);

    await this.addServiceRecord(member, 'ban', 'Banned from the regiment', dto.reason ?? null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.ban',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      after: { bannedAt: member.bannedAt.toISOString() },
      detail: dto.reason ?? null,
    });

    // Revoke the banned member's outstanding sessions (T-0048).
    await this.sessionContext.invalidateSessions(member.discordIdentityId);

    // Flag-gated (applyBanRoleOnBan, default OFF) + best-effort — never fails the
    // ban. Strips managed Discord roles and applies the configured Ban role.
    await this.discordSync.enqueueMemberBanRole(
      member.regimentId,
      member.discordIdentity?.discordUserId ?? null,
      dto.reason ?? null,
    );
    return this.project(member, user, ownerMemberId);
  }

  /**
   * Lift an active suspension: clear suspendedUntil. Mirrors {@link unban} but for
   * the time-boxed suspension. "Currently suspended" means a suspendedUntil in the
   * FUTURE (matching the roster's derived status + the frontend's Unsuspend gate);
   * an already-elapsed timestamp is a no-op suspension, so it Conflicts like an
   * unban of a non-banned member. The owner is protected consistent with suspend
   * (assertNotOwner) even though an owner can never be suspended in the first place.
   * Unlike suspend, no session invalidation is needed — lifting a suspension only
   * restores access. Status is left untouched (suspend never changed it; the
   * derived Suspended pill clears once suspendedUntil is null).
   */
  async unsuspend(id: string, user: AuthenticatedUser, ip: string | null): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'unsuspend');
    if (!member.suspendedUntil || member.suspendedUntil.getTime() <= Date.now()) {
      throw new ConflictException('Member is not currently suspended');
    }

    const before = { suspendedUntil: member.suspendedUntil.toISOString() };
    member.suspendedUntil = null;
    await this.members.save(member);

    await this.addServiceRecord(member, 'suspension', 'Suspension lifted', null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.unsuspend',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
      before,
      after: { suspendedUntil: null },
    });

    return this.project(member, user, ownerMemberId);
  }

  /** Lift a ban: clear bannedAt + reactivate. */
  async unban(id: string, user: AuthenticatedUser, ip: string | null): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const ownerMemberId = await this.assertMayActOn(member, user, 'unban');
    if (!member.bannedAt) throw new ConflictException('Member is not banned');

    member.bannedAt = null;
    member.status = MemberStatus.Active;
    await this.members.save(member);

    await this.addServiceRecord(member, 'ban', 'Ban lifted', null);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.unban',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: member.id, memberId: member.id, label: member.inGameName },
    });

    return this.project(member, user, ownerMemberId);
  }

  /**
   * A member's service timeline (most recent first). Readable only by the member
   * themselves or an admin holding view_audit_log — any other caller is
   * forbidden (T-0101). The privacy-gated profile section mirrors this rule.
   */
  async getServiceRecord(id: string, user: AuthenticatedUser): Promise<ServiceRecordEntryDto[]> {
    await this.loadMember(id, user.regimentId); // 404s if not in the regiment
    if (user.memberId !== id) {
      const canViewAudit = await this.authz.can(
        user.regimentId,
        user.role,
        Capability.ViewAuditLog,
      );
      if (!canViewAudit) {
        throw new ForbiddenException('You can only view your own service record');
      }
    }
    const entries = await this.serviceRecords.find({
      where: { memberId: id, regimentId: user.regimentId },
      order: { occurredAt: 'DESC', createdAt: 'DESC' },
    });
    return entries.map((e) => ServiceRecordEntryDto.from(e));
  }

  /** Sensitive last-sign-in + moderation state (admin only — view_audit_log). */
  async getCommandInfo(id: string, user: AuthenticatedUser): Promise<CommandInfoDto> {
    const member = await this.loadMember(id, user.regimentId);
    return CommandInfoDto.from(member);
  }

  // ── GDPR (self-service, deferred/Discord-reauth-gated) ───────────────────────
  //
  // ⚠️ ACCOUNT DELETION IS SELF-ONLY, deliberately and permanently (owner
  // decision, restated for T-0176). Every method below keys off `user.memberId`
  // — the id resolved from the caller's own session, never a path/body
  // parameter — so there is no admin-on-behalf-of path and no route that could
  // become one. The role hierarchy T-0176 introduces does NOT open one: nobody,
  // not even the Owner, may delete another member's account. Erasure is a
  // personal right exercised by the data subject; letting an admin fire it at a
  // member would turn a GDPR facility into a moderation weapon that destroys
  // the target's Discord identity irreversibly. Admins remove people with
  // ban/suspend, which are reversible and audited. A spec pins this.

  /**
   * Create a deferred account-deletion request for the caller's own member.
   * Self-only: the target is `user.memberId`, never an argument.
   */
  async requestSelfDeletion(
    user: AuthenticatedUser,
    dto: DeletionRequestDto,
    ip: string | null,
  ): Promise<{ requestId: string; status: AccountDeletionStatus; confirmToken: string }> {
    if (!user.memberId) throw new ForbiddenException('Only enrolled members can request deletion');
    if (!dto.acknowledgePermanent || !dto.acknowledgeDataDownloaded) {
      throw new BadRequestException('Both acknowledgements are required');
    }

    // Idempotent: if a pending request already exists (e.g. a prior confirm step
    // failed after this one was created), return ITS token to the same owner so the
    // flow can be retried and completed — rather than getting stuck behind a 409
    // with the original token lost. The token authorizes only the caller's own
    // deletion, so returning it to self is safe.
    const existing = await this.deletionRequests.findOne({
      where: { memberId: user.memberId, status: AccountDeletionStatus.PendingDiscordConfirmation },
    });
    if (existing) {
      return {
        requestId: existing.id,
        status: existing.status,
        confirmToken: existing.confirmToken,
      };
    }

    const request = await this.deletionRequests.save(
      this.deletionRequests.create({
        memberId: user.memberId,
        confirmToken: randomBytes(32).toString('hex'),
        acknowledgePermanent: dto.acknowledgePermanent,
        acknowledgeDataDownloaded: dto.acknowledgeDataDownloaded,
        status: AccountDeletionStatus.PendingDiscordConfirmation,
        requestedAt: new Date(),
      }),
    );

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.deletion.request',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: user.memberId, memberId: user.memberId },
      detail: 'Account deletion requested (pending confirmation)',
    });

    // The token would be delivered out-of-band (Discord re-auth) in production;
    // it is returned here so the deferred confirm step can be exercised.
    return { requestId: request.id, status: request.status, confirmToken: request.confirmToken };
  }

  /**
   * Confirm a pending deletion request (marks confirmed; execution is deferred).
   * Self-only: the request is looked up by the CALLER's member id, so one
   * member's token can never advance another member's request.
   */
  async confirmSelfDeletion(
    user: AuthenticatedUser,
    dto: ConfirmDeletionDto,
  ): Promise<{ status: AccountDeletionStatus }> {
    if (!user.memberId) throw new ForbiddenException('Only enrolled members can confirm deletion');
    const request = await this.deletionRequests.findOne({
      where: {
        memberId: user.memberId,
        confirmToken: dto.token,
        status: AccountDeletionStatus.PendingDiscordConfirmation,
      },
    });
    if (!request) throw new NotFoundException('No matching pending deletion request');

    request.status = AccountDeletionStatus.Confirmed;
    request.confirmedAt = new Date();
    request.discordReauthenticatedAt = new Date();
    await this.deletionRequests.save(request);
    return { status: request.status };
  }

  /**
   * Terminal execution of a CONFIRMED deletion request (T-0113): soft-delete the
   * member (hides them from the roster + downgrades their auth context to
   * Applicant), anonymise their PII on both the member row and the linked Discord
   * identity, mark the request Executed, revoke outstanding sessions and audit it.
   * The member + identity rows and the audit trail are retained (soft-delete),
   * only the personal data is scrubbed. Idempotent-safe: requires a Confirmed
   * request, so a re-invocation after execution 404s rather than double-running.
   * Self-only: it deletes `user.memberId` and nothing else — there is no
   * parameter by which an admin could aim it at another member.
   */
  async executeSelfDeletion(
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<{ status: AccountDeletionStatus }> {
    if (!user.memberId)
      throw new ForbiddenException('Only enrolled members can delete their account');
    const request = await this.deletionRequests.findOne({
      where: { memberId: user.memberId, status: AccountDeletionStatus.Confirmed },
    });
    if (!request) throw new NotFoundException('No confirmed deletion request to execute');

    const member = await this.loadMember(user.memberId, user.regimentId);
    const identityId = member.discordIdentityId;
    // Captured before the row is anonymised — the handle has to survive the
    // transaction so it can be blocked afterwards.
    const releasedHandle = member.username;
    const avatarKeys = [member.avatarUrl, member.bannerUrl];

    // Anonymise + soft-delete atomically so the roster can never observe a
    // half-deleted member (PII cleared but row still live, or vice versa).
    await this.members.manager.transaction(async (mgr) => {
      // Overwrite roster-facing PII (in_game_name is NOT NULL → placeholder).
      member.inGameName = '[deleted member]';
      member.avatarUrl = null;
      member.bannerUrl = null;
      member.standing = null;
      member.status = MemberStatus.Inactive;
      member.discordLinked = false;
      // MUST be null, not a placeholder. The row survives as a soft-delete and
      // keeps occupying `UQ_members_username`, so a `'[deleted]'` sentinel of
      // the kind used for `inGameName` above would raise ER_DUP_ENTRY on the
      // SECOND account deletion. Null is the only value the unique index treats
      // as distinct. The handle is separately blocked below so nulling it here
      // does not hand it to a stranger.
      member.username = null;
      await mgr.getRepository(Member).save(member);
      await mgr.getRepository(Member).softRemove(member);

      // Hard-delete the linked identity (the sensitive PII — email, OAuth tokens —
      // lives here). Anonymising the fields in place would be silently undone on
      // the next Discord sign-in, which upserts the row by discord_user_id and
      // rewrites fresh PII. Deleting the row makes the erasure durable: a later
      // sign-in creates a BRAND-NEW identity (the members/applications FKs are
      // ON DELETE SET NULL, so the soft-deleted member simply de-links).
      if (identityId) {
        await mgr.getRepository(DiscordIdentity).delete({ id: identityId });
      }

      request.status = AccountDeletionStatus.Executed;
      request.executedAt = new Date();
      await mgr.getRepository(AccountDeletionRequest).save(request);
    });

    // Outside the transaction on purpose: both are best-effort cleanups whose
    // failure must not roll back an erasure the member already confirmed.

    // The handle is blocked FOREVER rather than released. A departed member is
    // still addressed by it in Discord history, event embeds and the audit
    // ledger, so handing it to a stranger is the one squat with a real victim.
    await this.usernames.blockPermanently(releasedHandle, user.memberId);

    // Purge the avatar/banner bytes. Nulling the columns above only stops US
    // linking them — the objects stay publicly fetchable at their original CDN
    // URLs, and the path embeds the member id, so an erasure that leaves them
    // behind is not an erasure. Now that profiles are public and indexed, an
    // orphaned avatar is a face on a URL nobody can take down.
    await this.purgeMemberObjects(avatarKeys);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.deletion.execute',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: user.memberId, memberId: user.memberId },
      detail: 'Account deleted (member soft-deleted + anonymised; Discord identity erased)',
    });

    // Revoke every outstanding token for the identity and drop the cached
    // context, so the deleted member is fully logged out immediately (T-0048).
    await this.sessionContext.invalidateSessions(identityId);

    return { status: request.status };
  }

  /**
   * Cancel a pending or confirmed deletion request before it is executed (T-0113).
   * A member who changes their mind can back out at either the pre-confirm or
   * post-confirm (pre-execute) stage; once Executed there is nothing to cancel.
   * Self-only, like the rest of the flow.
   */
  async cancelSelfDeletion(
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<{ status: AccountDeletionStatus }> {
    if (!user.memberId) throw new ForbiddenException('Only enrolled members can cancel deletion');
    const request = await this.deletionRequests.findOne({
      where: [
        { memberId: user.memberId, status: AccountDeletionStatus.PendingDiscordConfirmation },
        { memberId: user.memberId, status: AccountDeletionStatus.Confirmed },
      ],
    });
    if (!request) throw new NotFoundException('No pending deletion request to cancel');

    request.status = AccountDeletionStatus.Cancelled;
    await this.deletionRequests.save(request);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'member.deletion.cancel',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: user.memberId, memberId: user.memberId },
      detail: 'Account deletion request cancelled',
    });

    return { status: request.status };
  }

  /** Export the caller's own data (GDPR data download) — self-only, like deletion. */
  async exportSelfData(user: AuthenticatedUser): Promise<Record<string, unknown>> {
    if (!user.memberId) throw new ForbiddenException('Only enrolled members can export data');
    const member = await this.loadMember(user.memberId, user.regimentId);
    const medals = await this.medalsByMember([member.id]);
    const serviceRecord = await this.getServiceRecord(member.id, user);

    return {
      exportedAt: new Date().toISOString(),
      profile: await this.project(member, user),
      medals: medals.get(member.id) ?? [],
      serviceRecord,
      discordIdentity: member.discordIdentity
        ? {
            discordUserId: member.discordIdentity.discordUserId,
            discordUsername: member.discordIdentity.discordUsername,
            email: member.discordIdentity.email,
            lastSignInAt: member.discordIdentity.lastSignInAt,
          }
        : null,
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  // ⚠️ THERE IS NO `syncMemberRoles` HELPER ANY MORE, AND ITS ABSENCE IS THE FIX
  // (T-0209). Every mutation here used to funnel into one "sync this member"
  // call, which threw away WHAT had changed at the enqueue boundary — leaving
  // the worker no choice but to recompute the member's whole desired set and
  // strip every managed role the roster could not account for. Awarding a medal
  // and promoting a Moderator to Admin both ran that, so either could take a
  // veteran's hand-granted decorations off.
  //
  // Each mutation now names its own scope at the call site
  // (`enqueueScopedRoleSync` / `enqueueMembershipRoleSync`) or asks for the
  // additive sync (`enqueueRoleGrant`). Bringing the helper back would re-open
  // the bug, because a single shared call has nowhere to put the delta.

  /**
   * Best-effort purge of a departed member's uploaded avatar/banner bytes.
   *
   * `deleteObject` skips any URL outside our own storage base, which is exactly
   * right here: the avatar column may hold the Discord CDN fallback, and that
   * is not ours to delete. Every failure is swallowed by the storage layer —
   * an erasure the member already confirmed must not roll back because an
   * object was already gone.
   */
  private async purgeMemberObjects(urls: (string | null)[]): Promise<void> {
    for (const url of urls) {
      if (url) await this.storage.deleteObject(url);
    }
  }

  /** Load a regiment-scoped, non-deleted member with its rank + identity, or 404. */
  private async loadMember(id: string, regimentId: string): Promise<Member> {
    const member = await this.members.findOne({
      where: { id, regimentId },
      relations: { rank: true, discordIdentity: true },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    return member;
  }

  /** Project a single loaded member to a DTO, computing its metrics + medals. */
  private async project(
    member: Member,
    user: AuthenticatedUser,
    ownerMemberId?: string | null,
  ): Promise<MemberDto> {
    const eventsAttended = await this.attendees.count({ where: { memberId: member.id } });
    const medals = (await this.medalsByMember([member.id])).get(member.id) ?? [];
    const permitted = await this.permittedActionsResolver(user, ownerMemberId);
    return MemberDto.from(member, { eventsAttended }, medals, permitted(member));
  }

  /**
   * Build the per-request `permittedActions` mapper (T-0177). Everything that
   * costs I/O — the owner pointer and the caller's capabilities — is resolved
   * HERE, once; the returned function is pure, so a roster page of any size
   * keeps the endpoint's query count. The flags come from the very predicate
   * {@link assertMayActOn} enforces, so the client can never be told an
   * action is available that the endpoint would then refuse.
   */
  private async permittedActionsResolver(
    user: AuthenticatedUser,
    knownOwnerMemberId?: string | null,
  ): Promise<(member: Member) => PermittedActionsDto> {
    // `null` is a real answer (a regiment with no owner pointer), so only an
    // absent argument triggers the read.
    const ownerMemberId =
      knownOwnerMemberId === undefined
        ? await this.ownerMemberId(user.regimentId)
        : knownOwnerMemberId;
    const held = new Set<string>();
    for (const capability of MEMBER_ADMIN_CAPABILITIES) {
      if (await this.authz.can(user.regimentId, user.role, capability)) held.add(capability);
    }
    return (member) =>
      permittedActions(
        {
          actorRole: user.role,
          actorMemberId: user.memberId,
          target: member,
          ownerMemberId,
        },
        held,
      );
  }

  // ── Per-member events + RSVPs (profile Event History / RSVPs tabs, T-0100) ────

  /**
   * The events the given member attended (past attendances), for the profile
   * Event History tab. 404s if the member is not in the caller's regiment; the
   * projection is the public (server-redacted) event shape.
   */
  async getEvents(id: string, user: AuthenticatedUser): Promise<EventDto[]> {
    await this.loadMember(id, user.regimentId); // 404s if not in the regiment
    return this.eventsService.listAttendedByMember(user, id);
  }

  /**
   * The events the given member RSVP'd to (with their own RSVP reflected), for
   * the profile RSVPs tab. 404s if the member is not in the caller's regiment.
   */
  async getRsvps(id: string, user: AuthenticatedUser): Promise<EventDto[]> {
    await this.loadMember(id, user.regimentId); // 404s if not in the regiment
    return this.eventsService.listRsvpsByMember(user, id);
  }

  /** Append a service-record entry for a member. */
  private async addServiceRecord(
    member: Member,
    type: string,
    event: string,
    note: string | null,
  ): Promise<void> {
    await this.serviceRecords.save(
      this.serviceRecords.create({
        memberId: member.id,
        regimentId: member.regimentId,
        occurredAt: new Date(),
        type,
        event,
        note,
      }),
    );
  }

  /**
   * The service-record type for a rank move (T-0157). The ladder is ordered by
   * precedence with 1 = highest (see ranks.seed), so a HIGHER precedence number
   * is a step DOWN. A member with no previous rank has nothing to compare
   * against and is recorded as a promotion. Forward-only: rows written before
   * this existed keep their original 'promotion' type.
   */
  private rankChangeType(previous: Rank | null, next: Rank): string {
    if (!previous) return 'promotion';
    return next.precedence > previous.precedence ? 'demotion' : 'promotion';
  }

  /** The regiment's owner pointer (`regiments.owner_member_id`), or null. */
  private async ownerMemberId(regimentId: string): Promise<string | null> {
    const regiment = await this.regiments.findOne({ where: { id: regimentId } });
    return regiment?.ownerMemberId ?? null;
  }

  /**
   * The one target-scoped authorization guard for every member admin action
   * (T-0176). It folds together three refusals that used to be applied
   * piecemeal — and, before this, not at all on changeRank/awardMedal/
   * removeMedal/unban:
   *
   *  - SELF: nobody MODERATES their own record (T-0150) — otherwise a non-owner
   *    Admin holding manage_roles could demote or ban their own account and lock
   *    the regiment out of a seat only they occupy. Matched on member id; the
   *    Discord id and the display name are both re-assignable and would be the
   *    wrong key.
   *  - OWNER: the regiment owner pointer is untouchable. It stays the stricter,
   *    authoritative check — it holds even if the owner's ROLE ever drifts from
   *    the pointer, so it is not superseded by the role comparison.
   *  - RANK: the actor must STRICTLY outrank the target, so an Admin cannot act
   *    on a peer Admin (only the Owner can) and a Moderator cannot act on an
   *    Admin. The capability guard in the controller cannot express this: it
   *    only knows the caller's role, never the target.
   *
   * All three are the MODERATION rule and apply to role/suspend/ban only
   * (T-0211). A rank or medal write — changeRank, awardMedal, removeMedal,
   * deriveFromDiscord — is not asked any of them: it answers to
   * edit_ranks_medals and stops, so the regiment's record-keeper can enter a
   * promotion for a peer, a superior, the Owner, or themselves. It still runs
   * through here, because the owner-pointer read it returns feeds the projection.
   *
   * Called before any write, so a rejected action leaves no audit row, no
   * service-record entry, no Discord sync job and no session invalidation.
   */
  private async assertMayActOn(
    member: Member,
    user: AuthenticatedUser,
    action: MemberAdminAction,
  ): Promise<string | null> {
    const ownerMemberId = await this.ownerMemberId(user.regimentId);
    assertCanActOn(
      { actorRole: user.role, actorMemberId: user.memberId, target: member, ownerMemberId },
      action,
    );
    // Handed back so the projection that follows the write can reuse it: one
    // owner-pointer read serves both the guard and the permitted-action flags.
    return ownerMemberId;
  }

  /**
   * One grouped query mapping memberId -> confirmed attendance count for the
   * given page of members. Returns an empty map for an empty page.
   */
  private async attendanceCounts(memberIds: string[]): Promise<Map<string, number>> {
    if (memberIds.length === 0) return new Map();
    const rows = await this.attendees
      .createQueryBuilder('attendee')
      .select('attendee.memberId', 'memberId')
      .addSelect('COUNT(*)', 'count')
      .where('attendee.memberId IN (:...memberIds)', { memberIds })
      .groupBy('attendee.memberId')
      .getRawMany<{ memberId: string; count: string }>();
    return new Map(rows.map((r) => [r.memberId, Number(r.count)]));
  }

  /**
   * One query mapping memberId -> its medal award summaries (medal joined), for
   * the given page of members. Empty map for [].
   *
   * ORDERED BY THE MEDAL CABINET, NOT BY THE CALENDAR (T-0212). Every surface
   * that renders a member's medals — the roster row, the profile's Honours &
   * Decorations panel, the dashboard's Decorations strip and the admin dialog's
   * chips — renders this array verbatim, so this ordering IS the display order
   * and no client sorts. Sorting by `medal.precedence` ASC is the same order
   * `medals.findAll` gives the cabinet on /admin/ranks, which makes a member's
   * decorations read senior-first and line up column-wise across roster rows.
   *
   * The two tiebreakers are load-bearing, not decoration. `precedence` is
   * neither unique nor stable (it defaults to 0 and the drag-reorder rewrites
   * it), and medals are repeatable, so two awards of the SAME medal always tie.
   * `awardedAt` then `id` make the sort total, which is what keeps the roster
   * from reshuffling between two requests.
   */
  private async medalsByMember(memberIds: string[]): Promise<Map<string, MemberMedalSummary[]>> {
    const map = new Map<string, MemberMedalSummary[]>();
    if (memberIds.length === 0) return map;

    const awards = await this.memberMedals.find({
      where: { memberId: In(memberIds) },
      relations: { medal: true },
      order: { medal: { precedence: 'ASC' }, awardedAt: 'DESC', id: 'ASC' },
    });

    for (const award of awards) {
      if (!award.medal) continue;
      const summary: MemberMedalSummary = {
        id: award.id,
        medalId: award.medalId,
        title: award.medal.title,
        glyph: award.medal.glyph,
        imageUrl: award.medal.imageUrl,
        description: award.medal.description ?? null,
        detail: award.detail,
        awardedAt: award.awardedAt.toISOString(),
      };
      const list = map.get(award.memberId) ?? [];
      list.push(summary);
      map.set(award.memberId, list);
    }
    return map;
  }
}
