import {
  Body,
  Controller,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationDto } from './dto/notification.dto';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { NotificationsService } from './notifications.service';

/**
 * "Field Dispatch" announcements API. Reads (feed + unread badge) are available
 * to any enrolled member; composing a dispatch requires ManageNotifications and
 * is audited in the service. All routes are auth-guarded globally and scoped to
 * the caller's regiment.
 */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List regiment notifications (paginated, most recent first)' })
  @ApiOkResponse({ description: 'A page of notifications with the caller’s read state.' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: NotificationQueryDto,
  ): Promise<PaginatedResponseDto<NotificationDto>> {
    return this.notificationsService.findAll(user, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count notifications the caller has not yet read' })
  @ApiOkResponse({ description: 'The caller’s unread notification count.' })
  unreadCount(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return this.notificationsService.unreadCount(user);
  }

  @Post()
  @RequireCapability(Capability.ManageNotifications)
  @ApiOperation({ summary: 'Compose a dispatch (announcement) for the regiment' })
  @ApiCreatedResponse({ type: NotificationDto, description: 'The created notification.' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateNotificationDto,
    @Req() req: Request,
  ): Promise<NotificationDto> {
    return this.notificationsService.create(user, dto, req.ip ?? null);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every unread notification read for the caller' })
  @ApiOkResponse({ description: 'The number of notifications marked read.' })
  markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<{ read: number }> {
    return this.notificationsService.markAllRead(user);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a single notification read for the caller (idempotent)' })
  @ApiOkResponse({ description: 'Confirmation the notification is read.' })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ read: boolean }> {
    return this.notificationsService.markRead(user, id);
  }
}
