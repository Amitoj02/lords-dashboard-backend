import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuthzService } from '../authz/authz.service';
import { Capability, StorageTarget } from '../common/enums';
import { AppConfig, StorageConfig } from '../config/configuration';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { PresignedUploadDto } from './dto/presigned-upload.dto';
import { RequestUploadDto } from './dto/request-upload.dto';

/** A file kind for the content-type / size policy. */
type AssetKind = 'image' | 'video';

/** Allowed MIME types → the extension stored in the object key. */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Fallback caps (MB) for gallery when no regiment_settings row exists — mirror GalleryService. */
const DEFAULT_MAX_IMAGE_MB = 12;
const DEFAULT_MAX_VIDEO_MB = 80;

/** Per-target upload policy: which kinds are allowed + the image size cap (MB). */
interface TargetPolicy {
  kinds: AssetKind[];
  /** Image cap in MB; gallery videos use the settings/default video cap instead. */
  maxImageMb: number;
  /** Required capability, or null for self-service member targets (needs memberId). */
  capability: Capability | null;
}

const TARGET_POLICY: Record<StorageTarget, TargetPolicy> = {
  [StorageTarget.MemberAvatar]: { kinds: ['image'], maxImageMb: 8, capability: null },
  [StorageTarget.MemberBanner]: { kinds: ['image'], maxImageMb: 12, capability: null },
  [StorageTarget.EventBanner]: {
    kinds: ['image'],
    maxImageMb: 12,
    capability: Capability.ManageEvents,
  },
  [StorageTarget.MedalImage]: {
    kinds: ['image'],
    maxImageMb: 4,
    capability: Capability.EditRanksMedals,
  },
  [StorageTarget.RankImage]: {
    kinds: ['image'],
    maxImageMb: 4,
    capability: Capability.EditRanksMedals,
  },
  [StorageTarget.Gallery]: {
    kinds: ['image', 'video'],
    maxImageMb: DEFAULT_MAX_IMAGE_MB,
    capability: Capability.SubmitToGallery,
  },
};

/**
 * Object storage for user uploads via a presigned-PUT flow (T-0066). The client
 * declares its intent (target + content-type + size); the server validates that
 * against the target's policy and the caller's capability, then issues a
 * presigned PUT URL bound to a namespaced key. The bytes never pass through the
 * API — the browser PUTs straight to MinIO/S3. When the client submits the key
 * back to a resource, {@link resolveKeyToPublicUrl} re-validates the key's
 * namespace (so nobody can claim another member's/target's key) and returns the
 * clean public URL to persist. Presigning is offline HMAC signing — no network
 * I/O — so this is fully unit-testable without a live bucket.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly cfg: StorageConfig;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly authz: AuthzService,
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
  ) {
    this.cfg = config.get('storage', { infer: true });
    this.s3 = new S3Client({
      endpoint: this.cfg.endpoint,
      region: this.cfg.region,
      forcePathStyle: this.cfg.forcePathStyle,
      credentials: {
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
      },
    });
  }

  /**
   * Validate + authorize an upload and issue a presigned PUT URL. Rejects (400)
   * a disallowed content-type or an oversize file BEFORE any URL is issued, and
   * (403) a caller lacking the target's capability / enrollment.
   */
  async createUploadTicket(
    user: AuthenticatedUser,
    dto: RequestUploadDto,
  ): Promise<PresignedUploadDto> {
    const policy = TARGET_POLICY[dto.target];
    const contentType = dto.contentType.toLowerCase();
    const kind = this.kindOf(contentType);

    if (kind === null || !policy.kinds.includes(kind)) {
      throw new BadRequestException(
        `Unsupported content type for ${dto.target}: ${dto.contentType}`,
      );
    }

    const maxMb = await this.maxMbFor(dto.target, kind, user.regimentId);
    const capMb = Math.min(maxMb, this.cfg.maxUploadMb);
    if (dto.sizeBytes > capMb * 1024 * 1024) {
      throw new BadRequestException(`File exceeds the ${capMb} MB limit for ${dto.target}`);
    }

    await this.authorize(user, dto.target, policy);

    const ext = kind === 'image' ? IMAGE_TYPES[contentType] : VIDEO_TYPES[contentType];
    const key = `${this.namespacePrefix(user, dto.target)}${randomUUID()}.${ext}`;

    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType }),
      { expiresIn: this.cfg.presignExpirySeconds },
    );

    return {
      key,
      uploadUrl,
      publicUrl: this.publicUrlForKey(key),
      expiresIn: this.cfg.presignExpirySeconds,
      requiredContentType: contentType,
    };
  }

  /**
   * Re-validate a client-submitted key against the namespace it must live in for
   * this target + caller, and return the public URL to persist. Throws (400) when
   * the key is outside the namespace (e.g. another member's) or malformed. This
   * is the single entry point every resource uses when accepting an uploaded key.
   */
  resolveKeyToPublicUrl(user: AuthenticatedUser, key: string, target: StorageTarget): string {
    const prefix = this.namespacePrefix(user, target);
    if (!key.startsWith(prefix)) {
      throw new BadRequestException('Uploaded key is outside the expected namespace');
    }
    const remainder = key.slice(prefix.length);
    // The generated tail is always `<uuid>.<ext>` — reject anything with a path
    // separator or traversal, so a crafted key can't escape its namespace.
    if (!/^[a-z0-9-]+\.[a-z0-9]+$/i.test(remainder)) {
      throw new BadRequestException('Malformed object key');
    }
    return this.publicUrlForKey(key);
  }

  /** The stable, query-string-free public URL an object is served from. */
  publicUrlForKey(key: string): string {
    return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private kindOf(contentType: string): AssetKind | null {
    if (contentType in IMAGE_TYPES) return 'image';
    if (contentType in VIDEO_TYPES) return 'video';
    return null;
  }

  /** Effective size cap (MB) for a target/kind — gallery reads regiment_settings. */
  private async maxMbFor(
    target: StorageTarget,
    kind: AssetKind,
    regimentId: string,
  ): Promise<number> {
    if (target !== StorageTarget.Gallery) {
      return TARGET_POLICY[target].maxImageMb;
    }
    const settings = await this.settings.findOne({ where: { regimentId } });
    return kind === 'video'
      ? (settings?.galleryMaxVideoSizeMb ?? DEFAULT_MAX_VIDEO_MB)
      : (settings?.galleryMaxImageSizeMb ?? DEFAULT_MAX_IMAGE_MB);
  }

  /** Enforce the target's capability (or member enrollment for self-service targets). */
  private async authorize(
    user: AuthenticatedUser,
    target: StorageTarget,
    policy: TargetPolicy,
  ): Promise<void> {
    if (policy.capability === null) {
      // Self-service (member avatar/banner): must be an enrolled member.
      if (!user.memberId) {
        throw new ForbiddenException('Only enrolled members can upload profile images');
      }
      return;
    }
    const granted = await this.authz.can(user.regimentId, user.role, policy.capability);
    if (!granted) {
      throw new ForbiddenException(`Missing capability: ${policy.capability}`);
    }
  }

  /** The key namespace an upload for this target + caller must live under. */
  private namespacePrefix(user: AuthenticatedUser, target: StorageTarget): string {
    const reg = user.regimentId;
    switch (target) {
      case StorageTarget.MemberAvatar:
        return `members/${reg}/${this.requireMember(user)}/avatar/`;
      case StorageTarget.MemberBanner:
        return `members/${reg}/${this.requireMember(user)}/banner/`;
      case StorageTarget.EventBanner:
        return `events/${reg}/`;
      case StorageTarget.MedalImage:
        return `medals/${reg}/`;
      case StorageTarget.RankImage:
        return `ranks/${reg}/`;
      case StorageTarget.Gallery:
        return `gallery/${reg}/${this.requireMember(user)}/`;
    }
  }

  private requireMember(user: AuthenticatedUser): string {
    if (!user.memberId) {
      throw new ForbiddenException('Only enrolled members can upload here');
    }
    return user.memberId;
  }
}
