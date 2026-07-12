import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { RanksService } from './ranks.service';
import { Rank } from './entities/rank.entity';

const REGIMENT = 'regiment-1';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Owner,
  regimentId: REGIMENT,
  ...overrides,
});

const buildRank = (overrides: Partial<Rank> = {}): Rank => ({
  id: 'rank-1',
  regimentId: REGIMENT,
  name: 'Sergeant',
  chevrons: 3,
  precedence: 2,
  discordRoleName: '@Sergeant',
  discordRoleId: null,
  linked: false,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('RanksService', () => {
  let service: RanksService;

  // Rank repository: a configurable QueryBuilder (MAX precedence) + CRUD.
  let rankQb: {
    select: jest.Mock;
    where: jest.Mock;
    getRawOne: jest.Mock;
  };
  const rankRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  // Member repository: count + grouped QueryBuilder (holder counts).
  let memberQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  const memberRepo = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const dataSource = { transaction: jest.fn() };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    rankQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
    };
    rankRepo.createQueryBuilder.mockReturnValue(rankQb);
    // Mirror TypeORM: create() yields an entity that gains id + timestamps on save.
    rankRepo.create.mockImplementation((data: Partial<Rank>) => ({
      id: 'rank-new',
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
      updatedAt: new Date('2024-02-01T00:00:00.000Z'),
      ...data,
    }));
    rankRepo.save.mockImplementation((r: Rank) => Promise.resolve(r));

    memberQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    memberRepo.createQueryBuilder.mockReturnValue(memberQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RanksService,
        { provide: getRepositoryToken(Rank), useValue: rankRepo },
        { provide: getRepositoryToken(Member), useValue: memberRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(RanksService);
  });

  describe('findAll', () => {
    it('orders by precedence and enriches each rank with a batched holder count', async () => {
      const top = buildRank({ id: 'rank-1', name: 'General', precedence: 1 });
      const bottom = buildRank({ id: 'rank-2', name: 'Recruit', precedence: 2 });
      rankRepo.find.mockResolvedValue([top, bottom]);
      // Only rank-1 has holders; rank-2 is absent from the grouped result.
      memberQb.getRawMany.mockResolvedValue([{ rankId: 'rank-1', count: '3' }]);

      const result = await service.findAll(user());

      expect(rankRepo.find).toHaveBeenCalledWith({
        where: { regimentId: REGIMENT },
        order: { precedence: 'ASC' },
      });
      // One grouped query for the whole list (no per-row N+1).
      expect(memberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(memberRepo.count).not.toHaveBeenCalled();

      expect(result[0].name).toBe('General');
      expect(result[0].holdersCount).toBe(3);
      expect(result[1].name).toBe('Recruit');
      expect(result[1].holdersCount).toBe(0);
      expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('returns an empty list without touching the members query', async () => {
      rankRepo.find.mockResolvedValue([]);
      const result = await service.findAll(user());
      expect(result).toEqual([]);
      expect(memberRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('places the rank at the end of the ladder when precedence is omitted', async () => {
      rankRepo.findOne.mockResolvedValue(null); // name is free
      rankQb.getRawOne.mockResolvedValue({ max: 11 }); // current max precedence

      const dto = await service.create(user(), { name: 'Warrant Officer' }, '127.0.0.1');

      const saved = rankRepo.save.mock.calls[0][0] as Rank;
      expect(saved.precedence).toBe(12); // max + 1
      expect(saved.chevrons).toBe(0); // default applied server-side
      expect(saved.linked).toBe(false);
      expect(dto.holdersCount).toBe(0);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'rank.create', regimentId: REGIMENT }),
      );
    });

    it('honors an explicit precedence and rejects a duplicate name', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank());
      await expect(service.create(user(), { name: 'Sergeant' }, null)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(rankRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('blocks deletion when the rank is still held by members', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank());
      memberRepo.count.mockResolvedValue(2);

      await expect(service.remove(user(), 'rank-1', null)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(rankRepo.remove).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('deletes and audits when no member holds the rank', async () => {
      const rank = buildRank();
      rankRepo.findOne.mockResolvedValue(rank);
      memberRepo.count.mockResolvedValue(0);

      await service.remove(user(), 'rank-1', null);

      expect(rankRepo.remove).toHaveBeenCalledWith(rank);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rank.delete' }));
    });

    it('throws NotFound for a missing/wrong-regiment rank', async () => {
      rankRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(user(), 'missing', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reorder', () => {
    it('rejects an id set that does not match the regiment ranks exactly', async () => {
      rankRepo.find.mockResolvedValue([buildRank({ id: 'rank-1' }), buildRank({ id: 'rank-2' })]);

      await expect(
        service.reorder(user(), { order: ['rank-1', 'rank-3'] }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rewrites precedence in a transaction (offset then final positions)', async () => {
      rankRepo.find
        .mockResolvedValueOnce([buildRank({ id: 'rank-1' }), buildRank({ id: 'rank-2' })]) // validation
        .mockResolvedValueOnce([]); // trailing findAll reload
      const managerRepo = { increment: jest.fn(), update: jest.fn() };
      dataSource.transaction.mockImplementation((cb: (m: unknown) => unknown) =>
        cb({ getRepository: () => managerRepo }),
      );

      await service.reorder(user(), { order: ['rank-2', 'rank-1'] }, null);

      // All rows shifted clear of the target range first, then final positions set.
      expect(managerRepo.increment).toHaveBeenCalledWith(
        { regimentId: REGIMENT },
        'precedence',
        1000,
      );
      expect(managerRepo.update).toHaveBeenCalledWith(
        { id: 'rank-2', regimentId: REGIMENT },
        { precedence: 1 },
      );
      expect(managerRepo.update).toHaveBeenCalledWith(
        { id: 'rank-1', regimentId: REGIMENT },
        { precedence: 2 },
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'rank.reorder' }),
      );
    });
  });

  describe('linkDiscord', () => {
    it('sets the role id, flips linked on, and audits a rank.update', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank());
      memberRepo.count.mockResolvedValue(0);

      const dto = await service.linkDiscord(
        user(),
        'rank-1',
        { discordRoleId: '112233445566778899' },
        null,
      );

      const saved = rankRepo.save.mock.calls[0][0] as Rank;
      expect(saved.discordRoleId).toBe('112233445566778899');
      expect(saved.linked).toBe(true);
      expect(dto.linked).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rank.update' }));
    });
  });

  describe('unlinkDiscord', () => {
    it('clears the role binding, flips linked off, and audits a rank.update', async () => {
      rankRepo.findOne.mockResolvedValue(
        buildRank({ discordRoleId: '112233445566778899', linked: true }),
      );
      memberRepo.count.mockResolvedValue(0);

      const dto = await service.unlinkDiscord(user(), 'rank-1', null);

      const saved = rankRepo.save.mock.calls[0][0] as Rank;
      expect(saved.discordRoleId).toBeNull();
      expect(saved.discordRoleName).toBeNull();
      expect(saved.linked).toBe(false);
      expect(dto.linked).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'rank.update', detail: 'Unlinked from Discord role.' }),
      );
    });
  });
});
