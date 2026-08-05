import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { ParseShortIdPipe } from '../../common/ids/parse-short-id.pipe';
import { GalleryItemDto } from '../../gallery/dto/gallery-item.dto';
import { GalleryQueryDto } from '../../gallery/dto/gallery-query.dto';
import { GalleryService } from '../../gallery/gallery.service';
import { PublicMemberDto } from '../dto/public-member.dto';
import { PublicMemberQueryDto } from './public-member-query.dto';
import { PublicMembersService } from './public-members.service';

/**
 * The anonymous roster and profile surface (T-0215).
 *
 * ── WHY A SEPARATE CONTROLLER AND NOT `@Public()` ON THE EXISTING ONE ───────
 * Two reasons, and the second is the important one.
 *
 * First, `@Public()` is read by BOTH `JwtAuthGuard` and `GuildGateGuard`
 * (`guild-gate.guard.ts` re-checks `IS_PUBLIC_KEY` independently), so marking a
 * route public silently exempts it from the Discord guild gate as well. That is
 * correct here and would be wrong on a route that also serves members.
 *
 * Second, and structurally: a public route that shares a handler with an
 * authenticated one has to REMEMBER to redact, and the redaction lives in a
 * conditional somebody will eventually widen. Here the anonymous path has its
 * own controller, its own service, its own query DTO and its own response DTO,
 * so the sensitive fields are not stripped — they were never in scope. The
 * codebase already had one endpoint of each kind and the split is what makes
 * the difference reviewable.
 *
 * ── CACHEABILITY ────────────────────────────────────────────────────────────
 * Nothing here varies by caller (that is what excluding `permittedActions`
 * buys), so every response can be cached at the edge. `main.ts` sets a blanket
 * `Cache-Control: no-store` on every API response before routing, so each
 * handler that wants to be cached has to say so explicitly — the same override
 * the medal-thumbnail proxy and the share shell already perform.
 */
@ApiTags('members')
@Controller('public/members')
export class PublicMembersController {
  constructor(
    private readonly members: PublicMembersService,
    private readonly gallery: GalleryService,
  ) {}

  @Get()
  @Public()
  // Anonymous and enumerable, so it must not share the one global bucket with
  // signed-in members — a crawler working through the sitemap would otherwise
  // spend everyone's budget.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'The public roster (anonymous projection)' })
  @ApiOkResponse({ type: PaginatedResponseDto })
  async list(
    @Query() query: PublicMemberQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedResponseDto<PublicMemberDto>> {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Vary', 'Accept-Encoding');
    return this.members.list(query);
  }

  @Get(':handle')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'One public profile, addressed by @handle or short id',
    description:
      'Returns 404 for a member with no public profile (applicant, pending, suspended, ' +
      'banned or unknown) and 410 Gone only for an account that was deliberately deleted.',
  })
  @ApiOkResponse({ type: PublicMemberDto })
  async findOne(
    @Param('handle') handle: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicMemberDto> {
    const { dto } = await this.members.findByHandle(handle);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Vary', 'Accept-Encoding');
    return dto;
  }

  @Get(':handle/gallery')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "A member's approved gallery contributions" })
  @ApiOkResponse({ type: PaginatedResponseDto })
  async galleryFor(
    @Param('handle') handle: string,
    @Query() query: GalleryQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    // Resolved through the same predicate first: a member with no public
    // profile has no public contributions either, even though every item in
    // the feed is individually public.
    const { member } = await this.members.findByHandle(handle);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Vary', 'Accept-Encoding');
    return this.gallery.findPublicByAuthor(member.id, query);
  }

  @Get(':id/avatar')
  @Public()
  // Triggers a server-side outbound fetch, so it gets a bucket of its own —
  // the same treatment as the medal-thumbnail proxy, at double the limit
  // because a single roster page renders 25 of these.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: "Proxy a member's avatar from this origin",
    description:
      "Never redirects to the upstream URL: the Discord CDN fallback embeds the member's " +
      'Discord snowflake, which the public projection otherwise never carries.',
  })
  async avatar(@Param('id', ParseShortIdPipe) id: string, @Res() res: Response): Promise<void> {
    const avatar = await this.members.avatarFor(id);
    if (!avatar) {
      // Graceful miss — the client falls back to its initials tile, exactly as
      // it does for a member with a null avatarUrl.
      res.status(404).send();
      return;
    }
    res.setHeader('Content-Type', avatar.contentType);
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.send(avatar.buffer);
  }
}
