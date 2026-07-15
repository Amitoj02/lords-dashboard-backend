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
import { AttendeeDto } from './dto/attendee.dto';
import { CompleteEventDto } from './dto/complete-event.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EventDto } from './dto/event.dto';
import { EventQueryDto } from './dto/event-query.dto';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { RevealedPasswordDto } from './dto/revealed-password.dto';
import { RsvpDto } from './dto/rsvp.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventsService } from './events.service';

/**
 * Events API. The two list/detail reads are public (redacted server binding);
 * authoring + lifecycle actions require ManageEvents; RSVP requires RsvpToEvents;
 * the attendee roster requires ViewMembersDirectory; the password reveal requires
 * RevealEventPasswords plus an RSVP. All non-public routes are auth-guarded
 * globally, scoped to the caller's regiment in the service, and mutations that
 * change an event are audited.
 */
@ApiTags('events')
@ApiBearerAuth('access-token')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List published events (public calendar)' })
  @ApiOkResponse({ description: 'A page of published events, earliest first.' })
  list(@Query() query: EventQueryDto): Promise<PaginatedResponseDto<EventDto>> {
    return this.eventsService.listPublic(query);
  }

  @Get('mine')
  @ApiOperation({
    summary: 'List events for the authenticated member (member projection + myRsvp)',
  })
  @ApiOkResponse({ description: 'A page of events with the member projection.' })
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EventQueryDto,
  ): Promise<PaginatedResponseDto<EventDto>> {
    return this.eventsService.listForMember(user, query);
  }

  @Get('mine/:id')
  @ApiOperation({ summary: 'Get a single event for the authenticated member (member projection)' })
  @ApiOkResponse({ type: EventDto, description: 'The event with the member projection.' })
  getMine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
  ): Promise<EventDto> {
    return this.eventsService.getForMember(user, id);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get a single published event (public view)' })
  @ApiOkResponse({ type: EventDto, description: 'The published event.' })
  get(@Param('id', ParseShortIdPipe) id: string): Promise<EventDto> {
    return this.eventsService.getPublic(id);
  }

  @Post()
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Create and publish an event' })
  @ApiCreatedResponse({ type: EventDto, description: 'The created event.' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEventDto,
    @Req() req: Request,
  ): Promise<EventDto> {
    return this.eventsService.create(user, dto, req.ip ?? null);
  }

  @Patch(':id')
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Update an event (and replace provided child collections)' })
  @ApiOkResponse({ type: EventDto, description: 'The updated event.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: UpdateEventDto,
    @Req() req: Request,
  ): Promise<EventDto> {
    return this.eventsService.update(user, id, dto, req.ip ?? null);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Archive an event' })
  @ApiOkResponse({ type: EventDto, description: 'The archived event.' })
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Req() req: Request,
  ): Promise<EventDto> {
    return this.eventsService.archive(user, id, req.ip ?? null);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Close an event out as previous (with its outcome)' })
  @ApiOkResponse({ type: EventDto, description: 'The completed event.' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: CompleteEventDto,
    @Req() req: Request,
  ): Promise<EventDto> {
    return this.eventsService.complete(user, id, dto, req.ip ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Soft-delete an event' })
  @ApiNoContentResponse({ description: 'The event was deleted.' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.eventsService.remove(user, id, req.ip ?? null);
  }

  @Delete(':id/series')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Soft-delete a whole recurring series (template + all occurrences)' })
  @ApiNoContentResponse({ description: 'The series was deleted.' })
  removeSeries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.eventsService.removeSeries(user, id, req.ip ?? null);
  }

  @Post(':id/rsvp')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.RsvpToEvents)
  @ApiOperation({ summary: 'RSVP to an event' })
  @ApiOkResponse({ type: EventDto, description: 'The event with the caller RSVP reflected.' })
  rsvp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: RsvpDto,
  ): Promise<EventDto> {
    return this.eventsService.rsvp(user, id, dto);
  }

  @Delete(':id/rsvp')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.RsvpToEvents)
  @ApiOperation({ summary: "Remove the caller's RSVP (idempotent)" })
  @ApiNoContentResponse({ description: 'The RSVP was removed.' })
  removeRsvp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
  ): Promise<void> {
    return this.eventsService.removeRsvp(user, id);
  }

  @Get(':id/attendees')
  @RequireCapability(Capability.ViewMembersDirectory)
  @ApiOperation({ summary: 'List the confirmed attendees of an event' })
  @ApiOkResponse({ type: [AttendeeDto], description: 'The attendee list.' })
  listAttendees(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
  ): Promise<AttendeeDto[]> {
    return this.eventsService.listAttendees(user, id);
  }

  @Post(':id/attendees')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Check members in as attendees (idempotent)' })
  @ApiOkResponse({ type: [AttendeeDto], description: 'The updated attendee list.' })
  addAttendees(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Body() dto: MarkAttendanceDto,
  ): Promise<AttendeeDto[]> {
    return this.eventsService.addAttendees(user, id, dto);
  }

  @Delete(':id/attendees/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.ManageEvents)
  @ApiOperation({ summary: 'Remove one attendee' })
  @ApiNoContentResponse({ description: 'The attendee was removed.' })
  removeAttendee(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Param('memberId', ParseShortIdPipe) memberId: string,
  ): Promise<void> {
    return this.eventsService.removeAttendee(user, id, memberId);
  }

  @Post(':id/reveal-password')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.RevealEventPasswords)
  @ApiOperation({ summary: 'Reveal the decrypted server password (RSVP required)' })
  @ApiOkResponse({ type: RevealedPasswordDto, description: 'The decrypted server credentials.' })
  revealPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseShortIdPipe) id: string,
    @Req() req: Request,
  ): Promise<RevealedPasswordDto> {
    return this.eventsService.revealPassword(user, id, req.ip ?? null);
  }
}
