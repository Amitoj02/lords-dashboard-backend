import { ApiProperty } from '@nestjs/swagger';
import { StorageTarget } from '../../common/enums';

/** The accepted content types for one asset kind (image | video). */
export class AcceptedTypeDto {
  @ApiProperty({ description: 'Accepted MIME types', example: ['image/png', 'image/jpeg'] })
  mimeTypes: string[];

  @ApiProperty({
    description: 'File extensions stored for those MIME types',
    example: ['png', 'jpg'],
  })
  extensions: string[];
}

/** The upload policy for a single storage target. */
export class StorageTargetPolicyDto {
  @ApiProperty({ enum: StorageTarget, description: 'The upload target this policy applies to' })
  target: StorageTarget;

  @ApiProperty({ description: 'Asset kinds this target accepts', example: ['image'] })
  kinds: ('image' | 'video')[];

  @ApiProperty({
    description:
      'Effective image size cap in MB (the target policy capped by the global S3 upload ceiling)',
  })
  maxImageMb: number;

  @ApiProperty({
    nullable: true,
    description: 'Effective video size cap in MB, or null for image-only targets',
  })
  maxVideoMb: number | null;

  @ApiProperty({ description: 'Every accepted MIME type across this target’s kinds' })
  acceptedMimeTypes: string[];

  @ApiProperty({ description: 'Every accepted file extension across this target’s kinds' })
  acceptedExtensions: string[];
}

/**
 * Response of GET /api/storage/policy (T-0119). Exposes the hardcoded per-target
 * upload policy (size caps + accepted types) so the frontend derives its
 * upload-size/type hints from a single source of truth instead of hardcoding
 * matching constants. Gallery caps are the static defaults here; the live,
 * admin-configurable gallery caps are served by GET /api/settings instead.
 */
export class StoragePolicyDto {
  @ApiProperty({ description: 'Global upload ceiling in MB (S3_MAX_UPLOAD_MB); caps every target' })
  maxUploadMb: number;

  @ApiProperty({ type: AcceptedTypeDto, description: 'Globally accepted image types' })
  image: AcceptedTypeDto;

  @ApiProperty({ type: AcceptedTypeDto, description: 'Globally accepted video types' })
  video: AcceptedTypeDto;

  @ApiProperty({ type: [StorageTargetPolicyDto], description: 'Per-target upload policy' })
  targets: StorageTargetPolicyDto[];
}
