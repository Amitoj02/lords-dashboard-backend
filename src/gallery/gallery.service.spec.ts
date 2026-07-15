import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { GalleryMediaType, GalleryStatus, GalleryType, MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { GalleryFileInputDto } from './dto/create-gallery-item.dto';
import { GalleryService } from './gallery.service';
import { GalleryFile } from './entities/gallery-file.entity';
import { GalleryItem } from './entities/gallery-item.entity';
import { GalleryLike } from './entities/gallery-like.entity';
import { GalleryTag } from './entities/gallery-tag.entity';

type MockRepo<T extends object> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const REGIMENT = 'regiment-1';

const MEMBER_USER: AuthenticatedUser = {
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Member,
  regimentId: REGIMENT,
};

const ADMIN_USER: AuthenticatedUser = {
  identityId: 'identity-2',
  memberId: 'member-admin',
  discordUserId: 'discord-2',
  role: MemberRole.Admin,
  regimentId: REGIMENT,
};

const ANON_USER: AuthenticatedUser = {
  identityId: 'identity-3',
  memberId: null,
  discordUserId: 'discord-3',
  role: MemberRole.Applicant,
  regimentId: REGIMENT,
};

const buildItem = (overrides: Partial<GalleryItem> = {}): GalleryItem => ({
  id: 'gallery-1',
  regimentId: REGIMENT,
  authorMemberId: 'member-1',
  author: { id: 'member-1', name: 'Jane Doe' } as unknown as Member,
  moderatedByMemberId: null,
  title: 'The charge at dawn',
  caption: null,
  type: GalleryType.Image,
  linkUrl: null,
  thumbnailUrl: null,
  status: GalleryStatus.Approved,
  declineReason: null,
  isDraft: false,
  submittedAt: new Date('2026-06-22T18:00:00.000Z'),
  approvedAt: new Date('2026-06-22T18:30:00.000Z'),
  createdAt: new Date('2026-06-22T18:00:00.000Z'),
  updatedAt: new Date('2026-06-22T18:00:00.000Z'),
  deletedAt: null,
  ...overrides,
});

const buildSettings = (overrides: Partial<RegimentSettings> = {}): RegimentSettings => ({
  regimentId: REGIMENT,
  publicRoster: true,
  publicGallery: true,
  publicEvents: true,
  publicStats: true,
  openRecruitment: true,
  showOfficersMessOnLanding: true,
  allowMercenaries: true,
  autoApproveTrustedMembers: false,
  galleryMaxImageSizeMb: 12,
  galleryMaxVideoSizeMb: 80,
  galleryMaxItemsPerSubmission: 10,
  galleryAllowedImageTypes: null,
  galleryAllowedVideoTypes: null,
  eventDefaultTimezone: 'UTC',
  eventDefaultStartTime: null,
  eventDefaultNotifyBefore: null,
  auditRetentionMonths: 12,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const file = (overrides: Partial<GalleryFileInputDto> = {}): GalleryFileInputDto => ({
  fileName: 'charge.png',
  mediaType: GalleryMediaType.Image,
  ...overrides,
});

/** A chainable query-builder stub for the grouped/raw enrichment queries. */
const makeSelectQb = (rawMany: unknown[] = []) => ({
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  getRawMany: jest.fn().mockResolvedValue(rawMany),
});

/** A chainable query-builder stub for the paginated item list. */
const makeListQb = (rows: GalleryItem[] = [], total = 0) => ({
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
});

describe('GalleryService', () => {
  let service: GalleryService;
  let items: MockRepo<GalleryItem>;
  let files: MockRepo<GalleryFile>;
  let likes: MockRepo<GalleryLike>;
  let tags: MockRepo<GalleryTag>;
  let members: MockRepo<Member>;
  let settings: MockRepo<RegimentSettings>;
  let audit: { record: jest.Mock };
  let discordSync: { enqueueApplicationDecision: jest.Mock };

  // Per-test transaction manager repositories.
  let txItems: MockRepo<GalleryItem>;
  let txFiles: MockRepo<GalleryFile>;
  let txTags: MockRepo<GalleryTag>;
  let dataSource: { transaction: jest.Mock };

  const query = { page: 1, limit: 20, skip: 0 };

  beforeEach(async () => {
    jest.clearAllMocks();

    items = {
      createQueryBuilder: jest.fn().mockReturnValue(makeListQb()),
      findOne: jest.fn(),
      save: jest.fn((x: GalleryItem) => Promise.resolve(x)),
      softRemove: jest.fn((x: GalleryItem) => Promise.resolve(x)),
    };
    files = { find: jest.fn().mockResolvedValue([]) };
    likes = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(makeSelectQb()),
    };
    tags = { find: jest.fn().mockResolvedValue([]) };
    members = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    settings = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
    audit = { record: jest.fn() };
    discordSync = { enqueueApplicationDecision: jest.fn().mockResolvedValue(null) };

    txItems = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: Partial<GalleryItem>) => Promise.resolve({ ...x, id: 'gallery-new' })),
    };
    txFiles = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    txTags = {
      insert: jest.fn((x: unknown) => Promise.resolve(x)),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === GalleryItem) return txItems;
        if (entity === GalleryFile) return txFiles;
        if (entity === GalleryTag) return txTags;
        throw new Error('unexpected repository');
      }),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GalleryService,
        { provide: getRepositoryToken(GalleryItem), useValue: items },
        { provide: getRepositoryToken(GalleryFile), useValue: files },
        { provide: getRepositoryToken(GalleryLike), useValue: likes },
        { provide: getRepositoryToken(GalleryTag), useValue: tags },
        { provide: getRepositoryToken(Member), useValue: members },
        { provide: getRepositoryToken(RegimentSettings), useValue: settings },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
        {
          provide: StorageService,
          useValue: {
            resolveKeyToPublicUrl: jest.fn(
              (_u: unknown, key: string) => `https://cdn.example/${key}`,
            ),
          },
        },
        { provide: DiscordSyncService, useValue: discordSync },
      ],
    }).compile();

    service = module.get(GalleryService);
  });

  describe('submit', () => {
    it('forbids submission when the caller is not an enrolled member', async () => {
      await expect(
        service.submit(ANON_USER, { title: 't', type: GalleryType.Image }, null),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(settings.findOne).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('forces Pending for a regular member and audits the submission', async () => {
      settings.findOne!.mockResolvedValue(buildSettings());
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));

      const result = await service.submit(
        MEMBER_USER,
        { title: 'The charge at dawn', type: GalleryType.Image },
        '9.9.9.9',
      );

      const created = txItems.create!.mock.calls[0][0] as Partial<GalleryItem>;
      expect(created).toMatchObject({
        regimentId: REGIMENT,
        authorMemberId: 'member-1',
        status: GalleryStatus.Pending,
        isDraft: false,
        approvedAt: null,
        moderatedByMemberId: null,
      });
      expect(created.submittedAt).toBeInstanceOf(Date);
      expect(result.status).toBe(GalleryStatus.Pending);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'gallery.submit', regimentId: REGIMENT }),
      );
    });

    it('auto-approves a trusted admin when the regiment opts in', async () => {
      settings.findOne!.mockResolvedValue(buildSettings({ autoApproveTrustedMembers: true }));
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Approved }));

      const result = await service.submit(
        ADMIN_USER,
        { title: 'The charge at dawn', type: GalleryType.Image },
        null,
      );

      const created = txItems.create!.mock.calls[0][0] as Partial<GalleryItem>;
      expect(created.status).toBe(GalleryStatus.Approved);
      expect(created.approvedAt).toBeInstanceOf(Date);
      expect(created.moderatedByMemberId).toBe('member-admin');
      expect(result.status).toBe(GalleryStatus.Approved);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'Auto-approved (trusted member)' }),
      );
    });

    it('does NOT auto-approve a non-trusted member even when the setting is on', async () => {
      settings.findOne!.mockResolvedValue(buildSettings({ autoApproveTrustedMembers: true }));
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));

      await service.submit(MEMBER_USER, { title: 't', type: GalleryType.Image }, null);

      const created = txItems.create!.mock.calls[0][0] as Partial<GalleryItem>;
      expect(created.status).toBe(GalleryStatus.Pending);
    });

    it('rejects a submission whose file count exceeds the per-submission limit', async () => {
      settings.findOne!.mockResolvedValue(buildSettings({ galleryMaxItemsPerSubmission: 2 }));

      await expect(
        service.submit(
          MEMBER_USER,
          { title: 't', type: GalleryType.Image, files: [file(), file(), file()] },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a file that exceeds its per-type size cap', async () => {
      settings.findOne!.mockResolvedValue(buildSettings({ galleryMaxImageSizeMb: 1 }));

      await expect(
        service.submit(
          MEMBER_USER,
          {
            title: 't',
            type: GalleryType.Image,
            files: [file({ sizeBytes: String(2 * 1024 * 1024) })],
          },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a file whose type is not in the settings allow-list (T-0071)', async () => {
      settings.findOne!.mockResolvedValue(
        buildSettings({ galleryAllowedImageTypes: ['png', 'webp'] }),
      );

      await expect(
        service.submit(
          MEMBER_USER,
          {
            title: 't',
            type: GalleryType.Image,
            files: [file({ fileName: 'sneaky.gif', mediaType: GalleryMediaType.Image })],
          },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('resolves an uploaded file key to a public URL (T-0071)', async () => {
      settings.findOne!.mockResolvedValue(buildSettings({ galleryAllowedImageTypes: ['png'] }));
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));

      await service.submit(
        MEMBER_USER,
        {
          title: 't',
          type: GalleryType.Image,
          files: [file({ fileName: 'shot.png', key: `gallery/${REGIMENT}/member-1/shot.png` })],
        },
        null,
      );

      const createdFiles = txFiles.create!.mock.calls[0][0] as Partial<GalleryFile>;
      expect(createdFiles.url).toBe(`https://cdn.example/gallery/${REGIMENT}/member-1/shot.png`);
    });

    it('persists de-duplicated free-form tags (T-0088)', async () => {
      settings.findOne!.mockResolvedValue(buildSettings());
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));

      await service.submit(
        MEMBER_USER,
        { title: 't', type: GalleryType.Image, tags: ['clutch', 'clutch', 'melee'] },
        null,
      );

      expect(txTags.insert).toHaveBeenCalledTimes(1);
      const rows = txTags.insert!.mock.calls[0][0] as Array<{ galleryItemId: string; tag: string }>;
      expect(rows.map((r) => r.tag)).toEqual(['clutch', 'melee']);
      expect(rows.every((r) => r.galleryItemId === 'gallery-new')).toBe(true);
    });

    it('writes no tag rows when none are supplied (T-0088)', async () => {
      settings.findOne!.mockResolvedValue(buildSettings());
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));

      await service.submit(MEMBER_USER, { title: 't', type: GalleryType.Image }, null);

      expect(txTags.insert).not.toHaveBeenCalled();
    });
  });

  describe('findPublic', () => {
    it('throws Forbidden when the gallery is private', async () => {
      settings.find!.mockResolvedValue([buildSettings({ publicGallery: false })]);

      await expect(service.findPublic(query)).rejects.toBeInstanceOf(ForbiddenException);
      expect(items.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns an empty page when no regiment settings exist', async () => {
      settings.find!.mockResolvedValue([]);
      const result = await service.findPublic(query);
      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(items.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('lists approved items for the regiment and never sets `liked`', async () => {
      settings.find!.mockResolvedValue([buildSettings()]);
      const qb = makeListQb([buildItem()], 1);
      items.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.findPublic(query);

      expect(qb.andWhere).toHaveBeenCalledWith('item.status = :status', {
        status: GalleryStatus.Approved,
      });
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.data[0].liked).toBeUndefined();
      expect(result.data[0].author).toEqual({ memberId: 'member-1', name: 'Jane Doe' });
    });
  });

  describe('findOnePublic', () => {
    it('throws NotFound when the item is missing / not approved', async () => {
      settings.find!.mockResolvedValue([buildSettings()]);
      items.findOne!.mockResolvedValue(null);
      await expect(service.findOnePublic('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Forbidden when the gallery is private', async () => {
      settings.find!.mockResolvedValue([buildSettings({ publicGallery: false })]);
      await expect(service.findOnePublic('gallery-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(items.findOne).not.toHaveBeenCalled();
    });
  });

  describe('moderationQueue', () => {
    it('lists pending items scoped to the caller regiment (default status)', async () => {
      const qb = makeListQb([buildItem({ status: GalleryStatus.Pending })], 1);
      items.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.moderationQueue(ADMIN_USER, query);

      expect(qb.where).toHaveBeenCalledWith('item.regimentId = :regimentId', {
        regimentId: REGIMENT,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('item.status = :status', {
        status: GalleryStatus.Pending,
      });
      expect(result.data).toHaveLength(1);
    });

    it('honors status=declined so the Declined tab populates with reasons (T-0089)', async () => {
      const qb = makeListQb(
        [buildItem({ status: GalleryStatus.Declined, declineReason: 'Off-topic' })],
        1,
      );
      items.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.moderationQueue(ADMIN_USER, {
        ...query,
        status: GalleryStatus.Declined,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('item.status = :status', {
        status: GalleryStatus.Declined,
      });
      expect(result.data[0].declineReason).toBe('Off-topic');
    });

    it('honors status=approved (T-0089)', async () => {
      const qb = makeListQb([buildItem({ status: GalleryStatus.Approved })], 1);
      items.createQueryBuilder!.mockReturnValue(qb);

      await service.moderationQueue(ADMIN_USER, { ...query, status: GalleryStatus.Approved });

      expect(qb.andWhere).toHaveBeenCalledWith('item.status = :status', {
        status: GalleryStatus.Approved,
      });
    });
  });

  describe('findArchive (T-0086)', () => {
    it('lists approved items for the caller regiment ignoring publicGallery, with liked populated', async () => {
      // No public settings row / privacy is never consulted on this path.
      const qb = makeListQb([buildItem()], 1);
      items.createQueryBuilder!.mockReturnValue(qb);
      likes.find!.mockResolvedValue([{ galleryItemId: 'gallery-1', memberId: 'member-1' }]);

      const result = await service.findArchive(MEMBER_USER, query);

      expect(settings.find).not.toHaveBeenCalled();
      expect(qb.andWhere).toHaveBeenCalledWith('item.status = :status', {
        status: GalleryStatus.Approved,
      });
      expect(result.data[0].liked).toBe(true);
    });
  });

  describe('pendingSummary (T-0094)', () => {
    it('returns lean { id, title, submitterUsername } for pending items', async () => {
      const qb = makeSelectQb([
        { id: 'gallery-1', title: 'The charge at dawn', submitterUsername: 'Jane Doe' },
      ]);
      items.createQueryBuilder!.mockReturnValue(qb);

      const result = await service.pendingSummary(ADMIN_USER);

      expect(qb.andWhere).toHaveBeenCalledWith('item.status = :status', {
        status: GalleryStatus.Pending,
      });
      expect(result).toEqual([
        { id: 'gallery-1', title: 'The charge at dawn', submitterUsername: 'Jane Doe' },
      ]);
    });
  });

  describe('approve', () => {
    it('sets Approved + approvedAt + moderator and clears declineReason', async () => {
      items.findOne!.mockResolvedValue(
        buildItem({ status: GalleryStatus.Pending, approvedAt: null, declineReason: 'old' }),
      );

      const result = await service.approve(ADMIN_USER, 'gallery-1', '1.1.1.1');

      const saved = items.save!.mock.calls[0][0] as GalleryItem;
      expect(saved.status).toBe(GalleryStatus.Approved);
      expect(saved.approvedAt).toBeInstanceOf(Date);
      expect(saved.moderatedByMemberId).toBe('member-admin');
      expect(saved.declineReason).toBeNull();
      expect(result.status).toBe(GalleryStatus.Approved);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'gallery.approve' }),
      );
    });

    it('throws NotFound for a missing/wrong-regiment item', async () => {
      items.findOne!.mockResolvedValue(null);
      await expect(service.approve(ADMIN_USER, 'missing', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('decline', () => {
    it('sets Declined + reason + moderator and audits', async () => {
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));

      const result = await service.decline(ADMIN_USER, 'gallery-1', { reason: 'Off-topic' }, null);

      const saved = items.save!.mock.calls[0][0] as GalleryItem;
      expect(saved.status).toBe(GalleryStatus.Declined);
      expect(saved.declineReason).toBe('Off-topic');
      expect(saved.moderatedByMemberId).toBe('member-admin');
      expect(result.declineReason).toBe('Off-topic');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'gallery.decline' }),
      );
    });

    it('DMs the submitter with the reason after the decision commits (T-0090)', async () => {
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        discordIdentity: { discordUserId: 'discord-author' },
      } as unknown as Member);

      await service.decline(ADMIN_USER, 'gallery-1', { reason: 'Off-topic' }, null);

      expect(discordSync.enqueueApplicationDecision).toHaveBeenCalledTimes(1);
      const [regimentId, payload] = discordSync.enqueueApplicationDecision.mock.calls[0];
      expect(regimentId).toBe(REGIMENT);
      expect(payload.discordUserId).toBe('discord-author');
      expect(payload.content).toContain('Off-topic');
    });

    it('does not DM when the submitter has no linked Discord identity (T-0090)', async () => {
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));
      members.findOne!.mockResolvedValue({ id: 'member-1', discordIdentity: null } as Member);

      await service.decline(ADMIN_USER, 'gallery-1', { reason: 'x' }, null);

      expect(discordSync.enqueueApplicationDecision).not.toHaveBeenCalled();
    });

    it('never fails the decline when the DM enqueue throws (T-0090)', async () => {
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));
      members.findOne!.mockRejectedValue(new Error('db down'));

      await expect(
        service.decline(ADMIN_USER, 'gallery-1', { reason: 'x' }, null),
      ).resolves.toMatchObject({ status: GalleryStatus.Declined });
    });
  });

  describe('approve', () => {
    it('does NOT DM on approve (T-0090)', async () => {
      items.findOne!.mockResolvedValue(buildItem({ status: GalleryStatus.Pending }));
      await service.approve(ADMIN_USER, 'gallery-1', null);
      expect(discordSync.enqueueApplicationDecision).not.toHaveBeenCalled();
    });
  });

  describe('like / unlike', () => {
    it('is idempotent: a second like does not insert a duplicate row', async () => {
      items.findOne!.mockResolvedValue(buildItem());
      likes
        .findOne!.mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ galleryItemId: 'gallery-1', memberId: 'member-1' });
      likes.count!.mockResolvedValue(1);

      const first = await service.like(MEMBER_USER, 'gallery-1');
      const second = await service.like(MEMBER_USER, 'gallery-1');

      expect(first).toEqual({ likesCount: 1, liked: true });
      expect(second).toEqual({ likesCount: 1, liked: true });
      expect(likes.save).toHaveBeenCalledTimes(1);
    });

    it('forbids liking when the caller is not an enrolled member', async () => {
      await expect(service.like(ANON_USER, 'gallery-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(items.findOne).not.toHaveBeenCalled();
    });

    it('unlike deletes the caller row and reports the fresh state', async () => {
      items.findOne!.mockResolvedValue(buildItem());
      likes.count!.mockResolvedValue(0);

      const result = await service.unlike(MEMBER_USER, 'gallery-1');

      expect(likes.delete).toHaveBeenCalledWith({
        galleryItemId: 'gallery-1',
        memberId: 'member-1',
      });
      expect(result).toEqual({ likesCount: 0, liked: false });
    });
  });

  describe('remove', () => {
    it('soft-deletes the item and audits the deletion', async () => {
      const item = buildItem();
      items.findOne!.mockResolvedValue(item);

      await service.remove(ADMIN_USER, 'gallery-1', null);

      expect(items.softRemove).toHaveBeenCalledWith(item);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'gallery.delete' }),
      );
    });
  });
});
