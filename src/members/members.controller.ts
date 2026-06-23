import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Capability } from '../common/enums';
import { MemberDto } from './dto/member.dto';
import { MemberQueryDto } from './dto/member-query.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

/**
 * Members roster API. Listing/reading requires the ViewMembersDirectory
 * capability (granted to all enrolled roles); profile edits are self-service
 * only (a member may edit only their own record). All routes are auth-guarded
 * globally and scoped to the caller's regiment in the service.
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
}
