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
import { ParseShortIdPipe } from '../common/ids/parse-short-id.pipe';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireAnyCapability } from '../authz/decorators/require-any-capability.decorator';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability, MemberRole } from '../common/enums';
import { DiscordService } from './discord.service';
import {
  BotOperationDto,
  BotStatusDto,
  DiscordConnectionDto,
  DiscordRoleDto,
  DiscordVerifyConnectionDto,
} from './dto/discord-connection.dto';
import { DiscordBotSettingsDto, UpdateDiscordSettingsDto } from './dto/discord-settings.dto';
import {
  BindGuildDto,
  DiscordOperationsQueryDto,
  SimulateJoinDto,
  SimulateLeaveDto,
} from './dto/discord-inputs.dto';
import { RoleRelinkProgressDto } from './dto/role-relink.dto';

/**
 * Discord bot control API. Everything requires ManageSettings. The bot has no
 * slash commands — it only syncs roles and posts event/enlistment announcements —
 * so this is the sole surface for driving it. All work is enqueued through the
 * outbox and audited in the service.
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

  @Get('status')
  @RequireRole(MemberRole.Owner, MemberRole.Admin, MemberRole.Moderator)
  @ApiOperation({
    summary: 'STAFF bot status + live metrics for the dashboard widget (no settings surface)',
  })
  @ApiOkResponse({ type: BotStatusDto })
  getStatus(@CurrentUser() user: AuthenticatedUser): Promise<BotStatusDto> {
    return this.discordService.getBotStatus(user);
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

  @Get('roles')
  // EITHER capability, not both (T-0206). This list feeds two different screens:
  // the rank/medal link pickers (edit_ranks_medals) and the event authoring
  // form's ping-role picker (manage_events). The defaults do not overlap — a
  // Moderator holds manage_events but not edit_ranks_medals — so gating on one
  // would 403 an event author on a form they are allowed to open, and requiring
  // both would lock out more people still.
  @RequireAnyCapability(Capability.EditRanksMedals, Capability.ManageEvents)
  @ApiOperation({
    summary:
      'List the guild roles for the rank/medal + event ping pickers (empty when disconnected)',
  })
  @ApiOkResponse({ type: [DiscordRoleDto] })
  listRoles(): Promise<DiscordRoleDto[]> {
    // Gating is enforced by @RequireCapability; the roles come from the single
    // bound guild, so no per-request user context is needed (cf. verifyConnection).
    return this.discordService.listRoles();
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

  @Get('relink/:batchId')
  // Gated on EditRanksMedals, not ManageSettings: this reports on an action the
  // rank/medal editor just took, and they must be able to watch it finish
  // without also holding the bot-configuration capability.
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Progress (or the terminal summary) of a bulk Discord role re-link' })
  @ApiOkResponse({ type: RoleRelinkProgressDto })
  getRelinkProgress(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoleRelinkProgressDto> {
    return this.discordService.getRelinkProgress(user, batchId);
  }

  @Post('relink/:batchId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({
    summary: 'Stop a bulk re-link; members already updated stay updated (reported as partial)',
  })
  @ApiOkResponse({ type: RoleRelinkProgressDto })
  cancelRelink(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<RoleRelinkProgressDto> {
    return this.discordService.cancelRelink(user, batchId, req.ip ?? null);
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
    @Param('id', ParseShortIdPipe) id: string,
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

  @Post('simulate/member-leave')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageSettings)
  @ApiOperation({
    summary:
      'Dev/testing: simulate a guild-member-remove to exercise the membership flip via the mock',
  })
  simulateMemberLeave(@Body() dto: SimulateLeaveDto): Promise<{ ok: true }> {
    return this.discordService.simulateMemberLeave(dto);
  }
}
