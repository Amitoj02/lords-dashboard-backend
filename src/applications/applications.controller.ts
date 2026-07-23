import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { ApplicationsService } from './applications.service';
import { ApplicantApplicationDto } from './dto/applicant-application.dto';
import { ApplicationDto } from './dto/application.dto';
import { ApplicationQueryDto } from './dto/application-query.dto';
import { ApproveApplicationDto } from './dto/approve-application.dto';
import { BlockApplicantDto } from './dto/block-applicant.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { DeclineApplicationDto } from './dto/decline-application.dto';
import { HoldApplicationDto } from './dto/hold-application.dto';
import { MyApplicationDto } from './dto/my-application.dto';
import { UpdateMyApplicationDto } from './dto/update-my-application.dto';

@ApiTags('applications')
@ApiBearerAuth('access-token')
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  // The three applicant-facing routes (submit, GET /mine, PATCH /mine) answer with
  // the applicant projection: the staff ApplicationDto carries review-only fields
  // (moderator note, decline reason, decider) that must never reach them (T-0154).
  @Post()
  @RequireCapability(Capability.ApplyToJoin)
  @ApiOperation({ summary: 'Submit a recruitment application (Applicant role only)' })
  @ApiCreatedResponse({ type: ApplicantApplicationDto, description: 'The created application.' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateApplicationDto,
  ): Promise<ApplicantApplicationDto> {
    return this.applicationsService.submit(user, dto);
  }

  // NOTE: /mine is declared BEFORE the /:id routes so it is not captured as an
  // application id (an applicant lacks manage_applications and would 403).
  @Get('mine')
  @RequireCapability(Capability.ApplyToJoin)
  @ApiOperation({ summary: "Fetch the caller's own application + blocked state (applicant)" })
  @ApiOkResponse({ type: MyApplicationDto, description: 'The caller’s application view.' })
  getMine(@CurrentUser() user: AuthenticatedUser): Promise<MyApplicationDto> {
    return this.applicationsService.getMine(user);
  }

  @Patch('mine')
  @RequireCapability(Capability.ApplyToJoin)
  @ApiOperation({ summary: "Edit the caller's own PENDING application (applicant)" })
  @ApiOkResponse({ type: ApplicantApplicationDto, description: 'The updated application.' })
  updateMine(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyApplicationDto,
  ): Promise<ApplicantApplicationDto> {
    return this.applicationsService.updateMine(user, dto);
  }

  @Get()
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({ summary: 'List applications (the staff recruitment queue)' })
  @ApiOkResponse({ description: 'Paginated applications, most recently submitted first.' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ApplicationQueryDto,
  ): Promise<PaginatedResponseDto<ApplicationDto>> {
    return this.applicationsService.findAll(user, query);
  }

  @Get(':id')
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({ summary: 'Fetch a single application by id' })
  @ApiOkResponse({ type: ApplicationDto, description: 'The requested application.' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ApplicationDto> {
    return this.applicationsService.findOne(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({ summary: 'Approve an application and promote the applicant to the roster' })
  @ApiOkResponse({ type: ApplicationDto, description: 'The approved application.' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveApplicationDto,
    @Req() req: Request,
  ): Promise<ApplicationDto> {
    return this.applicationsService.approve(user, id, dto, req.ip ?? null);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({ summary: 'Decline an application' })
  @ApiOkResponse({ type: ApplicationDto, description: 'The declined application.' })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeclineApplicationDto,
    @Req() req: Request,
  ): Promise<ApplicationDto> {
    return this.applicationsService.decline(user, id, dto, req.ip ?? null);
  }

  @Post(':id/hold')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({ summary: 'Place an application on hold (not a final decision)' })
  @ApiOkResponse({ type: ApplicationDto, description: 'The held application.' })
  hold(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: HoldApplicationDto,
    @Req() req: Request,
  ): Promise<ApplicationDto> {
    return this.applicationsService.hold(user, id, dto, req.ip ?? null);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({
    summary: 'Permanently block this applicant from submitting further applications',
  })
  @ApiOkResponse({ type: ApplicationDto, description: 'The application (applicant now blocked).' })
  block(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: BlockApplicantDto,
    @Req() req: Request,
  ): Promise<ApplicationDto> {
    return this.applicationsService.blockApplicant(user, id, dto, req.ip ?? null);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageApplications)
  @ApiOperation({ summary: 'Re-enable a previously blocked applicant' })
  @ApiOkResponse({ type: ApplicationDto, description: 'The application (applicant re-enabled).' })
  unblock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ApplicationDto> {
    return this.applicationsService.unblockApplicant(user, id, req.ip ?? null);
  }
}
