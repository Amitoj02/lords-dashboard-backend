import { NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuditActorType, AuditSeverity, MemberRole } from '../common/enums';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditAction } from './entities/audit-action.entity';
import { AuditLogEntry } from './entities/audit-log-entry.entity';

describe('AuditService', () => {
  let service: AuditService;
  const entriesRepo = {
    create: jest.fn((x: Partial<AuditLogEntry>) => x),
    save: jest.fn((x: Partial<AuditLogEntry>) => Promise.resolve(x)),
    findAndCount: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  };
  const actionsRepo = { find: jest.fn() };
  // The Discord audit mirror resolves DiscordSyncService lazily via ModuleRef;
  // a stub keeps record() self-contained without wiring the Discord module here.
  const syncStub = { enqueueAuditLog: jest.fn().mockResolvedValue(null) };
  const moduleRef = { get: jest.fn().mockReturnValue(syncStub) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLogEntry), useValue: entriesRepo },
        { provide: getRepositoryToken(AuditAction), useValue: actionsRepo },
        { provide: ModuleRef, useValue: moduleRef },
      ],
    }).compile();
    service = module.get(AuditService);
    jest.clearAllMocks();
    actionsRepo.find.mockResolvedValue([
      { code: 'rank.change', defaultSeverity: AuditSeverity.Warn },
      { code: 'auth.sign_in', defaultSeverity: AuditSeverity.Info },
    ]);
  });

  it('resolves the configured default severity for the action', async () => {
    await service.record({ regimentId: 'r1', action: 'rank.change' });
    expect(entriesRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rank.change', severity: AuditSeverity.Warn }),
    );
  });

  it('falls back to Info for an unknown action code', async () => {
    await service.record({ regimentId: 'r1', action: 'mystery.action' });
    expect(entriesRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ severity: AuditSeverity.Info }),
    );
  });

  it('lets an explicit severity override the default', async () => {
    await service.record({
      regimentId: 'r1',
      action: 'rank.change',
      severity: AuditSeverity.Error,
    });
    expect(entriesRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ severity: AuditSeverity.Error }),
    );
  });

  it('defaults to a system actor when no member id is given', async () => {
    await service.record({ regimentId: 'r1', action: 'auth.sign_in' });
    expect(entriesRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: AuditActorType.System, actorMemberId: null }),
    );
  });

  it('never throws when the write fails (audit is a side effect)', async () => {
    entriesRepo.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record({ regimentId: 'r1', action: 'auth.sign_in' }),
    ).resolves.toBeUndefined();
  });

  it('builds a member actor from the authenticated user', () => {
    const user: AuthenticatedUser = {
      identityId: 'i1',
      memberId: 'm1',
      discordUserId: '1',
      role: MemberRole.Admin,
      regimentId: 'r1',
    };
    expect(AuditService.actorFromUser(user, '1.2.3.4')).toEqual({
      memberId: 'm1',
      type: AuditActorType.Member,
      label: null,
      ip: '1.2.3.4',
    });
  });

  describe('findOne', () => {
    it('returns the entry projection scoped to the regiment', async () => {
      entriesRepo.findOne.mockResolvedValue({
        id: '42',
        regimentId: 'r1',
        occurredAt: new Date('2026-06-22T18:30:00.000Z'),
        action: 'rank.change',
        severity: AuditSeverity.Warn,
        actorType: AuditActorType.Member,
        actorMemberId: 'm1',
        actorLabel: 'Sgt. Rock',
        targetType: 'member',
        targetId: 'm2',
        targetMemberId: 'm2',
        targetLabel: 'Pvt. Snafu',
        detail: null,
        beforeValue: null,
        afterValue: null,
      });

      const dto = await service.findOne('r1', '42');

      expect(entriesRepo.findOne).toHaveBeenCalledWith({
        where: { id: '42', regimentId: 'r1' },
        relations: { actorMember: true, targetMember: true },
      });
      expect(dto.id).toBe('42');
      expect(dto.occurredAt).toBe('2026-06-22T18:30:00.000Z');
      expect(dto.action).toBe('rank.change');
    });

    it('throws NotFound for a missing/wrong-regiment entry', async () => {
      entriesRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('r1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('exportCsv', () => {
    const query = { page: 1, limit: 25 } as AuditQueryDto;

    it('emits the header row and un-paginated, 10k-capped, newest-first read', async () => {
      entriesRepo.find.mockResolvedValue([]);

      const csv = await service.exportCsv('r1', query);

      expect(entriesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { regimentId: 'r1' },
          order: { occurredAt: 'DESC', id: 'DESC' },
          take: 10000,
        }),
      );
      expect(csv).toBe(
        'occurredAt,action,severity,actorType,actorLabel,actorMemberId,targetType,targetId,targetLabel,detail',
      );
    });

    it('quote-escapes commas and quotes and renders nulls as empty cells', async () => {
      entriesRepo.find.mockResolvedValue([
        {
          occurredAt: new Date('2026-06-22T18:30:00.000Z'),
          action: 'settings.update',
          severity: AuditSeverity.Info,
          actorType: AuditActorType.Member,
          actorLabel: 'Cmdr "Ace"',
          actorMemberId: 'm1',
          targetType: 'settings',
          targetId: null,
          targetLabel: null,
          detail: 'changed name, tag',
        },
      ]);

      const csv = await service.exportCsv('r1', query);
      const lines = csv.split('\n');

      // Header still present ahead of the single data row.
      expect(lines).toHaveLength(2);
      // A field with a comma stays inside one quoted cell; embedded quotes are doubled.
      expect(lines[1]).toContain('"changed name, tag"');
      expect(lines[1]).toContain('"Cmdr ""Ace"""');
      // Null fields become empty quoted cells.
      expect(lines[1]).toContain('"settings","",""');
    });
  });
});
