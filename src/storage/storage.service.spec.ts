import { DeleteObjectCommand } from '@aws-sdk/client-s3';
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

  describe('createUploadTicket — icon targets accept PNG + SVG only (T-0124)', () => {
    it.each([StorageTarget.RankImage, StorageTarget.MedalImage])(
      'rejects a jpeg for %s with 400',
      async (target) => {
        await expect(
          service.createUploadTicket(user(), {
            target,
            contentType: 'image/jpeg',
            sizeBytes: 1024,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it.each([StorageTarget.RankImage, StorageTarget.MedalImage])(
      'rejects a webp for %s with 400',
      async (target) => {
        await expect(
          service.createUploadTicket(user(), {
            target,
            contentType: 'image/webp',
            sizeBytes: 1024,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('accepts a png for a rank image and stores it with a .png key', async () => {
      const ticket = await service.createUploadTicket(user(), {
        target: StorageTarget.RankImage,
        contentType: 'image/png',
        sizeBytes: 1024,
      });
      expect(ticket.key).toMatch(new RegExp(`^ranks/${REGIMENT}/[0-9a-f-]+\\.png$`));
      expect(ticket.requiredContentType).toBe('image/png');
    });

    it('accepts an svg for a medal image and stores it with a .svg key', async () => {
      const ticket = await service.createUploadTicket(user(), {
        target: StorageTarget.MedalImage,
        contentType: 'image/svg+xml',
        sizeBytes: 1024,
      });
      expect(ticket.key).toMatch(new RegExp(`^medals/${REGIMENT}/[0-9a-f-]+\\.svg$`));
      expect(ticket.requiredContentType).toBe('image/svg+xml');
    });

    it('reports PNG+SVG accepted types for the icon targets in getPolicy', () => {
      const byTarget = Object.fromEntries(service.getPolicy().targets.map((t) => [t.target, t]));

      for (const target of [StorageTarget.RankImage, StorageTarget.MedalImage]) {
        expect(byTarget[target].acceptedMimeTypes).toEqual(['image/png', 'image/svg+xml']);
        expect(byTarget[target].acceptedExtensions).toEqual(['png', 'svg']);
      }

      // Other image targets still report the default raster set.
      expect(byTarget[StorageTarget.MemberAvatar].acceptedMimeTypes).toEqual([
        'image/png',
        'image/jpeg',
        'image/webp',
      ]);
      expect(byTarget[StorageTarget.MemberAvatar].acceptedExtensions).toEqual([
        'png',
        'jpg',
        'webp',
      ]);
    });
  });

  describe('assertIconWithinDimensions (T-0125)', () => {
    /** A 24-byte PNG header whose IHDR carries the given pixel dimensions. */
    const pngHeader = (width: number, height: number): Uint8Array => {
      const buf = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
      buf.writeUInt32BE(13, 8); // IHDR chunk length
      buf.write('IHDR', 12, 'ascii');
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return new Uint8Array(buf);
    };

    /** Mock the S3 client's send() to resolve a GetObject body wrapping `bytes`. */
    const mockGet = (bytes: Uint8Array) =>
      jest
        .spyOn((service as unknown as { s3: { send: jest.Mock } }).s3, 'send')
        .mockResolvedValue({ Body: { transformToByteArray: () => Promise.resolve(bytes) } });

    it('rejects a PNG whose width exceeds the cap with 400', async () => {
      mockGet(pngHeader(300, 100));
      await expect(
        service.assertIconWithinDimensions(`ranks/${REGIMENT}/icon.png`),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves for a PNG exactly at the cap', async () => {
      mockGet(pngHeader(250, 250));
      await expect(
        service.assertIconWithinDimensions(`ranks/${REGIMENT}/icon.png`),
      ).resolves.toBeUndefined();
    });

    it('resolves for a PNG comfortably within the cap', async () => {
      mockGet(pngHeader(240, 180));
      await expect(
        service.assertIconWithinDimensions(`medals/${REGIMENT}/icon.png`),
      ).resolves.toBeUndefined();
    });

    it('exempts an .svg key — resolves without ever calling S3', async () => {
      const send = mockGet(pngHeader(999, 999));
      await expect(
        service.assertIconWithinDimensions(`medals/${REGIMENT}/icon.svg`),
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });

    it('fails open — swallows a read error and resolves', async () => {
      jest
        .spyOn((service as unknown as { s3: { send: jest.Mock } }).s3, 'send')
        .mockRejectedValue(new Error('network'));
      await expect(
        service.assertIconWithinDimensions(`ranks/${REGIMENT}/icon.png`),
      ).resolves.toBeUndefined();
    });
  });

  describe('resolveKeyToPublicUrl', () => {
    const UUID = '550e8400-e29b-41d4-a716-446655440000';

    it('accepts a key in the caller-owned namespace and returns the public URL', () => {
      const key = `members/${REGIMENT}/${MEMBER}/avatar/${UUID}.png`;
      expect(service.resolveKeyToPublicUrl(user(), key, StorageTarget.MemberAvatar)).toBe(
        `http://localhost:9100/lords-media/${key}`,
      );
    });

    it("rejects a key from another member's namespace", () => {
      const key = `members/${REGIMENT}/someone-else/avatar/${UUID}.png`;
      expect(() => service.resolveKeyToPublicUrl(user(), key, StorageTarget.MemberAvatar)).toThrow(
        BadRequestException,
      );
    });

    it('rejects a key from a different target namespace', () => {
      const key = `gallery/${REGIMENT}/${MEMBER}/${UUID}.png`;
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

    it('rejects a long filler tail that is not the generated uuid.ext shape (URL overflow guard)', () => {
      const key = `members/${REGIMENT}/${MEMBER}/avatar/${'a'.repeat(430)}.png`;
      expect(() => service.resolveKeyToPublicUrl(user(), key, StorageTarget.MemberAvatar)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('deleteObject (T-0116)', () => {
    it('deletes the object whose key it recovers from the public URL', async () => {
      const send = jest
        .spyOn((service as unknown as { s3: { send: jest.Mock } }).s3, 'send')
        .mockResolvedValue({});
      const key = `gallery/${REGIMENT}/${MEMBER}/x.png`;

      await service.deleteObject(`${STORAGE_CFG.publicBaseUrl}/${key}`);

      expect(send).toHaveBeenCalledTimes(1);
      const cmd = send.mock.calls[0][0] as DeleteObjectCommand;
      expect(cmd).toBeInstanceOf(DeleteObjectCommand);
      expect(cmd.input).toEqual({ Bucket: STORAGE_CFG.bucket, Key: key });
    });

    it('swallows a storage error (already-missing object) without throwing', async () => {
      jest
        .spyOn((service as unknown as { s3: { send: jest.Mock } }).s3, 'send')
        .mockRejectedValue(new Error('NoSuchKey'));

      await expect(
        service.deleteObject(`${STORAGE_CFG.publicBaseUrl}/gallery/${REGIMENT}/${MEMBER}/gone.png`),
      ).resolves.toBeUndefined();
    });

    it('is a no-op for a URL outside the storage base (never calls S3)', async () => {
      const send = jest
        .spyOn((service as unknown as { s3: { send: jest.Mock } }).s3, 'send')
        .mockResolvedValue({});

      await service.deleteObject('https://youtu.be/abc123');

      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('getPolicy (T-0119)', () => {
    it('exposes each target’s size caps + accepted types with the global ceiling', () => {
      const policy = service.getPolicy();

      expect(policy.maxUploadMb).toBe(STORAGE_CFG.maxUploadMb);
      expect(policy.image.mimeTypes).toEqual(['image/png', 'image/jpeg', 'image/webp']);
      expect(policy.image.extensions).toEqual(['png', 'jpg', 'webp']);
      expect(policy.video.mimeTypes).toEqual(['video/mp4', 'video/webm', 'video/quicktime']);

      const byTarget = Object.fromEntries(policy.targets.map((t) => [t.target, t]));

      // Static image-only targets: cap matches TARGET_POLICY, no video cap.
      expect(byTarget[StorageTarget.MemberAvatar].maxImageMb).toBe(8);
      expect(byTarget[StorageTarget.MemberAvatar].maxVideoMb).toBeNull();
      expect(byTarget[StorageTarget.MemberBanner].maxImageMb).toBe(12);
      expect(byTarget[StorageTarget.EventBanner].maxImageMb).toBe(12);
      expect(byTarget[StorageTarget.MedalImage].maxImageMb).toBe(4);
      expect(byTarget[StorageTarget.RankImage].maxImageMb).toBe(4);

      // Gallery accepts image + video and carries the default video cap.
      const gallery = byTarget[StorageTarget.Gallery];
      expect(gallery.kinds).toEqual(['image', 'video']);
      expect(gallery.maxImageMb).toBe(12);
      expect(gallery.maxVideoMb).toBe(80);
      expect(gallery.acceptedMimeTypes).toContain('image/png');
      expect(gallery.acceptedMimeTypes).toContain('video/mp4');
      expect(gallery.acceptedExtensions).toEqual(['png', 'jpg', 'webp', 'mp4', 'webm', 'mov']);
    });

    it('caps every target at the global S3 ceiling when it is lower than a target policy', () => {
      // Rebuild the service with a 5 MB global ceiling: caps above 5 collapse to 5.
      const capped = new StorageService(
        { get: jest.fn().mockReturnValue({ ...STORAGE_CFG, maxUploadMb: 5 }) } as never,
        authz as never,
        settings as never,
      );
      const byTarget = Object.fromEntries(capped.getPolicy().targets.map((t) => [t.target, t]));
      expect(byTarget[StorageTarget.MemberBanner].maxImageMb).toBe(5); // 12 → 5
      expect(byTarget[StorageTarget.MedalImage].maxImageMb).toBe(4); // 4 stays (below ceiling)
      expect(byTarget[StorageTarget.Gallery].maxVideoMb).toBe(5); // 80 → 5
    });
  });
});
