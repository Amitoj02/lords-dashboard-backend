import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { MediaEmbedService } from './media-embed.service';
import { ResolveLinkQueryDto, ResolvedMediaDto } from './dto/resolve-link.dto';

/**
 * Server-side media endpoints hung off the gallery module under `gallery/media`
 * (a dedicated prefix so new literal segments never collide with `gallery/:id`).
 * `resolve` is authenticated (used by the authenticated submit preview); the
 * Medal thumbnail proxy is Public since it backs posters on the public gallery.
 */
@ApiTags('gallery')
@Controller('gallery/media')
export class MediaController {
  constructor(private readonly media: MediaEmbedService) {}

  @Get('resolve')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Resolve an external media link into embed + thumbnail metadata' })
  @ApiOkResponse({ type: ResolvedMediaDto })
  resolve(@Query() query: ResolveLinkQueryDto): Promise<ResolvedMediaDto> {
    return this.media.resolve(query.url);
  }

  @Get('medal/:id/thumbnail')
  @Public()
  // Unauthenticated + triggers a server-side outbound fetch, so it must not share
  // the one global bucket (LDA-H3/M18). Cap per-IP well below the default.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Proxy + cache a Medal.tv clip thumbnail (stable URL)' })
  async medalThumbnail(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const thumb = await this.media.getMedalThumbnail(id);
    if (!thumb) {
      // Graceful miss — the client falls back to its placeholder.
      res.status(404).send();
      return;
    }
    res.setHeader('Content-Type', thumb.contentType);
    // Cache aggressively at the edge/browser; bytes are stable behind this URL.
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.send(thumb.buffer);
  }
}
