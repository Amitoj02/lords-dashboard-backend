import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import { DiscordService } from './discord.service';
import {
  BotOperationDto,
  DiscordConnectionDto,
  DiscordVerifyConnectionDto,
} from './dto/discord-connection.dto';
import { DiscordBotSettingsDto, UpdateDiscordSettingsDto } from './dto/discord-settings.dto';
import {
  AnnounceDto,
  BindGuildDto,
  DiscordOperationsQueryDto,
  SimulateJoinDto,
} from './dto/discord-inputs.dto';

/**
 * Discord bot control API. Everything requires ManageSettings except /announce
 * (ManageNotifications). The bot has no slash commands — it only syncs roles and
 * posts announcements — so this is the sole surface for driving it. All work is
 * enqueued through the outbox and audited in the service.
 */
@ApiTags('discord')
@ApiBearerAuth('access-token')
@Controller('discord')
export class DiscordController {
  constructor(private readonly discordService: DiscordService) {}

  @Get('connection')
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Current bot connection + authority snapshot' })
  @ApiOkResponse({ type: DiscordConnectionDto })
  getConnection(@CurrentUser() user: AuthenticatedUser): Promise<DiscordConnectionDto> {
    return this.discordService.getConnection(user);
  }

  @Post('verify-connection')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({
    summary: 'Run a live connection check; returns the snapshot + guild roles/channels',
  })
  @ApiOkResponse({ type: DiscordVerifyConnectionDto })
  verifyConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<DiscordVerifyConnectionDto> {
    return this.discordService.verifyConnection(user, req.ip ?? null);
  }

  @Get('settings')
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Read the bot configuration' })
  @ApiOkResponse({ type: DiscordBotSettingsDto })
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<DiscordBotSettingsDto> {
    return this.discordService.getSettings(user);
  }

  @Patch('settings')
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Update the bot configuration (applyBanRoleOnBan is sensitive)' })
  @ApiOkResponse({ type: DiscordBotSettingsDto })
  updateSettings(
    @Body() dto: UpdateDiscordSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<DiscordBotSettingsDto> {
    return this.discordService.updateSettings(user, dto, req.ip ?? null);
  }

  @Post('resync')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Enqueue a full role resync for all linked members' })
  resync(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ enqueued: number }> {
    return this.discordService.resync(user, req.ip ?? null);
  }

  @Post('announce')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageNotifications)
  @ApiOperation({ summary: 'Broadcast an announcement to Discord (via the outbox)' })
  announce(
    @Body() dto: AnnounceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ enqueued: boolean }> {
    return this.discordService.announce(user, dto, req.ip ?? null);
  }

  @Get('operations')
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Recent bot operations (paginated)' })
  @ApiOkResponse({ description: 'A page of bot operations, most recent first.' })
  listOperations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DiscordOperationsQueryDto,
  ): Promise<PaginatedResponseDto<BotOperationDto>> {
    return this.discordService.listOperations(user, query);
  }

  @Post('operations/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Mark a failed bot operation resolved' })
  @ApiOkResponse({ type: BotOperationDto })
  resolveOperation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<BotOperationDto> {
    return this.discordService.resolveOperation(user, id, req.ip ?? null);
  }

  @Post('bind')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({ summary: 'Bind the regiment to a Discord guild' })
  bind(
    @Body() dto: BindGuildDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ discordServerId: string | null; discordServerName: string | null }> {
    return this.discordService.bind(user, dto, req.ip ?? null);
  }

  @Post('simulate/member-join')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({
    summary: 'Dev/testing: simulate a guild-member-add to exercise onboarding via the mock',
  })
  simulateMemberJoin(@Body() dto: SimulateJoinDto): Promise<{ ok: true }> {
    return this.discordService.simulateMemberJoin(dto);
  }
}
