import {
  Body,
  Controller,
  Delete,
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
import {
  AwardMedalDto,
  BanMemberDto,
  ChangeRankDto,
  ChangeRoleDto,
  ConfirmDeletionDto,
  DeletionRequestDto,
  SuspendMemberDto,
} from './dto/member-admin.dto';
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
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.membersService.findOne(id, user);
  }

  @Get(':id/service-record')
  @ApiOperation({ summary: "A member's service timeline (most recent first)" })
  @ApiOkResponse({ type: [ServiceRecordEntryDto] })
  serviceRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ServiceRecordEntryDto[]> {
    return this.membersService.getServiceRecord(id, user);
  }

  @Get(':id/command-info')
  @RequireCapability(Capability.ViewAuditLog)
  @ApiOperation({ summary: 'Sensitive command info (last sign-in, moderation state)' })
  @ApiOkResponse({ type: CommandInfoDto })
  commandInfo(
    @Param('id', ParseUUIDPipe) id: string,
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
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.membersService.updateSelf(id, dto, user);
  }

  // ── Admin actions (capability-gated; audited in the service) ─────────────────

  @Post(':id/rank')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: "Change a member's rank" })
  @ApiOkResponse({ type: MemberDto })
  changeRank(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRankDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.changeRank(id, dto, user, req.ip ?? null);
  }

  @Post(':id/role')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({ summary: "Change a member's role" })
  @ApiOkResponse({ type: MemberDto })
  changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.changeRole(id, dto, user, req.ip ?? null);
  }

  @Post(':id/medals')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Award a medal to a member (repeatable)' })
  @ApiOkResponse({ type: MemberDto })
  awardMedal(
    @Param('id', ParseUUIDPipe) id: string,
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
  })
  @ApiOkResponse({ type: MemberDto })
  removeMedal(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('medalId', ParseUUIDPipe) medalId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.removeMedal(id, medalId, user, req.ip ?? null);
  }

  @Post(':id/suspend')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({ summary: 'Suspend a member until a future date' })
  @ApiOkResponse({ type: MemberDto })
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendMemberDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.suspend(id, dto, user, req.ip ?? null);
  }

  @Post(':id/ban')
  @RequireCapability(Capability.ManageRoles)
  @ApiOperation({ summary: 'Ban a member (app-side)' })
  @ApiOkResponse({ type: MemberDto })
  ban(
    @Param('id', ParseUUIDPipe) id: string,
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
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.membersService.unban(id, user, req.ip ?? null);
  }
}
