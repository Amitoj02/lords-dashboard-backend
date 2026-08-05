import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { SessionContextService } from '../auth/session-context.service';
import { StorageService } from '../storage/storage.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { DiscordRoleAdoptionService } from '../discord/discord-role-adoption.service';
import { AuthzService } from '../authz/authz.service';
import { EventsService } from '../events/events.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import {
  AccountDeletionStatus,
  Capability,
  MemberRole,
  MemberStatus,
  StorageTarget,
} from '../common/enums';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';
import { ServiceRecordEntry } from './entities/service-record-entry.entity';
import { Member } from './entities/member.entity';
import { MembersService } from './members.service';
import { MemberAvatarService } from './public/member-avatar.service';
import { UsernameService } from './username.service';
import {
  ACTION_CAPABILITY,
  DECORATION_ACTIONS,
  MEMBER_ADMIN_ACTIONS,
  MODERATION_ACTIONS,
  MemberAdminAction,
  ROLE_PRECEDENCE,
} from './member-hierarchy';

const REGIMENT = 'regiment-1';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Member,
  regimentId: REGIMENT,
  ...overrides,
});

const buildMember = (overrides: Partial<Member> = {}): Member =>
  ({
    id: 'member-1',
    regimentId: REGIMENT,
    inGameName: 'LC',
    role: MemberRole.Member,
    status: MemberStatus.Active,
    discordLinked: true,
    publicProfile: true,
    avatarUrl: 'https://cdn/a.png',
    bannerUrl: null,
    standing: 'good',
    joinedAt: new Date('2024-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2024-06-01T00:00:00.000Z'),
    rank: { id: 'rank-1', name: 'Sergeant', imageUrl: 'https://cdn/rank.png', precedence: 2 },
    discordIdentity: { discordTag: '@commander' },
    ...overrides,
  }) as unknown as Member;

describe('MembersService', () => {
  let service: MembersService;

  // Member repository: a configurable QueryBuilder + findOne/save.
  let memberQb: {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  // Shared per-transaction repo mock so tests can assert save/softRemove/delete.
  const txRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    softRemove: jest.fn((x: unknown) => Promise.resolve(x)),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const memberRepo = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    // Account-deletion execute runs inside a transaction; the mock manager invokes
    // the callback with a shared repo whose save/softRemove/delete are no-ops, so
    // the service's in-memory mutations still occur and the delete can be asserted.
    manager: {
      transaction: jest.fn((cb: (mgr: unknown) => Promise<unknown>) =>
        cb({ getRepository: () => txRepo }),
      ),
    },
  };

  // EventAttendee repository: count + grouped QueryBuilder.
  let attendeeQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  const attendeeRepo = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const rankRepo = { findOne: jest.fn() };
  const medalRepo = { findOne: jest.fn() };
  const memberMedalRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
    remove: jest.fn(),
  };
  const serviceRecordRepo = {
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
  };
  const deletionRepo = { findOne: jest.fn(), save: jest.fn(), create: jest.fn((x: unknown) => x) };
  const regimentRepo = { findOne: jest.fn() };
  const audit = { record: jest.fn() };
  // Best-effort Discord side effects — mocked so admin actions can assert they
  // are enqueued without a real bot.
  const discordSync = {
    // ⚠️ EVERY enqueue this service can reach must be listed. A missing key is
    // not a compile error here (the mock is a literal cast at the provider), so
    // it would make `expectRefusedWithoutTrace` pass vacuously while a refused
    // action quietly leaked a Discord job.
    enqueueRoleGrant: jest.fn().mockResolvedValue(null),
    enqueueScopedRoleSync: jest.fn().mockResolvedValue(null),
    enqueueMembershipRoleSync: jest.fn().mockResolvedValue(null),
    enqueueMemberBanRole: jest.fn().mockResolvedValue(null),
  };
  // The guild read behind "Derive data from Discord" (T-0204). Defaults to a
  // SUCCESSFUL read that found nothing, so the shared hierarchy matrix exercises
  // the guard without any test having to stub Discord.
  const roleAdoption = {
    readGuildState: jest.fn().mockResolvedValue({ ok: true, state: { rank: null, medals: [] } }),
  };
  // Caller-context cache hooks (T-0046/48) — assert invalidation without a DB.
  const sessionContext = {
    invalidate: jest.fn(),
    invalidateSessions: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    resolveKeyToPublicUrl: jest.fn((_u: unknown, key: string) => `https://cdn.example/${key}`),
    // Account deletion purges the departed member's avatar/banner objects
    // (T-0215) — the bytes stay publicly fetchable otherwise, and the path
    // embeds the member id that is also the profile URL.
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  // Capability gate for self-OR-admin service-record reads (T-0101).
  const authz = { can: jest.fn() };
  // Per-member events/RSVP tabs delegate to the events projection machinery.
  const eventsService = {
    listAttendedByMember: jest.fn(),
    listRsvpsByMember: jest.fn(),
  };
  // Vanity-handle rules (T-0215). `claimFor` resolving to null is "no handle was
  // released", which is what every test in this file needs.
  const usernames = {
    claimFor: jest.fn().mockResolvedValue(null),
    check: jest.fn().mockResolvedValue({ available: true }),
    holdAfterRelease: jest.fn().mockResolvedValue(undefined),
    blockPermanently: jest.fn().mockResolvedValue(undefined),
    isDuplicateHandleError: jest.fn().mockReturnValue(false),
    renameCooldownFor: jest.fn().mockReturnValue(null),
  };
  const avatars = { invalidate: jest.fn(), pathFor: jest.fn(() => '/api/avatar') };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: nobody holds medals unless a test says otherwise.
    memberMedalRepo.find.mockResolvedValue([]);
    memberMedalRepo.save.mockImplementation((x: unknown) => Promise.resolve(x));
    serviceRecordRepo.save.mockImplementation((x: unknown) => Promise.resolve(x));
    regimentRepo.findOne.mockResolvedValue({ id: REGIMENT, ownerMemberId: 'owner-member' });

    memberQb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    };
    memberRepo.createQueryBuilder.mockReturnValue(memberQb);

    attendeeQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    attendeeRepo.createQueryBuilder.mockReturnValue(attendeeQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembersService,
        { provide: getRepositoryToken(Member), useValue: memberRepo },
        { provide: getRepositoryToken(EventAttendee), useValue: attendeeRepo },
        { provide: getRepositoryToken(Rank), useValue: rankRepo },
        { provide: getRepositoryToken(Medal), useValue: medalRepo },
        { provide: getRepositoryToken(MemberMedal), useValue: memberMedalRepo },
        { provide: getRepositoryToken(ServiceRecordEntry), useValue: serviceRecordRepo },
        { provide: getRepositoryToken(AccountDeletionRequest), useValue: deletionRepo },
        { provide: getRepositoryToken(Regiment), useValue: regimentRepo },
        { provide: AuditService, useValue: audit },
        { provide: DiscordSyncService, useValue: discordSync },
        { provide: DiscordRoleAdoptionService, useValue: roleAdoption },
        { provide: SessionContextService, useValue: sessionContext },
        { provide: StorageService, useValue: storage },
        { provide: AuthzService, useValue: authz },
        { provide: EventsService, useValue: eventsService },
        // Handle rules and the avatar proxy cache (T-0215). Neither is exercised
        // by the admin-action tests below; UsernameService has its own spec.
        { provide: UsernameService, useValue: usernames },
        { provide: MemberAvatarService, useValue: avatars },
      ],
    }).compile();

    service = module.get(MembersService);
  });

  /**
   * Every target-scoped admin action reduced to one shape, so a rule can be
   * asserted against ALL of them (T-0176) instead of only the two that happened
   * to carry a guard before. `service` is read lazily — it is rebuilt per test.
   */
  const invokeAction: Record<
    MemberAdminAction,
    (actor: AuthenticatedUser, targetId: string) => Promise<unknown>
  > = {
    changeRank: (actor, id) => service.changeRank(id, { rankId: 'rank-9' }, actor, null),
    // Grant Applicant (the tier every non-Applicant actor outranks) so this shared
    // invocation isolates the target-hierarchy gate from the grant-ceiling gate
    // (LDA-M4) — the ceiling has its own dedicated test below.
    changeRole: (actor, id) => service.changeRole(id, { role: MemberRole.Applicant }, actor, null),
    awardMedal: (actor, id) => service.awardMedal(id, { medalId: 'medal-1' }, actor, null),
    removeMedal: (actor, id) => service.removeMedal(id, 'medal-1', actor, null),
    suspend: (actor, id) =>
      service.suspend(id, { until: new Date(Date.now() + 86_400_000).toISOString() }, actor, null),
    unsuspend: (actor, id) => service.unsuspend(id, actor, null),
    ban: (actor, id) => service.ban(id, {}, actor, null),
    unban: (actor, id) => service.unban(id, actor, null),
    deriveFromDiscord: (actor, id) => service.deriveFromDiscord(id, actor, null),
  };

  /**
   * True when the action was refused by an authorization guard. A 404/409 from
   * the action's own state (an unban of a member who is not banned, say) is NOT
   * a refusal of the ACTOR, which is all the hierarchy has an opinion about.
   */
  const wasForbidden = (promise: Promise<unknown>): Promise<boolean> =>
    promise.then(
      () => false,
      (error: unknown) => error instanceof ForbiddenException,
    );

  describe('findAll', () => {
    it('scopes by regiment, applies filters, and computes derived fields + attendance count', async () => {
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      attendeeQb.getRawMany.mockResolvedValue([{ memberId: 'member-1', count: '7' }]);

      const result = await service.findAll(
        {
          page: 1,
          limit: 20,
          skip: 0,
          search: 'Comm',
          role: MemberRole.Member,
          status: MemberStatus.Active,
          rankId: 'rank-1',
        },
        user(),
      );

      // Regiment scope + soft-delete exclusion.
      expect(memberQb.where).toHaveBeenCalledWith('member.regimentId = :regimentId', {
        regimentId: REGIMENT,
      });
      expect(memberQb.andWhere).toHaveBeenCalledWith('member.deletedAt IS NULL');
      // Search lowercased; LIKE clause covers inGameName + discordTag only.
      expect(memberQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(member.inGameName) LIKE :term'),
        { term: '%comm%' },
      );
      // Ordered by precedence then in-game name.
      expect(memberQb.orderBy).toHaveBeenCalledWith('rank.precedence', 'ASC');
      expect(memberQb.addOrderBy).toHaveBeenCalledWith('member.inGameName', 'ASC');

      // Grouped attendance query was used (no N+1 .count per row).
      expect(attendeeRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(attendeeRepo.count).not.toHaveBeenCalled();

      const dto = result.data[0];
      expect(dto.inGameName).toBe('LC');
      expect(dto.rank).toBe('Sergeant');
      expect(dto.rankImageUrl).toBe('https://cdn/rank.png');
      expect(dto.rankPrecedence).toBe(2);
      expect(dto.discordTag).toBe('@commander');
      expect(dto.eventsAttended).toBe(7);
      expect(dto.joinedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(result.meta.total).toBe(1);
    });

    it('reflects the grouped attendance count on each row', async () => {
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      attendeeQb.getRawMany.mockResolvedValue([{ memberId: 'member-1', count: '5' }]);

      const result = await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      expect(result.data[0].eventsAttended).toBe(5);
    });

    it('defaults attendance to 0 for members absent from the grouped result', async () => {
      const member = buildMember({ id: 'member-2', inGameName: 'Recruit', rank: undefined });
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      attendeeQb.getRawMany.mockResolvedValue([]); // nobody attended

      const result = await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      const dto = result.data[0];
      expect(dto.eventsAttended).toBe(0);
      // Unranked member falls back gracefully.
      expect(dto.rank).toBeNull();
      expect(dto.rankImageUrl).toBeNull();
      expect(dto.rankPrecedence).toBeNull();
    });

    it('projects each medal award with its image URL and glyph fallback', async () => {
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      memberMedalRepo.find.mockResolvedValue([
        {
          id: 'award-1',
          memberId: 'member-1',
          medalId: 'medal-1',
          detail: 'For valour',
          awardedAt: new Date('2024-05-01T00:00:00.000Z'),
          medal: { title: 'Valor', glyph: 'V', imageUrl: 'https://cdn/medal.png' },
        },
      ]);

      const result = await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      const medal = result.data[0].medals[0];
      expect(medal.title).toBe('Valor');
      expect(medal.glyph).toBe('V');
      expect(medal.imageUrl).toBe('https://cdn/medal.png');
      expect(medal.awardedAt).toBe('2024-05-01T00:00:00.000Z');
    });

    it('leaves medal.imageUrl null when the medal has no image (glyph fallback)', async () => {
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      memberMedalRepo.find.mockResolvedValue([
        {
          id: 'award-2',
          memberId: 'member-1',
          medalId: 'medal-2',
          detail: null,
          awardedAt: new Date('2024-05-02T00:00:00.000Z'),
          medal: { title: 'Service', glyph: 'S', imageUrl: null },
        },
      ]);

      const result = await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      const medal = result.data[0].medals[0];
      expect(medal.imageUrl).toBeNull();
      expect(medal.glyph).toBe('S');
    });

    it('carries the catalogue description alongside the per-award citation', async () => {
      // Two different things that both read as "the medal's description": what
      // the medal is awarded FOR (catalogue, same for every holder) and why
      // THIS award was given. The profile page shows the former, so both have
      // to survive the projection under distinct names.
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      memberMedalRepo.find.mockResolvedValue([
        {
          id: 'award-3',
          memberId: 'member-1',
          medalId: 'medal-3',
          detail: 'Derived from their existing Discord roles',
          awardedAt: new Date('2024-05-03T00:00:00.000Z'),
          medal: {
            title: 'Marksman',
            glyph: 'M',
            imageUrl: null,
            description: 'Top 5% accuracy across three or more events.',
          },
        },
      ]);

      const medal = (await service.findAll({ page: 1, limit: 20, skip: 0 }, user())).data[0]
        .medals[0];
      expect(medal.description).toBe('Top 5% accuracy across three or more events.');
      expect(medal.detail).toBe('Derived from their existing Discord roles');
    });

    it('nulls the description rather than dropping it when the medal has none', async () => {
      // `description` is nullable in the catalogue. Coalescing to null (not
      // leaving it undefined) keeps the key in the JSON, so the client can tell
      // "no description" apart from "this build predates the field".
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      memberMedalRepo.find.mockResolvedValue([
        {
          id: 'award-4',
          memberId: 'member-1',
          medalId: 'medal-4',
          detail: null,
          awardedAt: new Date('2024-05-04T00:00:00.000Z'),
          medal: { title: 'Nameless', glyph: 'N', imageUrl: null, description: null },
        },
      ]);

      const medal = (await service.findAll({ page: 1, limit: 20, skip: 0 }, user())).data[0]
        .medals[0];
      expect(medal.description).toBeNull();
      expect('description' in medal).toBe(true);
    });

    it('orders awards by the medal cabinet, with a total-order tiebreak', async () => {
      // The roster, the profile and the dashboard all render this array
      // verbatim — no client sorts — so the ordering here IS the display order
      // (T-0212). It must be the cabinet's `precedence`, not the calendar.
      //
      // Both tiebreaks are load-bearing: precedence defaults to 0 and is not
      // unique, and medals are repeatable, so two awards of the SAME medal
      // always tie on precedence. Without `awardedAt` + `id` the roster can
      // reshuffle between two identical requests.
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      memberMedalRepo.find.mockResolvedValue([]);

      await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      expect(memberMedalRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: { medal: true },
          order: { medal: { precedence: 'ASC' }, awardedAt: 'DESC', id: 'ASC' },
        }),
      );
    });
  });

  describe('findOne', () => {
    it('returns the projection with a per-member attendance count', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      attendeeRepo.count.mockResolvedValue(2);

      const dto = await service.findOne('member-1', user());

      expect(memberRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'member-1', regimentId: REGIMENT },
        relations: { rank: true, discordIdentity: true },
      });
      expect(dto.inGameName).toBe('LC');
      expect(dto.eventsAttended).toBe(2);
    });

    it('throws NotFound when the member is missing/wrong-regiment/soft-deleted', async () => {
      memberRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('missing', user())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateSelf', () => {
    it('forbids editing another member’s profile', async () => {
      await expect(
        service.updateSelf('member-2', { inGameName: 'X' }, user({ memberId: 'member-1' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('applies only provided fields and returns the updated projection', async () => {
      const member = buildMember();
      memberRepo.findOne.mockResolvedValue(member);
      memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
      attendeeRepo.count.mockResolvedValue(3);

      const dto = await service.updateSelf(
        'member-1',
        { inGameName: 'NewIGN' },
        user({ memberId: 'member-1' }),
      );

      const saved = memberRepo.save.mock.calls[0][0] as Member;
      expect(saved.inGameName).toBe('NewIGN');
      // Untouched fields are preserved.
      expect(saved.avatarUrl).toBe('https://cdn/a.png');
      // Self edits emit no audit row.
      expect(audit.record).not.toHaveBeenCalled();
      expect(dto.inGameName).toBe('NewIGN');
      expect(dto.eventsAttended).toBe(3);
    });

    it('resolves uploaded avatar + banner keys to public URLs (T-0067)', async () => {
      const member = buildMember();
      memberRepo.findOne.mockResolvedValue(member);
      memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
      attendeeRepo.count.mockResolvedValue(0);

      await service.updateSelf(
        'member-1',
        {
          avatarKey: 'members/reg/member-1/avatar/a1.png',
          bannerKey: 'members/reg/member-1/banner/b1.png',
        },
        user({ memberId: 'member-1' }),
      );

      expect(storage.resolveKeyToPublicUrl).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: 'member-1' }),
        'members/reg/member-1/avatar/a1.png',
        StorageTarget.MemberAvatar,
      );
      expect(storage.resolveKeyToPublicUrl).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: 'member-1' }),
        'members/reg/member-1/banner/b1.png',
        StorageTarget.MemberBanner,
      );
      const saved = memberRepo.save.mock.calls[0][0] as Member;
      expect(saved.avatarUrl).toBe('https://cdn.example/members/reg/member-1/avatar/a1.png');
      expect(saved.bannerUrl).toBe('https://cdn.example/members/reg/member-1/banner/b1.png');
    });

    it('throws NotFound when the authenticated member no longer exists', async () => {
      memberRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateSelf('member-1', { inGameName: 'X' }, user({ memberId: 'member-1' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('admin actions', () => {
    // A non-owner Admin acting on somebody else — the ordinary happy path once
    // the role hierarchy is enforced (T-0176). buildMember() defaults to a
    // Member, whom an Admin strictly outranks.
    const admin = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
      user({ memberId: 'admin-1', role: MemberRole.Admin, ...overrides });

    beforeEach(() => {
      memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
      attendeeRepo.count.mockResolvedValue(0);
    });

    it('changeRank moves the member, records a service entry and an audit row', async () => {
      // A move UP the ladder (precedence 5 → 4): lower number = higher rank.
      memberRepo.findOne.mockResolvedValue(
        buildMember({ rank: { id: 'rank-1', name: 'Lieutenant', precedence: 5 } as Rank }),
      );
      rankRepo.findOne.mockResolvedValue({
        id: 'rank-9',
        name: 'Captain',
        imageUrl: 'https://cdn/captain.png',
        precedence: 4,
      });

      const dto = await service.changeRank('member-1', { rankId: 'rank-9' }, admin(), '1.2.3.4');

      expect(dto.rank).toBe('Captain');
      // The projection surfaces the new rank's insignia image URL.
      expect(dto.rankImageUrl).toBe('https://cdn/captain.png');
      expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(serviceRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'promotion' }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.rank.change', regimentId: REGIMENT }),
      );
    });

    it('changeRank records a demotion when the new rank sits lower on the ladder (T-0157)', async () => {
      // Sergeant (precedence 2) → Captain (precedence 4): a HIGHER precedence
      // number is a step DOWN, so this must not be filed as a promotion.
      memberRepo.findOne.mockResolvedValue(buildMember());
      rankRepo.findOne.mockResolvedValue({ id: 'rank-9', name: 'Captain', precedence: 4 });

      await service.changeRank(
        'member-1',
        { rankId: 'rank-9', note: 'missed three musters' },
        user({ memberId: 'moderator-1', role: MemberRole.Admin }),
        null,
      );

      // The entry still names the NEW rank and keeps the moderator's note.
      expect(serviceRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'demotion',
          event: 'Rank set to Captain',
          note: 'missed three musters',
        }),
      );
      // The audit row is unchanged by the demotion labelling.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'member.rank.change',
          before: expect.objectContaining({ rank: 'Sergeant' }),
          after: { rankId: 'rank-9', rank: 'Captain' },
        }),
      );
    });

    it('changeRank records a promotion when the member had no previous rank (T-0157)', async () => {
      // Nothing to compare against ⇒ the entry cannot claim a direction, so it
      // stays a promotion rather than being labelled a demotion by default.
      memberRepo.findOne.mockResolvedValue(buildMember({ rank: undefined }));
      rankRepo.findOne.mockResolvedValue({ id: 'rank-9', name: 'Recruit', precedence: 10 });

      await service.changeRank('member-1', { rankId: 'rank-9' }, admin(), null);

      expect(serviceRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'promotion' }),
      );
    });

    it('changeRank re-assigning the member’s current rank stays a promotion (T-0157)', async () => {
      // Equal precedence is only reachable by re-assigning the same rank (the
      // ladder is uniquely indexed on regiment+precedence); it is not a demotion.
      memberRepo.findOne.mockResolvedValue(buildMember());
      rankRepo.findOne.mockResolvedValue({ id: 'rank-1', name: 'Sergeant', precedence: 2 });

      await service.changeRank('member-1', { rankId: 'rank-1' }, admin(), null);

      expect(serviceRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'promotion' }),
      );
    });

    it('changeRank 404s when the rank is not in the regiment', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      rankRepo.findOne.mockResolvedValue(null);
      await expect(
        service.changeRank('member-1', { rankId: 'nope' }, admin(), null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('changeRole forbids assigning the Owner role', async () => {
      await expect(
        service.changeRole('member-1', { role: MemberRole.Owner }, user(), null),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('changeRole forbids granting a role ABOVE the caller’s own tier (LDA-M4)', async () => {
      // A Moderator (tier 30) may act on a Member (30 > 20), but must not be able
      // to mint a superior. The ceiling is what stops manage_roles from being a
      // self-service promotion to Admin via a second account.
      const mod = user({ memberId: 'mod-1', role: MemberRole.Moderator });
      memberRepo.findOne.mockResolvedValue(
        buildMember({ id: 'member-9', role: MemberRole.Member }),
      );
      await expect(
        service.changeRole('member-9', { role: MemberRole.Admin }, mod, null),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it('changeRole lets a manage_roles holder appoint their own tier (T-0203)', async () => {
      // The point of the relaxation: an Admin can add another Admin, a Moderator
      // another Moderator. Only the capability gate (the controller) and the
      // target hierarchy stand in the way — the ceiling no longer does.
      memberRepo.findOne.mockResolvedValue(
        buildMember({ id: 'member-9', role: MemberRole.Member }),
      );

      const dto = await service.changeRole(
        'member-9',
        { role: MemberRole.Admin },
        admin(),
        '1.2.3.4',
      );

      expect(dto.role).toBe(MemberRole.Admin);
      expect(memberRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'member.role.change',
          after: { role: MemberRole.Admin },
        }),
      );
      expect(sessionContext.invalidate).toHaveBeenCalledTimes(1);
      // An app-level role maps onto ONE Discord role — the Membership role
      // (T-0209). Anything wider was how a promotion stripped a member's medals.
      expect(discordSync.enqueueMembershipRoleSync).toHaveBeenCalledTimes(1);
      expect(discordSync.enqueueScopedRoleSync).not.toHaveBeenCalled();
      expect(discordSync.enqueueRoleGrant).not.toHaveBeenCalled();
    });

    it('changeRole peer appointment is one-way: the new peer is then untouchable (T-0203)', async () => {
      // Appointing a peer is additive; moderating one is not. An Admin who has
      // just raised somebody to Admin cannot demote them back — only the Owner
      // can — so the grant widens the command without letting one seat holder
      // hollow it out.
      memberRepo.findOne.mockResolvedValue(buildMember({ id: 'member-9', role: MemberRole.Admin }));

      await expect(
        service.changeRole('member-9', { role: MemberRole.Member }, admin(), null),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(memberRepo.save).not.toHaveBeenCalled();
    });

    it("changeRole forbids changing the regiment owner's role", async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ id: 'owner-member' }));
      await expect(
        service.changeRole('owner-member', { role: MemberRole.Member }, user(), null),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('changeRole is a no-op when the new role matches the current role (T-0101)', async () => {
      // buildMember defaults to MemberRole.Member, so assigning Member is a no-op.
      memberRepo.findOne.mockResolvedValue(buildMember());

      const dto = await service.changeRole('member-1', { role: MemberRole.Member }, admin(), null);

      // Projection is still returned, but nothing security-relevant is written.
      expect(dto.role).toBe(MemberRole.Member);
      expect(memberRepo.save).not.toHaveBeenCalled();
      expect(serviceRecordRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(sessionContext.invalidate).not.toHaveBeenCalled();
      expect(discordSync.enqueueScopedRoleSync).not.toHaveBeenCalled();
      expect(discordSync.enqueueMembershipRoleSync).not.toHaveBeenCalled();
      expect(discordSync.enqueueRoleGrant).not.toHaveBeenCalled();
    });

    it('changeRole applies a real change and records service/audit + invalidation + role sync', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());

      const dto = await service.changeRole(
        'member-1',
        { role: MemberRole.Admin },
        user({ memberId: 'owner-member', role: MemberRole.Owner }),
        '1.2.3.4',
      );

      expect(dto.role).toBe(MemberRole.Admin);
      expect(memberRepo.save).toHaveBeenCalledTimes(1);
      expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.role.change', regimentId: REGIMENT }),
      );
      expect(sessionContext.invalidate).toHaveBeenCalledTimes(1);
      // An app-level role maps onto ONE Discord role — the Membership role
      // (T-0209). Anything wider was how a promotion stripped a member's medals.
      expect(discordSync.enqueueMembershipRoleSync).toHaveBeenCalledTimes(1);
      expect(discordSync.enqueueScopedRoleSync).not.toHaveBeenCalled();
      expect(discordSync.enqueueRoleGrant).not.toHaveBeenCalled();
    });

    it('awardMedal inserts a member_medal row and audits medal.award', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      medalRepo.findOne.mockResolvedValue({ id: 'medal-1', title: 'Valor' });

      await service.awardMedal('member-1', { medalId: 'medal-1' }, admin(), null);

      expect(memberMedalRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'medal.award' }));
    });

    /**
     * T-0204 — the repair button. What matters is not that it writes, but WHAT
     * IT REFUSES TO WRITE: it may raise a rank and never lower one, it may add a
     * medal and never take one away, and pressing it twice must cost nothing.
     */
    describe('deriveFromDiscord (T-0204)', () => {
      /** A guild read that found `rank` and `medals`. */
      const found = (rank: Partial<Rank> | null, medals: Partial<Medal>[] = []) =>
        roleAdoption.readGuildState.mockResolvedValue({ ok: true, state: { rank, medals } });

      /** A linked member — the only kind there is anything to read for. */
      const linked = (overrides: Partial<Member> = {}): Member =>
        buildMember({
          discordIdentity: { discordTag: '@commander', discordUserId: 'discord-9' },
          ...overrides,
        } as Partial<Member>);

      it('adopts the rank and awards the medals, recording service entries + audit + sync', async () => {
        memberRepo.findOne.mockResolvedValue(
          // LINKED, so the enqueues below carry a real snowflake — a derive on an
          // unlinked member no-ops in the enqueuer and would assert nothing.
          linked({
            rank: {
              id: 'rank-1',
              name: 'Corporal',
              precedence: 7,
              discordRoleId: 'role-corporal',
            } as Rank,
          }),
        );
        found({ id: 'rank-9', name: 'Sergeant', precedence: 6, discordRoleId: 'role-sergeant' }, [
          { id: 'medal-1', title: 'Medal of Valor' },
          { id: 'medal-2', title: "Marksman's Cross" },
        ]);

        const result = await service.deriveFromDiscord('member-1', admin(), '1.2.3.4');

        expect(result.rank).toBe('Sergeant');
        expect(result.medals).toEqual(['Medal of Valor', "Marksman's Cross"]);
        // The projection reports the member as they now stand, not as they were.
        expect(result.member.rank).toBe('Sergeant');
        expect(result.summary).toBe(
          "Derived from Discord: LC promoted to Sergeant and awarded Medal of Valor, Marksman's Cross.",
        );
        // Every write goes through the transaction manager's repo — one rank
        // update, two awards, and a service-record entry for each of the three.
        expect(txRepo.update).toHaveBeenCalledWith({ id: 'member-1' }, { rankId: 'rank-9' });
        expect(txRepo.save).toHaveBeenCalledTimes(5);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'member.derive_from_discord',
            before: { rank: 'Corporal', medalCount: 0 },
            after: { rank: 'Sergeant', medalCount: 2 },
          }),
        );
        // The member wears their OLD rank role in the guild, so the rank roles
        // are converged as a two-id swap; everything the derive ADOPTED is
        // granted. Neither can strip a role the roster declined to adopt
        // (T-0209) — which the destructive reconcile this replaced did.
        expect(discordSync.enqueueScopedRoleSync).toHaveBeenCalledWith(
          REGIMENT,
          'member-1',
          'discord-9',
          ['role-corporal', 'role-sergeant'],
        );
        expect(discordSync.enqueueRoleGrant).toHaveBeenCalledTimes(1);
      });

      it("uses the member's CURRENT rank as the floor, so a derive can never demote", async () => {
        memberRepo.findOne.mockResolvedValue(
          linked({ rank: { id: 'rank-1', name: 'Major', precedence: 3 } as Rank }),
        );

        await service.deriveFromDiscord('member-1', admin(), null);

        // The floor is passed to the reader, which is where the comparison lives
        // (a rank must STRICTLY outrank it — precedence 1 is the top).
        expect(roleAdoption.readGuildState).toHaveBeenCalledWith(REGIMENT, 'discord-9', 3);
      });

      it('gives a rankless member no floor at all, so any linked rank qualifies', async () => {
        memberRepo.findOne.mockResolvedValue(linked({ rank: null as unknown as Rank }));

        await service.deriveFromDiscord('member-1', admin(), null);

        expect(roleAdoption.readGuildState).toHaveBeenCalledWith(
          REGIMENT,
          'discord-9',
          Number.POSITIVE_INFINITY,
        );
      });

      it('skips medals the member already holds, so a second press awards nothing twice', async () => {
        memberRepo.findOne.mockResolvedValue(buildMember());
        memberMedalRepo.find.mockResolvedValue([{ medalId: 'medal-1' }]);
        found(null, [
          { id: 'medal-1', title: 'Medal of Valor' },
          { id: 'medal-2', title: "Marksman's Cross" },
        ]);

        const result = await service.deriveFromDiscord('member-1', admin(), null);

        expect(result.medals).toEqual(["Marksman's Cross"]);
        // One award + its service-record entry. The medal they already had is
        // not re-awarded, and its role is not treated as new evidence.
        expect(txRepo.save).toHaveBeenCalledTimes(2);
      });

      it('reports finding nothing as a success that writes nothing at all', async () => {
        memberRepo.findOne.mockResolvedValue(buildMember());
        memberMedalRepo.find.mockResolvedValue([{ medalId: 'medal-1' }]);
        found(null, [{ id: 'medal-1', title: 'Medal of Valor' }]);

        const result = await service.deriveFromDiscord('member-1', admin(), null);

        expect(result.rank).toBeNull();
        expect(result.medals).toEqual([]);
        expect(result.summary).toContain('Nothing to derive');
        // A no-op leaves no trace: no transaction writes, no timeline entry, no
        // audit row, and no sync job for a member whose state did not change.
        expect(txRepo.update).not.toHaveBeenCalled();
        expect(txRepo.save).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(discordSync.enqueueScopedRoleSync).not.toHaveBeenCalled();
        expect(discordSync.enqueueMembershipRoleSync).not.toHaveBeenCalled();
        expect(discordSync.enqueueRoleGrant).not.toHaveBeenCalled();
      });

      /**
       * A failed READ is not "they had nothing" — each reason is a different
       * thing for the admin to go and do, and none of them may write.
       */
      it.each([
        ['not-linked', ConflictException, 'has not linked a Discord account'],
        ['bot-disabled', ConflictException, 'Discord bot is switched off'],
        ['not-in-guild', ConflictException, "is not in the regiment's Discord server"],
        ['unreachable', ServiceUnavailableException, 'Could not reach Discord'],
      ] as const)(
        'reports a %s read rather than writing nothing quietly',
        async (reason, expected, message) => {
          memberRepo.findOne.mockResolvedValue(buildMember());
          roleAdoption.readGuildState.mockResolvedValue({ ok: false, reason });

          await expect(service.deriveFromDiscord('member-1', admin(), null)).rejects.toMatchObject({
            constructor: expected,
            message: expect.stringContaining(message),
          });

          expect(txRepo.save).not.toHaveBeenCalled();
          expect(audit.record).not.toHaveBeenCalled();
          expect(discordSync.enqueueScopedRoleSync).not.toHaveBeenCalled();
          expect(discordSync.enqueueMembershipRoleSync).not.toHaveBeenCalled();
          expect(discordSync.enqueueRoleGrant).not.toHaveBeenCalled();
        },
      );

      it('reads Discord only AFTER the member has been resolved in this regiment', async () => {
        // The guild must not be touched on the way to a rejection — a derive that
        // is going to fail is not an excuse to go asking Discord about somebody.
        // This used to be proved with the self refusal, which T-0211 removed;
        // the out-of-regiment 404 is the rejection that remains.
        memberRepo.findOne.mockResolvedValue(null);

        await expect(service.deriveFromDiscord('nobody-1', admin(), null)).rejects.toBeInstanceOf(
          NotFoundException,
        );

        expect(roleAdoption.readGuildState).not.toHaveBeenCalled();
      });
    });

    it('removeMedal 404s when the member holds no such medal', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      memberMedalRepo.findOne.mockResolvedValue(null);
      await expect(
        service.removeMedal('member-1', 'medal-1', admin(), null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('suspend rejects a non-future date', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      await expect(
        service.suspend('member-1', { until: '2000-01-01T00:00:00.000Z' }, user(), null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('suspend sets suspendedUntil + audits when the date is in the future', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      const until = new Date(Date.now() + 86_400_000).toISOString();
      await service.suspend('member-1', { until, reason: 'cooldown' }, admin(), '9.9.9.9');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.suspend' }),
      );
    });

    it('ban refuses the regiment owner', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ id: 'owner-member' }));
      await expect(service.ban('owner-member', {}, user(), null)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ban marks bannedAt + Inactive and audits member.ban', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ bannedAt: null }));
      const dto = await service.ban('member-1', { reason: 'grief' }, admin(), null);
      expect(dto.bannedAt).not.toBeNull();
      expect(dto.status).toBe(MemberStatus.Inactive);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.ban' }));
    });

    it('unban conflicts when the member is not banned', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ bannedAt: null }));
      await expect(service.unban('member-1', admin(), null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unsuspend refuses the regiment owner', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ id: 'owner-member' }));
      await expect(service.unsuspend('owner-member', user(), null)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('unsuspend conflicts when the member is not currently suspended', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ suspendedUntil: null }));
      await expect(service.unsuspend('member-1', admin(), null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unsuspend conflicts when the suspension has already elapsed', async () => {
      memberRepo.findOne.mockResolvedValue(
        buildMember({ suspendedUntil: new Date(Date.now() - 86_400_000) }),
      );
      await expect(service.unsuspend('member-1', admin(), null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unsuspend clears suspendedUntil + records service/audit when actively suspended', async () => {
      memberRepo.findOne.mockResolvedValue(
        buildMember({ suspendedUntil: new Date(Date.now() + 86_400_000) }),
      );
      const dto = await service.unsuspend('member-1', admin(), '9.9.9.9');
      expect(dto.suspendedUntil).toBeNull();
      expect(memberRepo.save).toHaveBeenCalledTimes(1);
      expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.unsuspend', regimentId: REGIMENT }),
      );
    });

    // A non-owner moderator holding manage_roles is the real exposure: the owner
    // guard does not cover them, so nothing else stops them locking themselves
    // out of the seat they hold (T-0150).
    describe('self-moderation guard (T-0150)', () => {
      const moderator = () => user({ memberId: 'moderator-1', role: MemberRole.Admin });
      const self = () => buildMember({ id: 'moderator-1', role: MemberRole.Admin });

      it('a moderator cannot suspend themselves, and the rejection writes no audit row', async () => {
        memberRepo.findOne.mockResolvedValue(self());
        const until = new Date(Date.now() + 86_400_000).toISOString();

        await expect(
          service.suspend('moderator-1', { until }, moderator(), null),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(memberRepo.save).not.toHaveBeenCalled();
        expect(serviceRecordRepo.save).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(sessionContext.invalidateSessions).not.toHaveBeenCalled();
      });

      it('a moderator cannot ban themselves, and the rejection writes no audit row', async () => {
        memberRepo.findOne.mockResolvedValue(self());

        await expect(service.ban('moderator-1', {}, moderator(), null)).rejects.toBeInstanceOf(
          ForbiddenException,
        );

        expect(memberRepo.save).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(discordSync.enqueueMemberBanRole).not.toHaveBeenCalled();
      });

      it('a moderator cannot demote themselves, and the rejection writes no audit row', async () => {
        memberRepo.findOne.mockResolvedValue(self());

        await expect(
          service.changeRole('moderator-1', { role: MemberRole.Member }, moderator(), null),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(memberRepo.save).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(sessionContext.invalidate).not.toHaveBeenCalled();
      });

      it('a self-targeted role change is refused even when it would have been a no-op', async () => {
        // The guard runs before the same-role short-circuit, so self-targeting
        // this endpoint always answers 403 rather than sometimes 200.
        memberRepo.findOne.mockResolvedValue(self());

        await expect(
          service.changeRole('moderator-1', { role: MemberRole.Admin }, moderator(), null),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('identifies self by member id, not by Discord id or display name', async () => {
        // Same Discord account details, different member row — still a valid
        // moderation target; matching on anything but the member id would 403.
        memberRepo.findOne.mockResolvedValue(buildMember({ bannedAt: null }));

        await service.ban(
          'member-1',
          {},
          user({ memberId: 'moderator-1', role: MemberRole.Admin, discordUserId: 'discord-1' }),
          null,
        );

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'member.ban' }),
        );
      });

      it('leaves moderation of another member fully intact', async () => {
        memberRepo.findOne.mockResolvedValue(
          buildMember({ role: MemberRole.Admin, bannedAt: null, discordIdentityId: 'identity-9' }),
        );

        await service.ban(
          'member-1',
          { reason: 'grief' },
          user({ memberId: 'owner-member', role: MemberRole.Owner }),
          null,
        );

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'member.ban' }),
        );
        expect(sessionContext.invalidateSessions).toHaveBeenCalledWith('identity-9');
        expect(discordSync.enqueueMemberBanRole).toHaveBeenCalledTimes(1);
      });
    });

    // The capability guard on the controller knows the caller's ROLE but never
    // the target, so before T-0176 nothing stopped an Admin from demoting the
    // Owner or a Moderator from banning an Admin.
    //
    // The cases below are stated per FAMILY (T-0211). All three refusals belong
    // to the five moderation actions; the four rank/medal ones have no target
    // rule at all, so each "cannot" case has a "but may decorate" twin —
    // including on the caller's own record. A case that still fans over all nine
    // actions (Moderator→Member, Owner→Admin) is asserting something the split
    // did not touch, and is the evidence nothing was over-relaxed or
    // over-tightened.
    describe('role hierarchy guard (T-0176, split in T-0211)', () => {
      /**
       * A target whose state would otherwise let every action through — banned
       * AND actively suspended — so a refusal can only be the authorization
       * guard, never an incidental 409, and so the guard is proven to run
       * BEFORE the action's own state checks.
       */
      const moderatable = (overrides: Partial<Member>): Member =>
        buildMember({
          bannedAt: new Date('2024-01-01T00:00:00.000Z'),
          suspendedUntil: new Date(Date.now() + 86_400_000),
          ...overrides,
        });

      /** Asserts the refusal AND that the rejected action left no trace at all. */
      const expectRefusedWithoutTrace = async (
        action: MemberAdminAction,
        actor: AuthenticatedUser,
        target: Member,
      ): Promise<void> => {
        memberRepo.findOne.mockResolvedValue(target);

        await expect(invokeAction[action](actor, target.id)).rejects.toBeInstanceOf(
          ForbiddenException,
        );

        expect(memberRepo.save).not.toHaveBeenCalled();
        expect(memberMedalRepo.save).not.toHaveBeenCalled();
        expect(memberMedalRepo.remove).not.toHaveBeenCalled();
        expect(serviceRecordRepo.save).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(sessionContext.invalidate).not.toHaveBeenCalled();
        expect(sessionContext.invalidateSessions).not.toHaveBeenCalled();
        expect(discordSync.enqueueRoleGrant).not.toHaveBeenCalled();
        expect(discordSync.enqueueScopedRoleSync).not.toHaveBeenCalled();
        expect(discordSync.enqueueMembershipRoleSync).not.toHaveBeenCalled();
        expect(discordSync.enqueueMemberBanRole).not.toHaveBeenCalled();
      };

      /** The mirror of {@link expectRefusedWithoutTrace}: the guard let it past. */
      const expectPermitted = async (
        action: MemberAdminAction,
        actor: AuthenticatedUser,
        target: Member,
      ): Promise<void> => {
        memberRepo.findOne.mockResolvedValue(target);

        // Only the AUTHORIZATION verdict is under test — the action's own state
        // checks (an unstubbed rank lookup 404s, a derive finds nothing) are not
        // refusals of the actor. `wasForbidden` draws exactly that line.
        const cell = `${action} on ${target.role} ${target.id}`;
        expect(
          `${cell}: refused=${await wasForbidden(invokeAction[action](actor, target.id))}`,
        ).toBe(`${cell}: refused=false`);
      };

      it.each(MODERATION_ACTIONS)('an Admin cannot %s the regiment owner', async (action) => {
        await expectRefusedWithoutTrace(
          action,
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          moderatable({ id: 'owner-member', role: MemberRole.Owner }),
        );
      });

      // The owner pointer guards the SEAT, not the service record. Awarding the
      // owner a medal takes nothing from anyone, so the regiment's record-keeper
      // is not blocked from writing down what the owner did (T-0211).
      it.each(DECORATION_ACTIONS)('but an Admin may %s the regiment owner', async (action) => {
        await expectPermitted(
          action,
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          moderatable({ id: 'owner-member', role: MemberRole.Owner }),
        );
      });

      it.each(MODERATION_ACTIONS)('a Moderator cannot %s an Admin', async (action) => {
        await expectRefusedWithoutTrace(
          action,
          user({ memberId: 'moderator-1', role: MemberRole.Moderator }),
          moderatable({ id: 'admin-9', role: MemberRole.Admin }),
        );
      });

      // The case T-0211 exists for: a Moderator trusted with edit_ranks_medals
      // was refused against every peer and superior on the roster, which is most
      // of the people whose promotions are worth recording.
      it.each(DECORATION_ACTIONS)('but a Moderator may %s an Admin', async (action) => {
        await expectPermitted(
          action,
          user({ memberId: 'moderator-1', role: MemberRole.Moderator }),
          moderatable({ id: 'admin-9', role: MemberRole.Admin }),
        );
      });

      // Peers do not moderate peers: only the Owner may act on an Admin. Two
      // Admins who fall out must not be able to demote each other.
      it.each(MODERATION_ACTIONS)('an Admin cannot %s a peer Admin', async (action) => {
        await expectRefusedWithoutTrace(
          action,
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          moderatable({ id: 'admin-9', role: MemberRole.Admin }),
        );
      });

      it.each(DECORATION_ACTIONS)('but an Admin may %s a peer Admin', async (action) => {
        await expectPermitted(
          action,
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          moderatable({ id: 'admin-9', role: MemberRole.Admin }),
        );
      });

      // T-0150: nobody moderates their own account. T-0176 briefly extended it
      // to rank and medals; T-0211 took that back out on the owner's decision.
      it.each(MODERATION_ACTIONS)('an Admin cannot %s their own account', async (action) => {
        await expectRefusedWithoutTrace(
          action,
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          moderatable({ id: 'admin-1', role: MemberRole.Admin }),
        );
      });

      // ⚠️ The self-promotion path, permitted deliberately (T-0211). Recorded as
      // a test so it is a decision somebody made rather than a guard somebody
      // forgot: an edit_ranks_medals holder may set their own rank, pin their own
      // medal, and — the sharp one — derive their own record, which credits
      // whatever their own Discord roles say they have earned.
      it.each(DECORATION_ACTIONS)('but an Admin may %s their own account', async (action) => {
        await expectPermitted(
          action,
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          moderatable({ id: 'admin-1', role: MemberRole.Admin }),
        );
      });

      it.each(MEMBER_ADMIN_ACTIONS)('a Moderator may %s a Member', async (action) => {
        memberRepo.findOne.mockResolvedValue(moderatable({ id: 'member-9' }));

        const refused = await wasForbidden(
          invokeAction[action](
            user({ memberId: 'moderator-1', role: MemberRole.Moderator }),
            'member-9',
          ),
        );

        expect(refused).toBe(false);
      });

      it.each(MEMBER_ADMIN_ACTIONS)('the Owner may %s an Admin', async (action) => {
        memberRepo.findOne.mockResolvedValue(
          moderatable({ id: 'admin-9', role: MemberRole.Admin }),
        );

        const refused = await wasForbidden(
          invokeAction[action](
            user({ memberId: 'owner-member', role: MemberRole.Owner }),
            'admin-9',
          ),
        );

        expect(refused).toBe(false);
      });

      it('reads the owner pointer once per action, not once per guard and again per projection', async () => {
        memberRepo.findOne.mockResolvedValue(buildMember({ id: 'member-9', bannedAt: null }));

        await service.ban(
          'member-9',
          {},
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          null,
        );

        // The guard hands its read to the projection that follows the write.
        expect(regimentRepo.findOne).toHaveBeenCalledTimes(1);
      });

      // The decoration half no longer NEEDS the owner pointer to decide anything,
      // which is exactly why the read looks removable. The projection still needs
      // it: drop it here and every rank change re-reads `regiments` — or worse,
      // projects flags against a second read that could differ (T-0211).
      it('still reads it once on a decoration action, where the guard no longer uses it', async () => {
        memberRepo.findOne.mockResolvedValue(buildMember({ id: 'member-9' }));
        rankRepo.findOne.mockResolvedValue({ id: 'rank-9', name: 'Captain', precedence: 1 });
        memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
        attendeeRepo.count.mockResolvedValue(0);

        await service.changeRank(
          'member-9',
          { rankId: 'rank-9' },
          user({ memberId: 'admin-1', role: MemberRole.Admin }),
          null,
        );

        expect(regimentRepo.findOne).toHaveBeenCalledTimes(1);
      });

      // "Permitted" proven by a WRITE, not merely by the absence of a 403: the
      // relaxed path has to land a rank on the row, a service-record entry and an
      // audit row, exactly as it does for a junior target.
      it('a decoration against a superior leaves its full trace, not a silent no-op', async () => {
        memberRepo.findOne.mockResolvedValue(
          buildMember({ id: 'owner-member', role: MemberRole.Owner }),
        );
        rankRepo.findOne.mockResolvedValue({ id: 'rank-9', name: 'Colonel', precedence: 1 });
        memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
        attendeeRepo.count.mockResolvedValue(0);

        await service.changeRank(
          'owner-member',
          { rankId: 'rank-9' },
          user({ memberId: 'moderator-1', role: MemberRole.Moderator }),
          null,
        );

        expect(memberRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'owner-member', rankId: 'rank-9' }),
        );
        expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'member.rank.change' }),
        );
      });

      it('and an award against a superior is a real award', async () => {
        memberRepo.findOne.mockResolvedValue(
          buildMember({ id: 'admin-9', role: MemberRole.Admin }),
        );
        medalRepo.findOne.mockResolvedValue({ id: 'medal-1', title: 'Valour' });
        attendeeRepo.count.mockResolvedValue(0);

        await service.awardMedal(
          'admin-9',
          { medalId: 'medal-1' },
          user({ memberId: 'moderator-1', role: MemberRole.Moderator }),
          null,
        );

        expect(memberMedalRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ memberId: 'admin-9', medalId: 'medal-1' }),
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'medal.award' }),
        );
      });

      // Mercenary sits strictly BELOW Member on the ladder (a mercenary rides
      // along with the regiment but is not one of its members), so the rule is
      // asymmetric in exactly that direction.
      it('a Member may act on a Mercenary but not the other way round', async () => {
        expect(ROLE_PRECEDENCE[MemberRole.Member]).toBeGreaterThan(
          ROLE_PRECEDENCE[MemberRole.Mercenary],
        );

        memberRepo.findOne.mockResolvedValue(
          moderatable({ id: 'merc-1', role: MemberRole.Mercenary }),
        );
        expect(
          await wasForbidden(
            invokeAction.ban(user({ memberId: 'member-9', role: MemberRole.Member }), 'merc-1'),
          ),
        ).toBe(false);

        memberRepo.findOne.mockResolvedValue(
          moderatable({ id: 'member-9', role: MemberRole.Member }),
        );
        expect(
          await wasForbidden(
            invokeAction.ban(user({ memberId: 'merc-1', role: MemberRole.Mercenary }), 'member-9'),
          ),
        ).toBe(true);
      });
    });
  });

  /**
   * T-0177: the flags on the projection and the guard the endpoints enforce are
   * the SAME verdict. This walks the whole (actor role × target × capability)
   * space and, for every action, compares the advertised flag against what the
   * service actually does — so a permitted flag can never accompany a 403, nor
   * a 403 a permitted flag.
   */
  describe('permittedActions on the projection (T-0177)', () => {
    const ROLES = Object.values(MemberRole);
    const CAPABILITY_SETS = [
      { label: 'both capabilities', held: [Capability.ManageRoles, Capability.EditRanksMedals] },
      { label: 'only edit_ranks_medals', held: [Capability.EditRanksMedals] },
      { label: 'no capabilities', held: [] },
    ];
    // The three target identities the rule distinguishes: an unrelated member,
    // the regiment owner pointer, and the caller themselves.
    const TARGET_IDS = ['target-1', 'owner-member', 'actor-1'];

    beforeEach(() => {
      memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
      attendeeRepo.count.mockResolvedValue(0);
    });

    it.each(ROLES)('a caller with role %s sees flags that match the guard', async (actorRole) => {
      const actor = user({ memberId: 'actor-1', role: actorRole });

      for (const capabilities of CAPABILITY_SETS) {
        const held = new Set<string>(capabilities.held);
        authz.can.mockImplementation((_regimentId: string, _role: MemberRole, capability: string) =>
          Promise.resolve(held.has(capability)),
        );

        for (const targetRole of ROLES) {
          for (const targetId of TARGET_IDS) {
            memberRepo.findOne.mockResolvedValue(buildMember({ id: targetId, role: targetRole }));
            const projected = await service.findOne(targetId, actor);

            for (const action of MEMBER_ADMIN_ACTIONS) {
              // Banned AND actively suspended, so nothing but the authorization
              // guard can refuse the action.
              memberRepo.findOne.mockResolvedValue(
                buildMember({
                  id: targetId,
                  role: targetRole,
                  bannedAt: new Date('2024-01-01T00:00:00.000Z'),
                  suspendedUntil: new Date(Date.now() + 86_400_000),
                }),
              );
              const refused = await wasForbidden(invokeAction[action](actor, targetId));
              const expected = !refused && held.has(ACTION_CAPABILITY[action]);
              // Compared as a labelled string so a failure names the exact cell.
              const cell = `${actorRole} → ${targetRole} (${targetId}), ${capabilities.label}, ${action}`;
              expect(`${cell}: ${projected.permittedActions[action]}`).toBe(`${cell}: ${expected}`);
            }
          }
        }
      }
    });

    it('reads the regiment owner pointer once per list page, not once per row', async () => {
      authz.can.mockResolvedValue(true);
      memberQb.getManyAndCount.mockResolvedValue([
        [buildMember({ id: 'row-1' }), buildMember({ id: 'row-2' }), buildMember({ id: 'row-3' })],
        3,
      ]);

      const page = await service.findAll(
        { page: 1, limit: 20, skip: 0 },
        user({ memberId: 'owner-member', role: MemberRole.Owner }),
      );

      expect(page.data).toHaveLength(3);
      expect(page.data[0].permittedActions.ban).toBe(true);
      // The flags must not reintroduce an N+1: one owner-pointer read for the
      // whole page, and the memoised capability lookups are asked once each.
      expect(regimentRepo.findOne).toHaveBeenCalledTimes(1);
      expect(authz.can).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * Owner decision, restated when the role hierarchy landed (T-0176): account
   * deletion is SELF-ONLY. The hierarchy governs moderation, and deliberately
   * does NOT open an admin-on-behalf deletion path — erasure is the data
   * subject's right, not a moderation tool, and it destroys the target's
   * Discord identity irreversibly. Admins remove people with ban/suspend.
   */
  describe('account deletion stays self-only (T-0176)', () => {
    it('exposes no deletion entry point that accepts a target member id', () => {
      const deletionMethods = Object.getOwnPropertyNames(MembersService.prototype)
        .filter((name) => /deletion/i.test(name))
        .sort();

      // Adding e.g. `deleteMemberAccount(id, user)` breaks this deliberately.
      expect(deletionMethods).toEqual([
        'cancelSelfDeletion',
        'confirmSelfDeletion',
        'executeSelfDeletion',
        'requestSelfDeletion',
      ]);
      // ...and each one's first parameter is the CALLER, never a member id.
      expect(service.requestSelfDeletion.length).toBe(3);
      expect(service.confirmSelfDeletion.length).toBe(2);
      expect(service.executeSelfDeletion.length).toBe(2);
      expect(service.cancelSelfDeletion.length).toBe(2);
    });

    it('executes against the caller’s own member id even when the caller is the Owner', async () => {
      deletionRepo.findOne.mockResolvedValue({
        id: 'req-1',
        memberId: 'owner-member',
        status: AccountDeletionStatus.Confirmed,
        executedAt: null as Date | null,
      });
      deletionRepo.save.mockImplementation((r: unknown) => Promise.resolve(r));
      memberRepo.findOne.mockResolvedValue(buildMember({ id: 'owner-member' }));

      await service.executeSelfDeletion(
        user({ memberId: 'owner-member', role: MemberRole.Owner }),
        null,
      );

      // Both lookups are keyed off the session's member id — there is no
      // parameter through which another member could be named.
      expect(deletionRepo.findOne).toHaveBeenCalledWith({
        where: { memberId: 'owner-member', status: AccountDeletionStatus.Confirmed },
      });
      expect(memberRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'owner-member', regimentId: REGIMENT },
        relations: { rank: true, discordIdentity: true },
      });
    });
  });

  describe('getServiceRecord (self-OR-admin gate, T-0101)', () => {
    beforeEach(() => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      serviceRecordRepo.find.mockResolvedValue([]);
    });

    it('allows a member to read their own record without a capability check', async () => {
      const result = await service.getServiceRecord('member-1', user({ memberId: 'member-1' }));

      expect(result).toEqual([]);
      expect(authz.can).not.toHaveBeenCalled();
    });

    it('allows another caller who holds view_audit_log', async () => {
      authz.can.mockResolvedValue(true);

      const result = await service.getServiceRecord(
        'member-1',
        user({ memberId: 'other-member', role: MemberRole.Admin }),
      );

      expect(result).toEqual([]);
      expect(authz.can).toHaveBeenCalledWith(REGIMENT, MemberRole.Admin, Capability.ViewAuditLog);
    });

    it('forbids another caller lacking view_audit_log', async () => {
      authz.can.mockResolvedValue(false);

      await expect(
        service.getServiceRecord('member-1', user({ memberId: 'other-member' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(serviceRecordRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('getEvents / getRsvps (per-member tabs, T-0100)', () => {
    it('getEvents loads the member then delegates to EventsService.listAttendedByMember', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      const events = [{ id: 'event-1' }] as never;
      eventsService.listAttendedByMember.mockResolvedValue(events);

      const caller = user();
      const result = await service.getEvents('member-1', caller);

      expect(result).toBe(events);
      expect(eventsService.listAttendedByMember).toHaveBeenCalledWith(caller, 'member-1');
    });

    it('getEvents 404s when the member is not in the caller regiment', async () => {
      memberRepo.findOne.mockResolvedValue(null);
      await expect(service.getEvents('missing', user())).rejects.toBeInstanceOf(NotFoundException);
      expect(eventsService.listAttendedByMember).not.toHaveBeenCalled();
    });

    it('getRsvps loads the member then delegates to EventsService.listRsvpsByMember', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      const events = [{ id: 'event-2' }] as never;
      eventsService.listRsvpsByMember.mockResolvedValue(events);

      const caller = user();
      const result = await service.getRsvps('member-1', caller);

      expect(result).toBe(events);
      expect(eventsService.listRsvpsByMember).toHaveBeenCalledWith(caller, 'member-1');
    });
  });

  describe('GDPR', () => {
    it('requestSelfDeletion requires both acknowledgements', async () => {
      await expect(
        service.requestSelfDeletion(
          user({ memberId: 'member-1' }),
          { acknowledgePermanent: true, acknowledgeDataDownloaded: false },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requestSelfDeletion creates a pending request + audit row', async () => {
      deletionRepo.findOne.mockResolvedValue(null);
      deletionRepo.save.mockImplementation((r: Record<string, unknown>) =>
        Promise.resolve({ ...r, id: 'req-1' }),
      );
      const res = await service.requestSelfDeletion(
        user({ memberId: 'member-1' }),
        { acknowledgePermanent: true, acknowledgeDataDownloaded: true },
        null,
      );
      expect(res.requestId).toBe('req-1');
      expect(res.confirmToken).toEqual(expect.any(String));
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.deletion.request' }),
      );
    });

    it('confirmSelfDeletion transitions a pending request to Confirmed', async () => {
      const request = {
        id: 'req-1',
        memberId: 'member-1',
        status: AccountDeletionStatus.PendingDiscordConfirmation,
        confirmedAt: null as Date | null,
        discordReauthenticatedAt: null as Date | null,
      };
      deletionRepo.findOne.mockResolvedValue(request);
      deletionRepo.save.mockImplementation((r: unknown) => Promise.resolve(r));

      const res = await service.confirmSelfDeletion(user({ memberId: 'member-1' }), {
        token: 'tok',
      });

      expect(res.status).toBe(AccountDeletionStatus.Confirmed);
      expect(request.confirmedAt).toBeInstanceOf(Date);
    });

    it('executeSelfDeletion soft-deletes + anonymises the member and marks it Executed', async () => {
      const request = {
        id: 'req-1',
        memberId: 'member-1',
        status: AccountDeletionStatus.Confirmed,
        executedAt: null as Date | null,
      };
      deletionRepo.findOne.mockResolvedValue(request);
      deletionRepo.save.mockImplementation((r: unknown) => Promise.resolve(r));
      const member = buildMember({
        discordIdentityId: 'identity-1',
        avatarUrl: 'https://cdn/a.png',
        discordIdentity: {
          discordTag: '@commander',
          email: 'x@y.z',
          accessToken: 'secret',
        } as unknown as Member['discordIdentity'],
      });
      memberRepo.findOne.mockResolvedValue(member);

      const res = await service.executeSelfDeletion(user({ memberId: 'member-1' }), '1.2.3.4');

      expect(res.status).toBe(AccountDeletionStatus.Executed);
      expect(request.executedAt).toBeInstanceOf(Date);
      // Member PII anonymised.
      expect(member.inGameName).toBe('[deleted member]');
      expect(member.avatarUrl).toBeNull();
      expect(member.discordLinked).toBe(false);
      expect(member.status).toBe(MemberStatus.Inactive);
      // Member soft-removed + linked identity HARD-deleted (durable erasure).
      expect(txRepo.softRemove).toHaveBeenCalledWith(member);
      expect(txRepo.delete).toHaveBeenCalledWith({ id: 'identity-1' });
      // Audited + sessions revoked.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.deletion.execute' }),
      );
      expect(sessionContext.invalidateSessions).toHaveBeenCalledWith('identity-1');
    });

    it('executeSelfDeletion 404s when there is no confirmed request', async () => {
      deletionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.executeSelfDeletion(user({ memberId: 'member-1' }), null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancelSelfDeletion transitions a pending/confirmed request to Cancelled', async () => {
      const request = {
        id: 'req-1',
        memberId: 'member-1',
        status: AccountDeletionStatus.Confirmed,
      };
      deletionRepo.findOne.mockResolvedValue(request);
      deletionRepo.save.mockImplementation((r: unknown) => Promise.resolve(r));

      const res = await service.cancelSelfDeletion(user({ memberId: 'member-1' }), null);

      expect(res.status).toBe(AccountDeletionStatus.Cancelled);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.deletion.cancel' }),
      );
    });

    it('cancelSelfDeletion 404s when there is no cancellable request', async () => {
      deletionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.cancelSelfDeletion(user({ memberId: 'member-1' }), null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
