import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ParseShortIdPipe } from '../common/ids/parse-short-id.pipe';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import { resolveClientAddress } from '../common/net/client-ip';
import { CreateGalleryItemDto } from './dto/create-gallery-item.dto';
import { DeclineGalleryDto } from './dto/decline-gallery.dto';
import {
  GalleryItemDto,
  GallerySubmissionSummaryDto,
  GalleryViewStateDto,
} from './dto/gallery-item.dto';
import { GalleryQueryDto } from './dto/gallery-query.dto';
import { UpdateGalleryItemDto } from './dto/update-gallery-item.dto';
import { GalleryLikeState, GalleryService } from './gallery.service';

/**
 * Gallery API. The feed (`GET /` and `GET /:id`) is public and honours the
 * regiment's `publicGallery` flag; submitting requires SubmitToGallery, and the
 * moderation queue + approve/decline + caption/title edit require ModerateGallery.
 * Delete is open to the post AUTHOR or a moderator (authorized in the service).
 * Likes are open to any authenticated member. Mutations are scoped + audited in
 * the service. The literal `moderation/queue` route is declared before `:id`.
 *
 * Likes and views (T-0302) split three ways on purpose, and the split IS the
 * privacy policy:
 *  - anyone may READ the totals — they ride along on every item projection;
 *  - only a signed-in member may LIKE, and `GET :id/like` answers about the
 *    caller and nobody else;
 *  - anyone may be COUNTED as a viewer, signed in or not, and no route reports
 *    who those viewers were. There is nothing to report: the stored viewer key
 *    is a per-item HMAC of an address.
 */
@ApiTags('gallery')
@ApiBearerAuth('access-token')
@Controller('gallery')
export class GalleryController {
  constructor(private readonly galleryService: GalleryService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Public gallery feed (approved items)' })
  @ApiOkResponse({ description: 'Paginated approved gallery items, newest first.' })
  @ApiForbiddenResponse({ description: 'The gallery is private' })
  findPublic(@Query() query: GalleryQueryDto): Promise<PaginatedResponseDto<GalleryItemDto>> {
    return this.galleryService.findPublic(query);
  }

  @Get('archive')
  @RequireCapability(Capability.ViewGallery)
  @ApiOperation({ summary: 'Authenticated member archive (approved items, ignores publicGallery)' })
  @ApiOkResponse({ description: 'Paginated approved gallery items for the caller’s regiment.' })
  findArchive(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GalleryQueryDto,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    return this.galleryService.findArchive(user, query);
  }

  @Get('moderation/queue')
  @RequireCapability(Capability.ModerateGallery)
  @ApiOperation({
    summary: 'List items awaiting moderation (status filter: pending/approved/declined)',
  })
  @ApiOkResponse({ description: 'Paginated gallery items in the requested moderation bucket.' })
  moderationQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GalleryQueryDto,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    return this.galleryService.moderationQueue(user, query);
  }

  @Get('pending-summary')
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({
    summary: 'Pending submissions summary for the dashboard panel (events managers)',
  })
  @ApiOkResponse({
    type: [GallerySubmissionSummaryDto],
    description: 'Pending submissions { id, title, submitterUsername }.',
  })
  pendingSummary(@CurrentUser() user: AuthenticatedUser): Promise<GallerySubmissionSummaryDto[]> {
    return this.galleryService.pendingSummary(user);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Public view of a single approved gallery item' })
  @ApiOkResponse({ type: GalleryItemDto, description: 'The requested gallery item.' })
  findOne(@Param('id', ParseShortIdPipe) id: string): Promise<GalleryItemDto> {
    return this.galleryService.findOnePublic(id);
  }

  @Post()
  @RequireCapability(Capability.SubmitToGallery)
  @ApiOperation({ summary: 'Submit a gallery item (enters moderation unless auto-approved)' })
  @ApiCreatedResponse({ type: GalleryItemDto, description: 'The created gallery item.' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateGalleryItemDto,
    @Req() req: Request,
  ): Promise<GalleryItemDto> {
    return this.galleryService.submit(user, dto, req.ip ?? null);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ModerateGallery)
  @ApiOperation({ summary: 'Approve a gallery item' })
  @ApiOkResponse({ type: GalleryItemDto, description: 'The approved gallery item.' })
  approve(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<GalleryItemDto> {
    return this.galleryService.approve(user, id, req.ip ?? null);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ModerateGallery)
  @ApiOperation({ summary: 'Decline a gallery item' })
  @ApiOkResponse({ type: GalleryItemDto, description: 'The declined gallery item.' })
  decline(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeclineGalleryDto,
    @Req() req: Request,
  ): Promise<GalleryItemDto> {
    return this.galleryService.decline(user, id, dto, req.ip ?? null);
  }

  @Public()
  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  // Its own bucket, well above a reader's pace and well below a refresh loop's.
  // The convention every @Public() route here follows: anonymous traffic must
  // not be able to drain the global 120/min the rest of the API shares.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Record a view of a gallery item (public; once per address)' })
  @ApiOkResponse({ type: GalleryViewStateDto, description: 'The fresh view count.' })
  @ApiForbiddenResponse({ description: 'The gallery is private' })
  recordView(
    @Param('id', ParseShortIdPipe) id: string,
    @Req() req: Request,
  ): Promise<GalleryViewStateDto> {
    // The SAME address the rate limiter keys on — one shared resolver, so the
    // two can never disagree about who the caller is. It is HMAC'd with a server
    // secret before it reaches the database, and is never stored or logged raw.
    return this.galleryService.recordView(id, resolveClientAddress(req));
  }

  @Get(':id/like')
  @ApiOperation({ summary: 'The caller’s own like state for an item (never anyone else’s)' })
  @ApiOkResponse({ description: 'The caller’s like state { likesCount, liked }.' })
  likeState(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GalleryLikeState> {
    return this.galleryService.likeState(user, id);
  }

  @Post(':id/like')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Like a gallery item (idempotent)' })
  @ApiOkResponse({ description: 'The fresh like state { likesCount, liked }.' })
  like(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GalleryLikeState> {
    return this.galleryService.like(user, id);
  }

  @Delete(':id/like')
  @ApiOperation({ summary: 'Remove your like from a gallery item (idempotent)' })
  @ApiOkResponse({ description: 'The fresh like state { likesCount, liked }.' })
  unlike(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GalleryLikeState> {
    return this.galleryService.unlike(user, id);
  }

  @Patch(':id')
  @RequireCapability(Capability.ModerateGallery)
  @ApiOperation({ summary: 'Edit a gallery item title, caption + tags (media is not editable)' })
  @ApiOkResponse({ type: GalleryItemDto, description: 'The updated gallery item.' })
  update(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateGalleryItemDto,
    @Req() req: Request,
  ): Promise<GalleryItemDto> {
    return this.galleryService.update(user, id, dto, req.ip ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a gallery item (post author or moderator)' })
  @ApiForbiddenResponse({ description: 'Not the author and lacks ModerateGallery.' })
  @ApiNoContentResponse({ description: 'The gallery item was deleted.' })
  remove(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    return this.galleryService.remove(user, id, req.ip ?? null);
  }
}
