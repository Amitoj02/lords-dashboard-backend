import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { MemberRole, MemberStatus, Platform } from '../common/enums';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { RegimentEvent } from '../events/entities/event.entity';
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
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

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
});
