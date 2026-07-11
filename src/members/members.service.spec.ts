import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { MemberRole, MemberStatus, Platform } from '../common/enums';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { RegimentEvent } from '../events/entities/event.entity';
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
    name: 'Lord Commander',
    inGameName: 'LC',
    role: MemberRole.Member,
    status: MemberStatus.Active,
    platform: Platform.Steam,
    timezone: 'America/Toronto',
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
  const memberRepo = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
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

  const eventRepo = { count: jest.fn() };
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
        { provide: getRepositoryToken(RegimentEvent), useValue: eventRepo },
        { provide: getRepositoryToken(Rank), useValue: rankRepo },
        { provide: getRepositoryToken(Medal), useValue: medalRepo },
        { provide: getRepositoryToken(MemberMedal), useValue: memberMedalRepo },
        { provide: getRepositoryToken(ServiceRecordEntry), useValue: serviceRecordRepo },
        { provide: getRepositoryToken(AccountDeletionRequest), useValue: deletionRepo },
        { provide: getRepositoryToken(Regiment), useValue: regimentRepo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(MembersService);
  });

  describe('findAll', () => {
    it('scopes by regiment, applies filters, and computes derived fields + attendance rate', async () => {
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      eventRepo.count.mockResolvedValue(10); // 10 past events
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
      // Search lowercased.
      expect(memberQb.andWhere).toHaveBeenCalledWith(expect.stringContaining('LIKE :term'), {
        term: '%comm%',
      });
      // Ordered by precedence then name.
      expect(memberQb.orderBy).toHaveBeenCalledWith('rank.precedence', 'ASC');
      expect(memberQb.addOrderBy).toHaveBeenCalledWith('member.name', 'ASC');

      // Grouped attendance query was used (no N+1 .count per row).
      expect(attendeeRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(attendeeRepo.count).not.toHaveBeenCalled();

      const dto = result.data[0];
      expect(dto.rank).toBe('Sergeant');
      expect(dto.chevrons).toBe(3);
      expect(dto.rankPrecedence).toBe(2);
      expect(dto.discordTag).toBe('@commander');
      expect(dto.eventsAttended).toBe(7);
      expect(dto.attendanceRate).toBe(70); // round(7/10*100)
      expect(dto.joinedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(result.meta.total).toBe(1);
    });

    it('returns attendanceRate 0 when there are no past events', async () => {
      const member = buildMember();
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      eventRepo.count.mockResolvedValue(0);
      attendeeQb.getRawMany.mockResolvedValue([{ memberId: 'member-1', count: '5' }]);

      const result = await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      expect(result.data[0].eventsAttended).toBe(5);
      expect(result.data[0].attendanceRate).toBe(0);
    });

    it('defaults attendance to 0 for members absent from the grouped result', async () => {
      const member = buildMember({ id: 'member-2', name: 'Recruit', rank: undefined });
      memberQb.getManyAndCount.mockResolvedValue([[member], 1]);
      eventRepo.count.mockResolvedValue(4);
      attendeeQb.getRawMany.mockResolvedValue([]); // nobody attended

      const result = await service.findAll({ page: 1, limit: 20, skip: 0 }, user());

      const dto = result.data[0];
      expect(dto.eventsAttended).toBe(0);
      expect(dto.attendanceRate).toBe(0);
      // Unranked member falls back gracefully.
      expect(dto.rank).toBeNull();
      expect(dto.chevrons).toBe(0);
      expect(dto.rankPrecedence).toBeNull();
    });
  });

  describe('findOne', () => {
    it('returns the projection with a per-member attendance count', async () => {
      memberRepo.findOne.mockResolvedValue(buildMember());
      eventRepo.count.mockResolvedValue(8);
      attendeeRepo.count.mockResolvedValue(2);

      const dto = await service.findOne('member-1', user());

      expect(memberRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'member-1', regimentId: REGIMENT },
        relations: { rank: true, discordIdentity: true },
      });
      expect(dto.eventsAttended).toBe(2);
      expect(dto.attendanceRate).toBe(25); // round(2/8*100)
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
      eventRepo.count.mockResolvedValue(0);
      attendeeRepo.count.mockResolvedValue(3);

      const dto = await service.updateSelf(
        'member-1',
        { inGameName: 'NewIGN', timezone: 'UTC' },
        user({ memberId: 'member-1' }),
      );

      const saved = memberRepo.save.mock.calls[0][0] as Member;
      expect(saved.inGameName).toBe('NewIGN');
      expect(saved.timezone).toBe('UTC');
      // Untouched fields are preserved.
      expect(saved.platform).toBe(Platform.Steam);
      expect(saved.avatarUrl).toBe('https://cdn/a.png');
      // Self edits emit no audit row.
      expect(audit.record).not.toHaveBeenCalled();
      expect(dto.inGameName).toBe('NewIGN');
      expect(dto.eventsAttended).toBe(3);
    });

    it('throws NotFound when the authenticated member no longer exists', async () => {
      memberRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateSelf('member-1', { timezone: 'UTC' }, user({ memberId: 'member-1' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('admin actions', () => {
    beforeEach(() => {
      memberRepo.save.mockImplementation((m: Member) => Promise.resolve(m));
      eventRepo.count.mockResolvedValue(0);
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
  });
});
