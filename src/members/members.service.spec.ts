import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { SessionContextService } from '../auth/session-context.service';
import { StorageService } from '../storage/storage.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
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
    rank: { id: 'rank-1', name: 'Sergeant', chevrons: 3, precedence: 2 },
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
    save: jest.fn((x: unknown) => Promise.resolve(x)),
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
    enqueueRoleSync: jest.fn().mockResolvedValue(null),
    enqueueMemberBanRole: jest.fn().mockResolvedValue(null),
  };
  // Caller-context cache hooks (T-0046/48) — assert invalidation without a DB.
  const sessionContext = {
    invalidate: jest.fn(),
    invalidateSessions: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    resolveKeyToPublicUrl: jest.fn((_u: unknown, key: string) => `https://cdn.example/${key}`),
  };
  // Capability gate for self-OR-admin service-record reads (T-0101).
  const authz = { can: jest.fn() };
  // Per-member events/RSVP tabs delegate to the events projection machinery.
  const eventsService = {
    listAttendedByMember: jest.fn(),
    listRsvpsByMember: jest.fn(),
  };

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
        { provide: SessionContextService, useValue: sessionContext },
        { provide: StorageService, useValue: storage },
        { provide: AuthzService, useValue: authz },
        { provide: EventsService, useValue: eventsService },
      ],
    }).compile();

    service = module.get(MembersService);
  });

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
      expect(dto.chevrons).toBe(3);
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
      expect(dto.chevrons).toBe(0);
      expect(dto.rankPrecedence).toBeNull();
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
    beforeEach(() => {
      memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
      attendeeRepo.count.mockResolvedValue(0);
    });

    it('changeRank moves the member, records a service entry and an audit row', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      rankRepo.findOne.mockResolvedValue({
        id: 'rank-9',
        name: 'Captain',
        chevrons: 4,
        precedence: 4,
      });

      const dto = await service.changeRank(
        'member-1',
        { rankId: 'rank-9' },
        user({ role: MemberRole.Admin }),
        '1.2.3.4',
      );

      expect(dto.rank).toBe('Captain');
      expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.rank.change', regimentId: REGIMENT }),
      );
    });

    it('changeRank 404s when the rank is not in the regiment', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      rankRepo.findOne.mockResolvedValue(null);
      await expect(
        service.changeRank('member-1', { rankId: 'nope' }, user(), null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('changeRole forbids assigning the Owner role', async () => {
      await expect(
        service.changeRole('member-1', { role: MemberRole.Owner }, user(), null),
      ).rejects.toBeInstanceOf(ForbiddenException);
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

      const dto = await service.changeRole('member-1', { role: MemberRole.Member }, user(), null);

      // Projection is still returned, but nothing security-relevant is written.
      expect(dto.role).toBe(MemberRole.Member);
      expect(memberRepo.save).not.toHaveBeenCalled();
      expect(serviceRecordRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(sessionContext.invalidate).not.toHaveBeenCalled();
      expect(discordSync.enqueueRoleSync).not.toHaveBeenCalled();
    });

    it('changeRole applies a real change and records service/audit + invalidation + role sync', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());

      const dto = await service.changeRole(
        'member-1',
        { role: MemberRole.Admin },
        user({ role: MemberRole.Owner }),
        '1.2.3.4',
      );

      expect(dto.role).toBe(MemberRole.Admin);
      expect(memberRepo.save).toHaveBeenCalledTimes(1);
      expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.role.change', regimentId: REGIMENT }),
      );
      expect(sessionContext.invalidate).toHaveBeenCalledTimes(1);
      expect(discordSync.enqueueRoleSync).toHaveBeenCalledTimes(1);
    });

    it('awardMedal inserts a member_medal row and audits medal.award', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      medalRepo.findOne.mockResolvedValue({ id: 'medal-1', title: 'Valor' });

      await service.awardMedal('member-1', { medalId: 'medal-1' }, user(), null);

      expect(memberMedalRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'medal.award' }));
    });

    it('removeMedal 404s when the member holds no such medal', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      memberMedalRepo.findOne.mockResolvedValue(null);
      await expect(service.removeMedal('member-1', 'medal-1', user(), null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
      await service.suspend('member-1', { until, reason: 'cooldown' }, user(), '9.9.9.9');
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
      const dto = await service.ban('member-1', { reason: 'grief' }, user(), null);
      expect(dto.bannedAt).not.toBeNull();
      expect(dto.status).toBe(MemberStatus.Inactive);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.ban' }));
    });

    it('unban conflicts when the member is not banned', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember({ bannedAt: null }));
      await expect(service.unban('member-1', user(), null)).rejects.toBeInstanceOf(
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
      await expect(service.unsuspend('member-1', user(), null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unsuspend conflicts when the suspension has already elapsed', async () => {
      memberRepo.findOne.mockResolvedValue(
        buildMember({ suspendedUntil: new Date(Date.now() - 86_400_000) }),
      );
      await expect(service.unsuspend('member-1', user(), null)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unsuspend clears suspendedUntil + records service/audit when actively suspended', async () => {
      memberRepo.findOne.mockResolvedValue(
        buildMember({ suspendedUntil: new Date(Date.now() + 86_400_000) }),
      );
      const dto = await service.unsuspend('member-1', user(), '9.9.9.9');
      expect(dto.suspendedUntil).toBeNull();
      expect(memberRepo.save).toHaveBeenCalledTimes(1);
      expect(serviceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member.unsuspend', regimentId: REGIMENT }),
      );
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
