import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import { CreateGalleryItemDto } from './dto/create-gallery-item.dto';
import { DeclineGalleryDto } from './dto/decline-gallery.dto';
import { GalleryItemDto } from './dto/gallery-item.dto';
import { GalleryQueryDto } from './dto/gallery-query.dto';
import { GalleryLikeState, GalleryService } from './gallery.service';

/**
 * Gallery API. The feed (`GET /` and `GET /:id`) is public and honours the
 * regiment's `publicGallery` flag; submitting requires SubmitToGallery, and the
 * moderation queue + approve/decline/delete require ModerateGallery. Likes are
 * open to any authenticated member. Mutations are scoped + audited in the
 * service. The literal `moderation/queue` route is declared before `:id`.
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

  @Get('moderation/queue')
  @RequireCapability(Capability.ModerateGallery)
  @ApiOperation({ summary: 'List pending items awaiting moderation' })
  @ApiOkResponse({ description: 'Paginated pending gallery items.' })
  moderationQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GalleryQueryDto,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    return this.galleryService.moderationQueue(user, query);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Public view of a single approved gallery item' })
  @ApiOkResponse({ type: GalleryItemDto, description: 'The requested gallery item.' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<GalleryItemDto> {
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
    @Param('id', ParseUUIDPipe) id: string,
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
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeclineGalleryDto,
    @Req() req: Request,
  ): Promise<GalleryItemDto> {
    return this.galleryService.decline(user, id, dto, req.ip ?? null);
  }

  @Post(':id/like')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Like a gallery item (idempotent)' })
  @ApiOkResponse({ description: 'The fresh like state { likesCount, liked }.' })
  like(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GalleryLikeState> {
    return this.galleryService.like(user, id);
  }

  @Delete(':id/like')
  @ApiOperation({ summary: 'Remove your like from a gallery item (idempotent)' })
  @ApiOkResponse({ description: 'The fresh like state { likesCount, liked }.' })
  unlike(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GalleryLikeState> {
    return this.galleryService.unlike(user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.ModerateGallery)
  @ApiOperation({ summary: 'Soft-delete a gallery item' })
  @ApiNoContentResponse({ description: 'The gallery item was deleted.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    return this.galleryService.remove(user, id, req.ip ?? null);
  }
}
