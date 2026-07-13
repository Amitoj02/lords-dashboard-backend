import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { StorageTarget } from '../../common/enums';

/**
 * Body for POST /api/storage/uploads. The client declares what it intends to
 * upload; the server validates the content-type + size against the target's
 * policy and, only if they pass, issues a presigned PUT URL + a namespaced key.
 * The regiment/member context comes from the JWT, never the body.
 */
export class RequestUploadDto {
  @ApiProperty({ enum: StorageTarget, description: 'What the upload is for' })
  @IsEnum(StorageTarget)
  target: StorageTarget;

  @ApiProperty({ example: 'image/png', description: 'MIME type of the file to upload' })
  @IsString()
  @MaxLength(128)
  // A conservative type/subtype shape; the concrete allow-list is enforced by the target policy.
  @Matches(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, {
    message: 'contentType must be a valid MIME type',
  })
  contentType: string;

  @ApiProperty({ description: 'Exact byte size of the file to upload', minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes: number;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Original filename (used only to derive a clean extension)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}
