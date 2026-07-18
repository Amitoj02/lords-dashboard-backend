import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUrl, MaxLength } from 'class-validator';
import { MediaProvider } from '../../../common/enums';

/** Query params for `GET /gallery/media/resolve`. */
export class ResolveLinkQueryDto {
  @ApiProperty({ description: 'The external media URL to resolve', maxLength: 2048 })
  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_protocol: true })
  url: string;
}

/**
 * Server-resolved shape of an external gallery link. `embedUrl` is a sanitized
 * iframe source (youtube/medaltv), `thumbnailUrl` a still-image poster (a stable
 * proxy URL for Medal, a static i.ytimg URL for YouTube, or the raw URL for a
 * direct image). `title`/`durationSeconds` are populated only when enrichment is
 * available (YouTube Data API, key-gated).
 */
export class ResolvedMediaDto {
  @ApiProperty({ description: 'The original URL that was resolved' })
  url: string;

  @ApiProperty({ enum: MediaProvider })
  provider: MediaProvider;

  @ApiProperty({ nullable: true, description: 'Sanitized iframe embed source (youtube/medaltv)' })
  embedUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Still-image poster/thumbnail URL' })
  thumbnailUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Canonical title (enrichment only)' })
  title: string | null;

  @ApiProperty({ nullable: true, description: 'Duration in seconds (enrichment only)' })
  durationSeconds: number | null;
}
