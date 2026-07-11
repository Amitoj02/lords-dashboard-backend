import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { ApplicationDto } from './dto/application.dto';
import { ApplicationQueryDto } from './dto/application-query.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { DeclineApplicationDto } from './dto/decline-application.dto';
import { HoldApplicationDto } from './dto/hold-application.dto';

@ApiTags('applications')
@ApiBearerAuth('access-token')
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @RequireCapability(Capability.ApplyToJoin)
  @ApiOperation({ summary: 'Submit a recruitment application (Applicant role only)' })
  @ApiCreatedResponse({ type: ApplicationDto, description: 'The created application.' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateApplicationDto,
  ): Promise<ApplicationDto> {
    return this.applicationsService.submit(user, dto);
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
    @Req() req: Request,
  ): Promise<ApplicationDto> {
    return this.applicationsService.approve(user, id, req.ip ?? null);
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
}
