import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DiscordRolePolicyService } from '../discord/discord-role-policy.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { StorageService } from '../storage/storage.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuditSeverity, MemberRole } from '../common/enums';
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
  imageUrl: null,
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
  const storage = {
    assertIconWithinDimensions: jest.fn().mockResolvedValue(undefined),
    resolveKeyToPublicUrl: jest.fn((_u: unknown, key: string) => `https://cdn.example/${key}`),
  };
  const discordSync = { enqueueRoleRelink: jest.fn().mockResolvedValue(null) };
  // LDA-H1 link validation. Default to "clean" (no advisory) so the existing
  // happy paths pass; T-0189 made the privileged verdict a returned warning.
  const rolePolicy = { checkRoleLinkable: jest.fn().mockResolvedValue(null) };

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks only clears CALLS, not implementations — a test that makes the
    // policy warn or throw would otherwise poison every test after it.
    rolePolicy.checkRoleLinkable.mockResolvedValue(null);

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
        { provide: StorageService, useValue: storage },
        { provide: DiscordSyncService, useValue: discordSync },
        { provide: DiscordRolePolicyService, useValue: rolePolicy },
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

    it('validates the icon dimensions before resolving its public url and persists it', async () => {
      rankRepo.findOne.mockResolvedValue(null); // name is free
      rankQb.getRawOne.mockResolvedValue({ max: 4 });

      await service.create(user(), { name: 'Captain', imageKey: 'icons/captain.png' }, null);

      expect(storage.assertIconWithinDimensions).toHaveBeenCalledWith('icons/captain.png');
      // Dimension check runs before the URL is resolved.
      expect(storage.assertIconWithinDimensions.mock.invocationCallOrder[0]).toBeLessThan(
        storage.resolveKeyToPublicUrl.mock.invocationCallOrder[0],
      );

      const saved = rankRepo.save.mock.calls[0][0] as Rank;
      expect(saved.imageUrl).toBe('https://cdn.example/icons/captain.png');
    });

    it('rejects and does not save when the icon fails the dimension check', async () => {
      rankRepo.findOne.mockResolvedValue(null);
      rankQb.getRawOne.mockResolvedValue({ max: 4 });
      storage.assertIconWithinDimensions.mockRejectedValueOnce(new BadRequestException('too big'));

      await expect(
        service.create(user(), { name: 'Captain', imageKey: 'icons/huge.png' }, null),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(storage.resolveKeyToPublicUrl).not.toHaveBeenCalled();
      expect(rankRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('validates the icon dimensions before resolving its public url and persists it', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank());
      memberRepo.count.mockResolvedValue(0);

      const dto = await service.update(user(), 'rank-1', { imageKey: 'icons/sergeant.png' }, null);

      expect(storage.assertIconWithinDimensions).toHaveBeenCalledWith('icons/sergeant.png');
      // Dimension check runs before the URL is resolved.
      expect(storage.assertIconWithinDimensions.mock.invocationCallOrder[0]).toBeLessThan(
        storage.resolveKeyToPublicUrl.mock.invocationCallOrder[0],
      );

      const saved = rankRepo.save.mock.calls[0][0] as Rank;
      expect(saved.imageUrl).toBe('https://cdn.example/icons/sergeant.png');
      expect(dto.imageUrl).toBe('https://cdn.example/icons/sergeant.png');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rank.update' }));
    });

    it('rejects and does not save when the icon fails the dimension check', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank());
      storage.assertIconWithinDimensions.mockRejectedValueOnce(new BadRequestException('too big'));

      await expect(
        service.update(user(), 'rank-1', { imageKey: 'icons/huge.png' }, null),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(storage.resolveKeyToPublicUrl).not.toHaveBeenCalled();
      expect(rankRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
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

    it('fans the change out to every holder, passing the role that is being replaced', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank({ discordRoleId: 'old-role', linked: true }));
      memberRepo.count.mockResolvedValue(0);
      discordSync.enqueueRoleRelink.mockResolvedValue({ batchId: 'batch-1', affected: 42 });

      await service.linkDiscord(user(), 'rank-1', { discordRoleId: 'new-role' }, null);

      expect(discordSync.enqueueRoleRelink).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'rank',
          subjectId: 'rank-1',
          previousRoleId: 'old-role',
          nextRoleId: 'new-role',
        }),
      );
    });

    it('writes ONE relink audit row for the whole action, carrying the member count', async () => {
      // A row per member would bury the ladder's history under one admin click.
      rankRepo.findOne.mockResolvedValue(buildRank({ discordRoleId: 'old-role', linked: true }));
      memberRepo.count.mockResolvedValue(0);
      discordSync.enqueueRoleRelink.mockResolvedValue({ batchId: 'batch-1', affected: 42 });

      await service.linkDiscord(user(), 'rank-1', { discordRoleId: 'new-role' }, null);

      const relinkRows = audit.record.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === 'discord.role.relink',
      );
      expect(relinkRows).toHaveLength(1);
      expect(relinkRows[0][0]).toEqual(
        expect.objectContaining({
          before: { discordRoleId: 'old-role' },
          after: { discordRoleId: 'new-role' },
          detail: expect.stringContaining('42 member role updates'),
        }),
      );
    });

    it('records no relink row when nothing was queued (bot off / no holders)', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank());
      memberRepo.count.mockResolvedValue(0);
      discordSync.enqueueRoleRelink.mockResolvedValue(null);

      await service.linkDiscord(user(), 'rank-1', { discordRoleId: 'new-role' }, null);

      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'discord.role.relink' }),
      );
    });

    // T-0189: a privileged role used to be a 400. It now links, and the warning
    // is what the admin (and the ledger) get instead of the rejection.
    describe('a privileged Discord role (T-0189)', () => {
      const WARNING = 'Heads up: this Discord role grants privileged permissions (…).';

      it('links anyway and returns the advisory on the response', async () => {
        rankRepo.findOne.mockResolvedValue(buildRank());
        memberRepo.count.mockResolvedValue(0);
        rolePolicy.checkRoleLinkable.mockResolvedValue(WARNING);

        const dto = await service.linkDiscord(
          user(),
          'rank-1',
          { discordRoleId: '112233445566778899' },
          null,
        );

        const saved = rankRepo.save.mock.calls[0][0] as Rank;
        expect(saved.discordRoleId).toBe('112233445566778899');
        expect(saved.linked).toBe(true);
        expect(dto.discordRoleWarning).toBe(WARNING);
      });

      it('raises the audit row to warn and states what was accepted', async () => {
        rankRepo.findOne.mockResolvedValue(buildRank());
        memberRepo.count.mockResolvedValue(0);
        rolePolicy.checkRoleLinkable.mockResolvedValue(WARNING);

        await service.linkDiscord(user(), 'rank-1', { discordRoleId: '1122' }, null);

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'rank.update',
            severity: AuditSeverity.Warn,
            detail: `Linked to Discord role 1122. ${WARNING}`,
          }),
        );
      });

      it('leaves a clean link at its default severity, with no warning field', async () => {
        rankRepo.findOne.mockResolvedValue(buildRank());
        memberRepo.count.mockResolvedValue(0);

        const dto = await service.linkDiscord(user(), 'rank-1', { discordRoleId: '1122' }, null);

        expect(dto.discordRoleWarning).toBeUndefined();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'rank.update',
            severity: undefined,
            detail: 'Linked to Discord role 1122.',
          }),
        );
      });

      it('still refuses a role the bot cannot assign at all (policy throws)', async () => {
        rankRepo.findOne.mockResolvedValue(buildRank());
        rolePolicy.checkRoleLinkable.mockRejectedValue(
          new BadRequestException('That role sits at or above the bot in the hierarchy'),
        );

        await expect(
          service.linkDiscord(user(), 'rank-1', { discordRoleId: '1122' }, null),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(rankRepo.save).not.toHaveBeenCalled();
      });
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

    it('fans out an unlink as a re-link to nothing, so holders LOSE the old role', async () => {
      rankRepo.findOne.mockResolvedValue(buildRank({ discordRoleId: 'old-role', linked: true }));
      memberRepo.count.mockResolvedValue(0);
      discordSync.enqueueRoleRelink.mockResolvedValue({ batchId: 'batch-1', affected: 7 });

      await service.unlinkDiscord(user(), 'rank-1', null);

      expect(discordSync.enqueueRoleRelink).toHaveBeenCalledWith(
        expect.objectContaining({ previousRoleId: 'old-role', nextRoleId: null }),
      );
    });
  });
});
