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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import {
  AwardMedalDto,
  BanMemberDto,
  ChangeRankDto,
  ChangeRoleDto,
  ConfirmDeletionDto,
  DeletionRequestDto,
  DeriveFromDiscordResultDto,
  SuspendMemberDto,
} from './dto/member-admin.dto';
import { EventDto } from '../events/dto/event.dto';
import { CommandInfoDto, ServiceRecordEntryDto } from './dto/member-detail.dto';
import { MemberDto } from './dto/member.dto';
import { MemberQueryDto } from './dto/member-query.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

/**
 * Members roster API. Reads require the ViewMembersDirectory capability (granted
 * to all enrolled roles); profile edits are self-service; admin actions (rank/
 * role/medal/suspend/ban) are capability-gated and audited in the service. All
 * routes are auth-guarded globally and scoped to the caller's regiment.
 *
 * The capability decorators below are only half the gate: they know the
 * caller's role but nothing about the TARGET, so every admin action is also
 * subject to the target-scoped guard in the service (T-0176). What that guard
 * asks depends on the action (T-0211): role/suspend/ban get the full hierarchy
 * — not yourself, not the regiment owner, and only against a strictly lower
 * role — while rank/medal/derive get no target rule at all, because a decoration
 * is not authority. The `permittedActions` block on MemberDto reports
 * the combined verdict per member and per action so the client does not have to
 * guess (T-0177).
 */
@ApiTags('members')
@ApiBearerAuth('access-token')
@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @RequireCapability(Capability.ViewMembersDirectory)
  @ApiOperation({ summary: 'List roster members (paginated, filterable)' })
  @ApiOkResponse({ description: 'A page of roster members with derived metrics' })
  findAll(
    @Query() query: MemberQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResponseDto<MemberDto>> {
    return this.membersService.findAll(query, user);
  }

  // ── GDPR (self-service) — declared before /:id so the literal `me` wins ──────

  @Post('me/deletion-request')
  @ApiOperation({ summary: 'Request deferred deletion of your own account (GDPR)' })
  requestDeletion(
    @Body() dto: DeletionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.membersService.requestSelfDeletion(user, dto, req.ip ?? null);
  }

  @Post('me/deletion-request/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a pending deletion request' })
  confirmDeletion(@Body() dto: ConfirmDeletionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.membersService.confirmSelfDeletion(user, dto);
  }

  @Post('me/deletion-request/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute a confirmed deletion (soft-delete + anonymise, irreversible)' })
  executeDeletion(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.membersService.executeSelfDeletion(user, req.ip ?? null);
  }

  @Post('me/deletion-request/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending or confirmed deletion request' })
  cancelDeletion(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.membersService.cancelSelfDeletion(user, req.ip ?? null);
  }

  @Get('me/export')
  @ApiOperation({ summary: 'Export your own data (GDPR data download)' })
  exportSelf(@CurrentUser() user: AuthenticatedUser) {
    return this.membersService.exportSelfData(user);
  }

  // ── Single member reads ──────────────────────────────────────────────────────

  @Get(':id')
  @RequireCapability(Capability.ViewMembersDirectory)
  @ApiOperation({ summary: 'Get a single roster member by id' })
  @ApiOkResponse({ description: 'The member projection', type: MemberDto })
  findOne(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.membersService.findOne(id, user);
  }

  @Get(':id/service-record')
  @ApiOperation({ summary: "A member's service timeline (most recent first)" })
  @ApiOkResponse({ type: [ServiceRecordEntryDto] })
  serviceRecord(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ServiceRecordEntryDto[]> {
    return this.membersService.getServiceRecord(id, user);
  }

  @Get(':id/events')
  @RequireCapability(Capability.ViewMembersDirectory)
  @ApiOperation({ summary: "A member's attended events (profile Event History)" })
  @ApiOkResponse({ type: [EventDto] })
  events(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EventDto[]> {
    return this.membersService.getEvents(id, user);
  }

  @Get(':id/rsvps')
  @RequireCapability(Capability.ViewMembersDirectory)
  @ApiOperation({ summary: "A member's event RSVPs (profile RSVPs tab)" })
  @ApiOkResponse({ type: [EventDto] })
  rsvps(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EventDto[]> {
    return this.membersService.getRsvps(id, user);
  }

  @Get(':id/command-info')
  @RequireCapability(Capability.ViewAuditLog)
  @ApiOperation({ summary: 'Sensitive command info (last sign-in, moderation state)' })
  @ApiOkResponse({ type: CommandInfoDto })
  commandInfo(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CommandInfoDto> {
    return this.membersService.getCommandInfo(id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update your own profile (self-service)',
    description:
      'A member may edit only their own profile and only a restricted set of fields. ' +
      'Changing role/status/rank is not permitted here.',
  })
  @ApiOkResponse({ description: 'The updated member projection', type: MemberDto })
  update(
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.membersService.updateSelf(id, dto, user);
  }

  // ── Admin actions (capability-gated; audited in the service) ─────────────────

  @Post(':id/rank')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({
    summary: "Change a member's rank",
    description:
      'A rank is a decoration, not authority, so this answers to edit_ranks_medals ' +
      'alone (T-0211): any member of the regiment, including a peer, a superior, ' +
      'the regiment owner, and the caller themselves.',
  })
  @ApiOkResponse({ type: MemberDto })
  changeRank(
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: ChangeRankDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.changeRank(id, dto, user, req.ip ?? null);
  }

  @Post(':id/role')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({
    summary: "Change a member's role",
    description:
      'Forbidden against the regiment owner, the caller themselves, and any member ' +
      'whose role equals or outranks the caller (T-0176). The role granted is capped ' +
      "at the caller's own tier — an Admin holding manage_roles may appoint another " +
      'Admin, but never a superior (T-0203). Owner is never assignable here.',
  })
  @ApiOkResponse({ type: MemberDto })
  changeRole(
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: ChangeRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.changeRole(id, dto, user, req.ip ?? null);
  }

  @Post(':id/medals')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({
    summary: 'Award a medal to a member (repeatable)',
    description:
      'Like every rank/medal write, gated on edit_ranks_medals alone — any member, ' +
      'the caller included (T-0211).',
  })
  @ApiOkResponse({ type: MemberDto })
  awardMedal(
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: AwardMedalDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.awardMedal(id, dto, user, req.ip ?? null);
  }

  @Delete(':id/medals/:medalId')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({
    summary: "Remove a member's most recent award of a medal",
    description:
      'Like every rank/medal write, gated on edit_ranks_medals alone — any member, ' +
      'the caller included (T-0211).',
  })
  @ApiOkResponse({ type: MemberDto })
  removeMedal(
    @Param('id', ParseShortIdPipe) id: string,
    @Param('medalId', ParseShortIdPipe) medalId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.removeMedal(id, medalId, user, req.ip ?? null);
  }

  @Post(':id/derive-from-discord')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({
    summary: "Derive a member's rank and medals from the Discord roles they already hold",
    description:
      'The repair for members whose history only ever existed as Discord roles (T-0204). ' +
      'Promotion-only (their current rank is the floor) and additive-only on medals, ' +
      'diffed against what they already hold so it is safe to press twice. It writes a ' +
      'rank and medal awards, so it carries no target restriction at all (T-0211): any ' +
      'edit_ranks_medals holder may run it against any member of the regiment, the owner ' +
      'and THEMSELVES included — on your own record it credits whatever your own Discord ' +
      'roles already say you have earned. 409 when there is nothing to read from ' +
      '(no linked account, bot switched off, not in the guild); 503 when Discord did ' +
      'not answer. Finding nothing to derive is a 200.',
  })
  @ApiOkResponse({
    description: 'What was derived, plus the member as they now stand',
    type: DeriveFromDiscordResultDto,
  })
  deriveFromDiscord(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<DeriveFromDiscordResultDto> {
    return this.membersService.deriveFromDiscord(id, user, req.ip ?? null);
  }

  @Post(':id/suspend')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({
    summary: 'Suspend a member until a future date',
    description:
      'Forbidden against the regiment owner, the caller themselves, and any member ' +
      'whose role equals or outranks the caller (T-0176).',
  })
  @ApiOkResponse({ type: MemberDto })
  suspend(
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: SuspendMemberDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.suspend(id, dto, user, req.ip ?? null);
  }

  @Post(':id/ban')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({
    summary: 'Ban a member (app-side)',
    description:
      'Forbidden against the regiment owner, the caller themselves, and any member ' +
      'whose role equals or outranks the caller (T-0176).',
  })
  @ApiOkResponse({ type: MemberDto })
  ban(
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: BanMemberDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.ban(id, dto, user, req.ip ?? null);
  }

  @Post(':id/unban')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({ summary: 'Lift a member ban' })
  @ApiOkResponse({ type: MemberDto })
  unban(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.unban(id, user, req.ip ?? null);
  }

  @Post(':id/unsuspend')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({ summary: 'Lift an active member suspension' })
  @ApiOkResponse({ type: MemberDto })
  unsuspend(
    @Param('id', ParseShortIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.unsuspend(id, user, req.ip ?? null);
  }
}
