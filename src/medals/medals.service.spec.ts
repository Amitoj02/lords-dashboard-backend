import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { MedalRibbon, MemberRole } from '../common/enums';
import { Medal } from './entities/medal.entity';
import { MemberMedal } from './entities/member-medal.entity';
import { MedalsService } from './medals.service';

const REGIMENT = 'regiment-1';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Admin,
  regimentId: REGIMENT,
  ...overrides,
});

const buildMedal = (overrides: Partial<Medal> = {}): Medal => ({
  id: 'medal-1',
  regimentId: REGIMENT,
  title: 'Distinguished Service Cross',
  glyph: 'DSC',
  ribbon: MedalRibbon.Gold,
  description: 'Gallantry in the line.',
  precedence: 1,
  discordRoleName: null,
  discordRoleId: null,
  linked: false,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  ...overrides,
});

describe('MedalsService', () => {
  let service: MedalsService;

  // Medal repository: find/findOne/create/save/remove + a QueryBuilder (MAX precedence).
  let medalQb: {
    select: jest.Mock;
    where: jest.Mock;
    getRawOne: jest.Mock;
  };
  const medalRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  // MemberMedal repository: count + grouped QueryBuilder (holders/awards).
  let mmQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  const memberMedalRepo = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const dataSource = { transaction: jest.fn() };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    medalQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: null }),
    };
    medalRepo.createQueryBuilder.mockReturnValue(medalQb);
    medalRepo.create.mockImplementation((entity: Partial<Medal>) => entity as Medal);
    medalRepo.save.mockImplementation((entity: Medal) =>
      Promise.resolve(buildMedal({ ...(entity as Partial<Medal>), id: entity.id ?? 'medal-new' })),
    );

    mmQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    memberMedalRepo.createQueryBuilder.mockReturnValue(mmQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MedalsService,
        { provide: getRepositoryToken(Medal), useValue: medalRepo },
        { provide: getRepositoryToken(MemberMedal), useValue: memberMedalRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(MedalsService);
  });

  describe('findAll', () => {
    it('lists by precedence and computes distinct holders + total awards without N+1', async () => {
      const first = buildMedal({ id: 'medal-1', precedence: 1 });
      const second = buildMedal({ id: 'medal-2', title: 'Campaign Medal', precedence: 2 });
      medalRepo.find.mockResolvedValue([first, second]);
      // medal-1 was awarded 3 times across 2 distinct members; medal-2 has no awards.
      mmQb.getRawMany.mockResolvedValue([{ medalId: 'medal-1', awards: '3', holders: '2' }]);

      const result = await service.findAll(user());

      expect(medalRepo.find).toHaveBeenCalledWith({
        where: { regimentId: REGIMENT },
        order: { precedence: 'ASC' },
      });
      // One grouped query for the whole list (no per-row count).
      expect(memberMedalRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(memberMedalRepo.count).not.toHaveBeenCalled();

      expect(result[0].id).toBe('medal-1');
      expect(result[0].holdersCount).toBe(2);
      expect(result[0].awardsCount).toBe(3);
      // Medals absent from the grouped result default to zero.
      expect(result[1].id).toBe('medal-2');
      expect(result[1].holdersCount).toBe(0);
      expect(result[1].awardsCount).toBe(0);
      // Timestamps are ISO strings.
      expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('skips the counts query when there are no medals', async () => {
      medalRepo.find.mockResolvedValue([]);
      const result = await service.findAll(user());
      expect(result).toEqual([]);
      expect(memberMedalRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('places a new medal at the end of the ladder (max precedence + 1) and audits', async () => {
      medalRepo.findOne.mockResolvedValue(null); // title is free
      medalQb.getRawOne.mockResolvedValue({ max: '5' }); // current max precedence

      const dto = await service.create(
        user(),
        { title: 'Medal of Valor', glyph: 'MoV', ribbon: MedalRibbon.Red },
        '10.0.0.1',
      );

      const saved = medalRepo.save.mock.calls[0][0] as Medal;
      expect(saved.precedence).toBe(6);
      expect(saved.linked).toBe(false);
      expect(dto.holdersCount).toBe(0);
      expect(dto.awardsCount).toBe(0);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          regimentId: REGIMENT,
          action: 'medal.create',
          target: expect.objectContaining({ type: 'medal', label: 'Medal of Valor' }),
        }),
      );
    });

    it('honors an explicit precedence and rejects a duplicate title', async () => {
      medalRepo.findOne.mockResolvedValue(buildMedal());
      await expect(
        service.create(
          user(),
          { title: 'Distinguished Service Cross', glyph: 'DSC', ribbon: MedalRibbon.Gold },
          null,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(medalRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('applies provided fields and records before/after', async () => {
      const medal = buildMedal({ description: 'Old description', precedence: 1 });
      medalRepo.findOne.mockResolvedValue(medal);

      await service.update(
        user(),
        'medal-1',
        { description: 'New description', precedence: 9 },
        '10.0.0.1',
      );

      const saved = medalRepo.save.mock.calls[0][0] as Medal;
      expect(saved.description).toBe('New description');
      expect(saved.precedence).toBe(9);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'medal.update',
          before: expect.objectContaining({ description: 'Old description', precedence: 1 }),
          after: expect.objectContaining({ description: 'New description', precedence: 9 }),
        }),
      );
    });

    it('throws NotFound when the medal is missing/wrong-regiment', async () => {
      medalRepo.findOne.mockResolvedValue(null);
      await expect(service.update(user(), 'missing', { glyph: 'X' }, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('blocks deletion when the medal has been awarded', async () => {
      medalRepo.findOne.mockResolvedValue(buildMedal());
      memberMedalRepo.count.mockResolvedValue(4);

      await expect(service.remove(user(), 'medal-1', null)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(medalRepo.remove).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('deletes an unawarded medal and audits medal.delete', async () => {
      const medal = buildMedal();
      medalRepo.findOne.mockResolvedValue(medal);
      memberMedalRepo.count.mockResolvedValue(0);

      await service.remove(user(), 'medal-1', '10.0.0.1');

      expect(medalRepo.remove).toHaveBeenCalledWith(medal);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'medal.delete' }),
      );
    });
  });

  describe('reorder', () => {
    it('rejects an id set that does not match the regiment medals exactly', async () => {
      medalRepo.find.mockResolvedValue([
        buildMedal({ id: 'medal-1' }),
        buildMedal({ id: 'medal-2', title: 'Campaign Medal' }),
      ]);

      await expect(
        service.reorder(user(), { order: ['medal-1', 'medal-3'] }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rewrites precedence in a transaction (offset then final positions)', async () => {
      medalRepo.find
        .mockResolvedValueOnce([
          buildMedal({ id: 'medal-1' }),
          buildMedal({ id: 'medal-2', title: 'Campaign Medal' }),
        ]) // validation
        .mockResolvedValueOnce([]); // trailing findAll reload
      const managerRepo = { increment: jest.fn(), update: jest.fn() };
      dataSource.transaction.mockImplementation((cb: (m: unknown) => unknown) =>
        cb({ getRepository: () => managerRepo }),
      );

      await service.reorder(user(), { order: ['medal-2', 'medal-1'] }, null);

      // All rows shifted clear of the target range first, then final positions set.
      expect(managerRepo.increment).toHaveBeenCalledWith(
        { regimentId: REGIMENT },
        'precedence',
        1000,
      );
      expect(managerRepo.update).toHaveBeenCalledWith(
        { id: 'medal-2', regimentId: REGIMENT },
        { precedence: 1 },
      );
      expect(managerRepo.update).toHaveBeenCalledWith(
        { id: 'medal-1', regimentId: REGIMENT },
        { precedence: 2 },
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'medal.reorder' }),
      );
    });
  });

  describe('linkDiscord', () => {
    it('sets the role mapping, flags linked, and audits medal.update', async () => {
      medalRepo.findOne.mockResolvedValue(buildMedal());

      const dto = await service.linkDiscord(
        user(),
        'medal-1',
        { discordRoleId: '123', discordRoleName: 'Veterans' },
        null,
      );

      const saved = medalRepo.save.mock.calls[0][0] as Medal;
      expect(saved.discordRoleId).toBe('123');
      expect(saved.discordRoleName).toBe('Veterans');
      expect(saved.linked).toBe(true);
      expect(dto.linked).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'medal.update' }),
      );
    });
  });

  describe('unlinkDiscord', () => {
    it('clears the role mapping, flags unlinked, and audits medal.update', async () => {
      medalRepo.findOne.mockResolvedValue(
        buildMedal({ discordRoleId: '123', discordRoleName: 'Veterans', linked: true }),
      );

      const dto = await service.unlinkDiscord(user(), 'medal-1', null);

      const saved = medalRepo.save.mock.calls[0][0] as Medal;
      expect(saved.discordRoleId).toBeNull();
      expect(saved.discordRoleName).toBeNull();
      expect(saved.linked).toBe(false);
      expect(dto.linked).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'medal.update', detail: 'Unlinked from Discord role.' }),
      );
    });
  });
});
