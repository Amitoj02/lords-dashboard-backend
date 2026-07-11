import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuditActorType, AuditSeverity, MemberRole } from '../common/enums';
import { AuditService } from './audit.service';
import { AuditAction } from './entities/audit-action.entity';
import { AuditLogEntry } from './entities/audit-log-entry.entity';

describe('AuditService', () => {
  let service: AuditService;
  const entriesRepo = {
    create: jest.fn((x: Partial<AuditLogEntry>) => x),
    save: jest.fn((x: Partial<AuditLogEntry>) => Promise.resolve(x)),
    findAndCount: jest.fn(),
  };
  const actionsRepo = { find: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLogEntry), useValue: entriesRepo },
        { provide: getRepositoryToken(AuditAction), useValue: actionsRepo },
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
});
