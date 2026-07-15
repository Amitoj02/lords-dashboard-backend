import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GalleryMediaType, GalleryStatus, GalleryType } from '../../common/enums';
import { GalleryFile } from '../entities/gallery-file.entity';
import { GalleryItem } from '../entities/gallery-item.entity';

/** Lightweight `{ memberId, name }` reference used for the author + tagged members. */
export class GalleryMemberRefDto {
  @ApiProperty({ format: 'uuid' })
  memberId: string;

  @ApiProperty({ example: 'Jane Doe' })
  name: string;
}

/** A single file within a gallery submission (image/video asset). */
export class GalleryFileDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'charge.png' })
  fileName: string;

  @ApiProperty({ nullable: true, description: 'Public URL of the stored asset' })
  url: string | null;

  @ApiProperty({ enum: GalleryMediaType })
  mediaType: GalleryMediaType;

  @ApiProperty({ nullable: true, description: 'Size in bytes (bigint serialized as a string)' })
  sizeBytes: string | null;

  @ApiProperty({ nullable: true })
  width: number | null;

  @ApiProperty({ nullable: true })
  height: number | null;

  @ApiProperty({ nullable: true, description: 'Duration in seconds (video only)' })
  durationSeconds: number | null;

  @ApiProperty({ nullable: true })
  caption: string | null;

  @ApiProperty({ nullable: true, example: '#1a2b3c', description: 'Dominant color hex' })
  thumbnailColor: string | null;

  /** Map a GalleryFile entity to its client projection. */
  static from(file: GalleryFile): GalleryFileDto {
    const dto = new GalleryFileDto();
    dto.id = file.id;
    dto.fileName = file.fileName;
    dto.url = file.url;
    dto.mediaType = file.mediaType;
    dto.sizeBytes = file.sizeBytes;
    dto.width = file.width;
    dto.height = file.height;
    dto.durationSeconds = file.durationSeconds;
    dto.caption = file.caption;
    dto.thumbnailColor = file.thumbnailColor;
    return dto;
  }
}

/** Enrichment passed into {@link GalleryItemDto.from} (batched by the service). */
export interface GalleryItemProjection {
  files: GalleryFileDto[];
  likesCount: number;
  tags: string[];
  author: GalleryMemberRefDto | null;
  /** Whether the current caller has liked the item; omitted for public (no user). */
  liked?: boolean;
}

/**
 * Client-facing projection of a {@link GalleryItem}. The raw entity is never
 * exposed; the author/tagged members are flattened to `{ memberId, name }`
 * references and the likes count + files are batched in by the service. `liked`
 * is only present for authenticated callers (public serialization never sets it).
 */
export class GalleryItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'The charge at dawn' })
  title: string;

  @ApiProperty({ nullable: true })
  caption: string | null;

  @ApiProperty({ enum: GalleryType })
  type: GalleryType;

  @ApiProperty({ nullable: true, description: 'External link (for link-type items)' })
  linkUrl: string | null;

  @ApiProperty({ nullable: true })
  thumbnailUrl: string | null;

  @ApiProperty({ enum: GalleryStatus })
  status: GalleryStatus;

  @ApiProperty({ nullable: true, description: 'Reason recorded when the item was declined' })
  declineReason: string | null;

  @ApiProperty({ type: GalleryMemberRefDto, nullable: true })
  author: GalleryMemberRefDto | null;

  @ApiProperty({ type: [GalleryFileDto] })
  files: GalleryFileDto[];

  @ApiProperty({ type: [String], description: 'Free-form tags' })
  tags: string[];

  @ApiProperty({ description: 'Number of members who have liked this item' })
  likesCount: number;

  @ApiPropertyOptional({
    description: 'Whether the caller has liked it (authenticated views only)',
  })
  liked?: boolean;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z', description: 'ISO submit timestamp' })
  submittedAt: string;

  @ApiProperty({ nullable: true, example: '2026-06-22T19:00:00.000Z' })
  approvedAt: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z' })
  updatedAt: string;

  /**
   * Build the projection from a gallery item plus its batched enrichment (files,
   * likes count, tagged members and author reference). `liked` is left undefined
   * for public callers so it is omitted from the serialized response.
   */
  static from(item: GalleryItem, projection: GalleryItemProjection): GalleryItemDto {
    const dto = new GalleryItemDto();
    dto.id = item.id;
    dto.title = item.title;
    dto.caption = item.caption;
    dto.type = item.type;
    dto.linkUrl = item.linkUrl;
    dto.thumbnailUrl = item.thumbnailUrl;
    dto.status = item.status;
    dto.declineReason = item.declineReason;
    dto.author = projection.author;
    dto.files = projection.files;
    dto.tags = projection.tags;
    dto.likesCount = projection.likesCount;
    dto.liked = projection.liked;
    dto.submittedAt = item.submittedAt.toISOString();
    dto.approvedAt = item.approvedAt ? item.approvedAt.toISOString() : null;
    dto.createdAt = item.createdAt.toISOString();
    dto.updatedAt = item.updatedAt.toISOString();
    return dto;
  }
}

/**
 * Lean projection of a pending submission for the dashboard "Gallery
 * submissions" panel (T-0094). Deliberately minimal: no files/likes/tags batch,
 * just what the panel list item needs.
 */
export class GallerySubmissionSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'The charge at dawn' })
  title: string;

  @ApiProperty({ nullable: true, example: 'Jane Doe' })
  submitterUsername: string | null;
}
