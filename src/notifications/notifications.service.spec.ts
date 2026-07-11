import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { MemberRole, NotificationTone } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { NotificationRead } from './entities/notification-read.entity';
import { Notification } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

const REGIMENT = 'regiment-1';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Admin,
  regimentId: REGIMENT,
  ...overrides,
});

const buildNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notif-1',
  regimentId: REGIMENT,
  title: 'Operation Thunderclap',
  body: 'Muster at 1900.',
  tone: NotificationTone.Info,
  authorLabel: 'Command',
  createdAt: new Date('2026-06-22T18:30:00.000Z'),
  ...overrides,
});

describe('NotificationsService', () => {
  let service: NotificationsService;

  // Notification repository: findAndCount/create/save/findOne + a query builder.
  let notifQb: {
    leftJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getCount: jest.Mock;
    getMany: jest.Mock;
  };
  const notificationRepo = {
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
    createQueryBuilder: jest.fn(),
  };

  const readRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
  };
  const memberRepo = { findOne: jest.fn() };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    readRepo.find.mockResolvedValue([]);
    readRepo.save.mockImplementation((x: unknown) => Promise.resolve(x));
    notificationRepo.save.mockImplementation((x: Record<string, unknown>) =>
      // Simulate the DB populating the generated id + @CreateDateColumn on insert.
      Promise.resolve({ ...x, id: x.id ?? 'notif-1', createdAt: x.createdAt ?? new Date() }),
    );

    notifQb = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn(),
      getMany: jest.fn(),
    };
    notificationRepo.createQueryBuilder.mockReturnValue(notifQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: notificationRepo },
        { provide: getRepositoryToken(NotificationRead), useValue: readRepo },
        { provide: getRepositoryToken(Member), useValue: memberRepo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  describe('findAll', () => {
    it('scopes by regiment, orders by createdAt DESC, and flags the caller’s read rows', async () => {
      const rows = [buildNotification({ id: 'notif-1' }), buildNotification({ id: 'notif-2' })];
      notificationRepo.findAndCount.mockResolvedValue([rows, 2]);
      readRepo.find.mockResolvedValue([{ notificationId: 'notif-1' }]);

      const result = await service.findAll(user(), { page: 1, limit: 20, skip: 0 });

      expect(notificationRepo.findAndCount).toHaveBeenCalledWith({
        where: { regimentId: REGIMENT },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 20,
      });
      expect(result.data[0].read).toBe(true);
      expect(result.data[1].read).toBe(false);
      expect(result.data[0].createdAt).toBe('2026-06-22T18:30:00.000Z');
      expect(result.meta.total).toBe(2);
    });

    it('reports every row unread (and skips the read lookup) for an unlinked caller', async () => {
      notificationRepo.findAndCount.mockResolvedValue([[buildNotification()], 1]);

      const result = await service.findAll(user({ memberId: null }), {
        page: 1,
        limit: 20,
        skip: 0,
      });

      expect(readRepo.find).not.toHaveBeenCalled();
      expect(result.data[0].read).toBe(false);
    });
  });

  describe('unreadCount', () => {
    it('reflects read state via the anti-join query', async () => {
      notifQb.getCount.mockResolvedValue(3);

      const result = await service.unreadCount(user());

      expect(notifQb.leftJoin).toHaveBeenCalledWith(
        NotificationRead,
        'r',
        'r.notificationId = n.id AND r.memberId = :memberId',
        { memberId: 'member-1' },
      );
      expect(notifQb.andWhere).toHaveBeenCalledWith('r.notificationId IS NULL');
      expect(result).toEqual({ count: 3 });
    });

    it('returns 0 without querying for an unlinked caller', async () => {
      const result = await service.unreadCount(user({ memberId: null }));
      expect(result).toEqual({ count: 0 });
      expect(notificationRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('composes with the given author label, audits, and returns read=true', async () => {
      const dto = { title: 'Stand-to', body: 'Report in.', authorLabel: 'HQ' };

      const result = await service.create(user(), dto, '1.2.3.4');

      const saved = notificationRepo.save.mock.calls[0][0] as Notification;
      expect(saved.regimentId).toBe(REGIMENT);
      expect(saved.authorLabel).toBe('HQ');
      expect(saved.tone).toBe(NotificationTone.Info);
      // Author label was supplied, so no member lookup was needed.
      expect(memberRepo.findOne).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'notification.create', regimentId: REGIMENT }),
      );
      expect(result.read).toBe(true);
      expect(result.authorLabel).toBe('HQ');
    });

    it('falls back to the caller’s member name when no author label is given', async () => {
      memberRepo.findOne.mockResolvedValue({ name: 'Lord Commander' });

      const result = await service.create(user(), { title: 'T', body: 'B' }, null);

      const saved = notificationRepo.save.mock.calls[0][0] as Notification;
      expect(saved.authorLabel).toBe('Lord Commander');
      expect(result.authorLabel).toBe('Lord Commander');
    });

    it('falls back to "Command" when neither a label nor a member name resolves', async () => {
      memberRepo.findOne.mockResolvedValue(null);

      await service.create(user(), { title: 'T', body: 'B' }, null);

      const saved = notificationRepo.save.mock.calls[0][0] as Notification;
      expect(saved.authorLabel).toBe('Command');
    });
  });

  describe('markRead', () => {
    it('inserts a read row the first time', async () => {
      notificationRepo.findOne.mockResolvedValue(buildNotification());
      readRepo.findOne.mockResolvedValue(null);

      const result = await service.markRead(user(), 'notif-1');

      expect(readRepo.save).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ read: true });
    });

    it('is idempotent — a second mark writes nothing', async () => {
      notificationRepo.findOne.mockResolvedValue(buildNotification());
      readRepo.findOne.mockResolvedValue({ notificationId: 'notif-1', memberId: 'member-1' });

      const result = await service.markRead(user(), 'notif-1');

      expect(readRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({ read: true });
    });

    it('404s when the notification is missing/wrong-regiment', async () => {
      notificationRepo.findOne.mockResolvedValue(null);
      await expect(service.markRead(user(), 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids an unlinked caller', async () => {
      await expect(service.markRead(user({ memberId: null }), 'notif-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(notificationRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead', () => {
    it('marks every unread notification and returns the count', async () => {
      notifQb.getMany.mockResolvedValue([
        buildNotification({ id: 'notif-1' }),
        buildNotification({ id: 'notif-2' }),
      ]);

      const result = await service.markAllRead(user());

      expect(readRepo.save).toHaveBeenCalledTimes(1);
      const savedRows = readRepo.save.mock.calls[0][0] as NotificationRead[];
      expect(savedRows).toHaveLength(2);
      expect(savedRows[0].memberId).toBe('member-1');
      expect(result).toEqual({ read: 2 });
    });

    it('is a no-op when nothing is unread', async () => {
      notifQb.getMany.mockResolvedValue([]);

      const result = await service.markAllRead(user());

      expect(readRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({ read: 0 });
    });

    it('returns 0 for an unlinked caller', async () => {
      const result = await service.markAllRead(user({ memberId: null }));
      expect(result).toEqual({ read: 0 });
      expect(notificationRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
