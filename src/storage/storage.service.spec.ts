import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthzService } from '../authz/authz.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { Capability, MemberRole, StorageTarget } from '../common/enums';
import { StorageConfig } from '../config/configuration';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { StorageService } from './storage.service';

const REGIMENT = 'reg-1';
const MEMBER = 'mem-1';

const STORAGE_CFG: StorageConfig = {
  endpoint: 'http://localhost:9100',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'lords-media',
  publicBaseUrl: 'http://localhost:9100/lords-media',
  forcePathStyle: true,
  presignExpirySeconds: 900,
  maxUploadMb: 100,
};

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'id-1',
  memberId: MEMBER,
  discordUserId: 'd-1',
  role: MemberRole.Admin,
  regimentId: REGIMENT,
  ...overrides,
});

describe('StorageService', () => {
  let service: StorageService;
  const authz = { can: jest.fn() };
  const settings = { findOne: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    authz.can.mockResolvedValue(true);
    settings.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(STORAGE_CFG) },
        },
        { provide: AuthzService, useValue: authz },
        { provide: getRepositoryToken(RegimentSettings), useValue: settings },
      ],
    }).compile();
    service = module.get(StorageService);
  });

  describe('createUploadTicket', () => {
    it('issues a presigned PUT + public URL + a namespaced key for a member avatar', async () => {
      const ticket = await service.createUploadTicket(user(), {
        target: StorageTarget.MemberAvatar,
        contentType: 'image/png',
        sizeBytes: 1024,
      });

      expect(ticket.key).toMatch(
        new RegExp(`^members/${REGIMENT}/${MEMBER}/avatar/[0-9a-f-]+\\.png$`),
      );
      expect(ticket.uploadUrl).toContain('http://localhost:9100/lords-media/');
      expect(ticket.uploadUrl).toContain('X-Amz-Signature'); // a real presigned URL
      expect(ticket.publicUrl).toBe(`http://localhost:9100/lords-media/${ticket.key}`);
      expect(ticket.requiredContentType).toBe('image/png');
    });

    it('namespaces an event banner under events/{regiment}/ (no memberId needed)', async () => {
      const ticket = await service.createUploadTicket(user(), {
        target: StorageTarget.EventBanner,
        contentType: 'image/webp',
        sizeBytes: 2048,
      });
      expect(ticket.key).toMatch(new RegExp(`^events/${REGIMENT}/[0-9a-f-]+\\.webp$`));
      expect(authz.can).toHaveBeenCalledWith(REGIMENT, MemberRole.Admin, Capability.ManageEvents);
    });

    it('rejects a disallowed content type with 400 before issuing a URL', async () => {
      await expect(
        service.createUploadTicket(user(), {
          target: StorageTarget.MemberAvatar,
          contentType: 'application/x-msdownload',
          sizeBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a video for an image-only target', async () => {
      await expect(
        service.createUploadTicket(user(), {
          target: StorageTarget.EventBanner,
          contentType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an oversize file with 400 (image cap)', async () => {
      await expect(
        service.createUploadTicket(user(), {
          target: StorageTarget.MedalImage, // 4 MB cap
          contentType: 'image/png',
          sizeBytes: 5 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enforces the gallery video cap from regiment_settings', async () => {
      settings.findOne.mockResolvedValue({ regimentId: REGIMENT, galleryMaxVideoSizeMb: 10 });
      await expect(
        service.createUploadTicket(user(), {
          target: StorageTarget.Gallery,
          contentType: 'video/mp4',
          sizeBytes: 20 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Under the cap succeeds.
      const ok = await service.createUploadTicket(user(), {
        target: StorageTarget.Gallery,
        contentType: 'video/mp4',
        sizeBytes: 5 * 1024 * 1024,
      });
      expect(ok.key).toMatch(new RegExp(`^gallery/${REGIMENT}/${MEMBER}/[0-9a-f-]+\\.mp4$`));
    });

    it('rejects a caller lacking the target capability with 403', async () => {
      authz.can.mockResolvedValue(false);
      await expect(
        service.createUploadTicket(user(), {
          target: StorageTarget.MedalImage,
          contentType: 'image/png',
          sizeBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a non-enrolled caller from a self-service member target with 403', async () => {
      await expect(
        service.createUploadTicket(user({ memberId: null }), {
          target: StorageTarget.MemberAvatar,
          contentType: 'image/png',
          sizeBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('resolveKeyToPublicUrl', () => {
    it('accepts a key in the caller-owned namespace and returns the public URL', () => {
      const key = `members/${REGIMENT}/${MEMBER}/avatar/abc-123.png`;
      expect(service.resolveKeyToPublicUrl(user(), key, StorageTarget.MemberAvatar)).toBe(
        `http://localhost:9100/lords-media/${key}`,
      );
    });

    it("rejects a key from another member's namespace", () => {
      const key = `members/${REGIMENT}/someone-else/avatar/abc-123.png`;
      expect(() => service.resolveKeyToPublicUrl(user(), key, StorageTarget.MemberAvatar)).toThrow(
        BadRequestException,
      );
    });

    it('rejects a key from a different target namespace', () => {
      const key = `gallery/${REGIMENT}/${MEMBER}/abc-123.png`;
      expect(() => service.resolveKeyToPublicUrl(user(), key, StorageTarget.MemberAvatar)).toThrow(
        BadRequestException,
      );
    });

    it('rejects a path-traversal key inside the namespace', () => {
      const key = `events/${REGIMENT}/../../etc/passwd`;
      expect(() => service.resolveKeyToPublicUrl(user(), key, StorageTarget.EventBanner)).toThrow(
        BadRequestException,
      );
    });
  });
});
