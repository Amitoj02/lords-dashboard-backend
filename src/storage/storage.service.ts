import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
import { AcceptedTypeDto, StoragePolicyDto } from './dto/storage-policy.dto';

/** A file kind for the content-type / size policy. */
type AssetKind = 'image' | 'video';

/** Allowed MIME types → the extension stored in the object key (default image set). */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
/**
 * Rank/medal icon targets accept raster icons only: PNG + WebP (T-0124; WebP added
 * T-0130) — not the JPEG of the default raster set. WebP is a compact raster icon
 * format, capped to the same 250px-per-side dimension as PNG (see
 * {@link StorageService.assertIconWithinDimensions}).
 *
 * SVG was REMOVED (LDA-M3): an <img>-rendered SVG is inert, but a member with
 * EditRanksMedals could still host a scripted SVG that executes when the object is
 * directly navigated on the brand CDN subdomain. Dropping it here means such a
 * body can never be uploaded to an icon target in the first place. (The server
 * never re-reads uploaded bytes, so type enforcement has to live at the presign.)
 */
const ICON_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
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

/** The max pixel dimension (per side) allowed for a rank/medal icon (T-0125). */
const ICON_MAX_DIMENSION_PX = 250;

/** Per-target upload policy: which kinds are allowed + the image size cap (MB). */
interface TargetPolicy {
  kinds: AssetKind[];
  /** Image cap in MB; gallery videos use the settings/default video cap instead. */
  maxImageMb: number;
  /** Required capability, or null for self-service member targets (needs memberId). */
  capability: Capability | null;
  /** Overrides the default image MIME set (e.g. icons: PNG+SVG only). */
  imageTypes?: Record<string, string>;
  /** Enforce the 250px dimension cap for this target's images (rank/medal icons). */
  enforceIconDimensions?: boolean;
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
    imageTypes: ICON_IMAGE_TYPES,
    enforceIconDimensions: true,
  },
  [StorageTarget.RankImage]: {
    kinds: ['image'],
    maxImageMb: 4,
    capability: Capability.EditRanksMedals,
    imageTypes: ICON_IMAGE_TYPES,
    enforceIconDimensions: true,
  },
  [StorageTarget.Gallery]: {
    kinds: ['image', 'video'],
    maxImageMb: DEFAULT_MAX_IMAGE_MB,
    capability: Capability.SubmitToGallery,
  },
  // Public-facing page backgrounds (T-0148). These are full-bleed photographs
  // behind a scrim, so they get the generous banner cap rather than the icon
  // cap — but the default raster set only (no SVG: an SVG background would be
  // rendered as a CSS `url()`, not through the <img> secure-static-mode path
  // that makes SVG safe for rank/medal icons).
  [StorageTarget.RegimentHeroBanner]: {
    kinds: ['image'],
    maxImageMb: 12,
    capability: Capability.ManageRegimentDetails,
  },
  [StorageTarget.RegimentLoginBanner]: {
    kinds: ['image'],
    maxImageMb: 12,
    capability: Capability.ManageRegimentDetails,
  },
  // A single decoded video frame (T-0152) — same permission as the submission
  // it belongs to, with a small cap because it is one still image.
  [StorageTarget.GalleryPoster]: {
    kinds: ['image'],
    maxImageMb: 4,
    capability: Capability.SubmitToGallery,
  },
};

/**
 * Parse a PNG's pixel dimensions from its IHDR chunk (the first 24 bytes: an
 * 8-byte signature, then a 4-byte length + the ASCII "IHDR" tag + 4-byte width +
 * 4-byte height, all big-endian). Returns null for anything that is not a PNG we
 * can read, so callers can decide the fallback policy.
 */
function parsePngDimensions(header: Buffer): { width: number; height: number } | null {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (header.length < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  if (header.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return null;
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * Parse a WebP's pixel dimensions from its RIFF header (T-0130). A WebP is a
 * "RIFF"…"WEBP" container whose first chunk is one of three VP8 variants, each
 * encoding the dimensions differently:
 *  - "VP8 " (lossy): a 3-byte start code (0x9d 0x01 0x2a) at offset 23, then a
 *    14-bit little-endian width and height at offsets 26 and 28.
 *  - "VP8L" (lossless): a 0x2f signature at offset 20, then packed 14-bit
 *    (width-1) and (height-1) in the next 4 little-endian bytes.
 *  - "VP8X" (extended): a 24-bit little-endian (canvas width-1)/(canvas height-1)
 *    at offsets 24 and 27.
 * Returns null for anything that is not a WebP header we can read (so the caller
 * applies its fallback policy). The header must be at least 30 bytes to cover the
 * furthest-out field (VP8 / VP8X); the reader fetches 32.
 */
function parseWebpDimensions(header: Buffer): { width: number; height: number } | null {
  if (
    header.length < 30 ||
    header.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    header.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null;
  }
  const format = header.subarray(12, 16).toString('ascii');
  if (format === 'VP8 ') {
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === 'VP8L') {
    if (header[20] !== 0x2f) {
      return null;
    }
    const bits = header.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (format === 'VP8X') {
    return {
      width: (header[24] | (header[25] << 8) | (header[26] << 16)) + 1,
      height: (header[27] | (header[28] << 8) | (header[29] << 16)) + 1,
    };
  }
  return null;
}

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
      // AWS SDK v3.729.0 (2025-01-15) made CRC32 request checksums the default
      // ("WHEN_SUPPORTED"), which briefly broke every non-AWS S3 backend —
      // R2, MinIO, Backblaze B2 and Spaces all rejected x-amz-checksum-crc32.
      // Cloudflare fixed the header case server-side on 2025-02-03, but the SDK
      // default was never reverted, and the *streaming* path is still fragile:
      // a Node Readable body takes the aws-chunked / STREAMING-UNSIGNED-PAYLOAD-
      // TRAILER route, whose acceptance by R2 is unconfirmed. Pinning both knobs
      // to WHEN_REQUIRED keeps local MinIO dev and prod R2 on one identical code
      // path and costs nothing — the presigned-PUT flow below never needs them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
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
    const imageTypes = policy.imageTypes ?? IMAGE_TYPES;
    const contentType = dto.contentType.toLowerCase();
    const kind = this.kindOf(contentType, imageTypes);

    if (kind === null || !policy.kinds.includes(kind)) {
      throw new BadRequestException(
        `Unsupported content type for ${dto.target}: ${dto.contentType}`,
      );
    }

    const maxMb = await this.maxMbFor(dto.target, kind, user.regimentId);
    const capMb = Math.min(maxMb, this.cfg.maxUploadMb);
    if (dto.sizeBytes > capMb * 1024 * 1024) {
      // User-facing copy standardized across every upload target (T-0107) so the
      // frontend can surface it verbatim.
      throw new BadRequestException(`Your file size exceeds the limit of ${capMb} MB`);
    }

    await this.authorize(user, dto.target, policy);

    const ext = kind === 'image' ? imageTypes[contentType] : VIDEO_TYPES[contentType];
    const key = `${this.namespacePrefix(user, dto.target)}${randomUUID()}.${ext}`;

    // Sign the exact Content-Length as well as the Content-Type: because both are
    // signed headers, the client must PUT exactly `sizeBytes` bytes of this type —
    // it cannot swap in a larger body to bypass the (already validated) size cap.
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: dto.sizeBytes,
      }),
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
    // The generated tail is ALWAYS `<uuid>.<ext>` (see createUploadTicket). Match
    // exactly that shape: rejects path traversal AND structurally bounds the key
    // length, so the resolved public URL can never overflow the varchar(512)
    // columns it is persisted into (a MaxLength(512)-valid but long filler key
    // would otherwise yield a >512-char URL → ER_DATA_TOO_LONG / truncation).
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i.test(
        remainder,
      )
    ) {
      throw new BadRequestException('Malformed object key');
    }
    return this.publicUrlForKey(key);
  }

  /** The stable, query-string-free public URL an object is served from. */
  publicUrlForKey(key: string): string {
    return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }

  /**
   * The static per-target upload policy (T-0119): size caps + accepted types, so
   * the frontend derives its upload hints from a single source of truth. Every
   * cap is the target's own limit capped by the global S3 ceiling (the same
   * `min(maxMb, maxUploadMb)` {@link createUploadTicket} enforces). Gallery caps
   * here are the static defaults — the live, admin-configurable gallery caps come
   * from GET /api/settings; the frontend reads gallery limits from there.
   */
  getPolicy(): StoragePolicyDto {
    const cap = (mb: number): number => Math.min(mb, this.cfg.maxUploadMb);
    const image: AcceptedTypeDto = {
      mimeTypes: Object.keys(IMAGE_TYPES),
      extensions: Object.values(IMAGE_TYPES),
    };
    const video: AcceptedTypeDto = {
      mimeTypes: Object.keys(VIDEO_TYPES),
      extensions: Object.values(VIDEO_TYPES),
    };

    const targets = (Object.keys(TARGET_POLICY) as StorageTarget[]).map((target) => {
      const policy = TARGET_POLICY[target];
      const acceptsVideo = policy.kinds.includes('video');
      // Icon targets override the default image set (PNG+SVG only) — report that.
      const targetImageTypes = policy.imageTypes ?? IMAGE_TYPES;
      const targetImage: AcceptedTypeDto = {
        mimeTypes: Object.keys(targetImageTypes),
        extensions: Object.values(targetImageTypes),
      };
      return {
        target,
        kinds: policy.kinds,
        maxImageMb: cap(policy.maxImageMb),
        // Only gallery accepts video today; its default video cap is the static
        // fallback (the live cap is admin-configurable via settings).
        maxVideoMb: acceptsVideo ? cap(DEFAULT_MAX_VIDEO_MB) : null,
        acceptedMimeTypes: policy.kinds.flatMap((kind) =>
          kind === 'image' ? targetImage.mimeTypes : video.mimeTypes,
        ),
        acceptedExtensions: policy.kinds.flatMap((kind) =>
          kind === 'image' ? targetImage.extensions : video.extensions,
        ),
      };
    });

    return { maxUploadMb: this.cfg.maxUploadMb, image, video, targets };
  }

  /**
   * Best-effort delete of a stored object, given the public URL it was persisted
   * under (the exact inverse of {@link publicUrlForKey}). Used when a resource
   * that owns uploaded media is removed (e.g. a gallery item) so the bytes don't
   * outlive the row. A URL outside our public base (external/link-type media, or
   * a file stored with no key) is skipped, and any storage error — including an
   * already-missing object — is swallowed: purging media must never fail or roll
   * back the owning delete. (S3/MinIO DeleteObject is itself idempotent for
   * absent keys.)
   */
  async deleteObject(url: string): Promise<void> {
    const base = `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/`;
    if (!url.startsWith(base)) {
      this.logger.warn(`Skipping delete of object outside the storage base: ${url}`);
      return;
    }
    const key = url.slice(base.length);
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    } catch (error) {
      this.logger.warn(`Failed to delete object ${key}: ${(error as Error).message}`);
    }
  }

  /**
   * Enforce the 250px icon dimension cap (T-0125) on a freshly-uploaded rank/medal
   * image key, BEFORE it is persisted. The bytes never pass through the API (they
   * are PUT straight to storage), so a client-declared width/height can't be
   * trusted — instead we read the stored object's header directly:
   *  - PNG / WebP: a ranged GET of the header gives the exact pixel dimensions;
   *    either side over the cap is rejected (400). This holds even when the client
   *    under-declares the size, because we read the real pixels.
   *  - SVG: exempt — a scalable vector has no intrinsic raster dimension (it is
   *    bounded by its viewBox at render time), so there is nothing to cap.
   * A transient read failure is logged and allowed (fail-open for availability): a
   * genuine oversize raster icon is always readable here, moments after its own
   * upload.
   */
  async assertIconWithinDimensions(key: string, maxPx = ICON_MAX_DIMENSION_PX): Promise<void> {
    if (key.toLowerCase().endsWith('.svg')) {
      return;
    }
    let header: Buffer;
    try {
      // 32 bytes covers both the PNG IHDR and the furthest-out WebP dimension field.
      header = await this.readObjectHead(key, 32);
    } catch (error) {
      this.logger.warn(
        `Could not read ${key} to validate icon dimensions: ${(error as Error).message}`,
      );
      return;
    }
    const dims = parsePngDimensions(header) ?? parseWebpDimensions(header);
    if (!dims) {
      // Not a PNG/WebP we can parse — the MIME allow-list already restricts icons
      // to PNG/WebP (SVG dropped, LDA-M3), so this is an unreadable/corrupt object;
      // leave it to fail on use. (The .svg short-circuit above still covers any
      // legacy SVG icon uploaded before M3.)
      return;
    }
    if (dims.width > maxPx || dims.height > maxPx) {
      throw new BadRequestException(
        `Icon image must be at most ${maxPx}×${maxPx}px (got ${dims.width}×${dims.height})`,
      );
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Read the first `bytes` of a stored object (a bounded, ranged GET). */
  private async readObjectHead(key: string, bytes: number): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    if (!res.Body) {
      throw new Error('Empty object body');
    }
    // The S3 client's stream mixin collects the (already range-bounded) bytes.
    const array = await res.Body.transformToByteArray();
    return Buffer.from(array);
  }

  private kindOf(
    contentType: string,
    imageTypes: Record<string, string> = IMAGE_TYPES,
  ): AssetKind | null {
    if (contentType in imageTypes) return 'image';
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
      case StorageTarget.GalleryPoster:
        // Deliberately a sub-path of the Gallery prefix. A Gallery key resolved
        // as a poster fails the startsWith check; a poster key resolved as
        // Gallery media leaves `posters/<uuid>.<ext>` as the remainder, which
        // the `<uuid>.<ext>` shape check rejects. Neither can impersonate the
        // other.
        return `gallery/${reg}/${this.requireMember(user)}/posters/`;
      case StorageTarget.RegimentHeroBanner:
        return `regiments/${reg}/hero/`;
      case StorageTarget.RegimentLoginBanner:
        return `regiments/${reg}/login/`;
    }
  }

  private requireMember(user: AuthenticatedUser): string {
    if (!user.memberId) {
      throw new ForbiddenException('Only enrolled members can upload here');
    }
    return user.memberId;
  }
}
