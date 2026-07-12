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
  Req,
} from '@nestjs/common';
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
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { RequireCapability } from '../authz/decorators/require-capability.decorator';
import { Capability } from '../common/enums';
import { CreateMedalDto } from './dto/create-medal.dto';
import { LinkDiscordDto } from './dto/link-discord.dto';
import { MedalDto } from './dto/medal.dto';
import { ReorderMedalsDto } from './dto/reorder-medals.dto';
import { UpdateMedalDto } from './dto/update-medal.dto';
import { MedalsService } from './medals.service';

/**
 * Medal catalogue API. Listing is available to any authenticated member; every
 * mutation requires the EditRanksMedals capability. All routes are auth-guarded
 * globally and scoped to the caller's regiment in the service. Awarding medals
 * to members is out of scope here (it lives in the members module).
 */
@ApiTags('medals')
@ApiBearerAuth('access-token')
@Controller('medals')
export class MedalsController {
  constructor(private readonly medalsService: MedalsService) {}

  @Get()
  @ApiOperation({ summary: 'List medals (ordered by precedence, with award counts)' })
  @ApiOkResponse({ description: 'The regiment medal catalogue', type: MedalDto, isArray: true })
  findAll(@CurrentUser() user: AuthenticatedUser): Promise<MedalDto[]> {
    return this.medalsService.findAll(user);
  }

  @Post()
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Create a medal' })
  @ApiCreatedResponse({ type: MedalDto, description: 'The created medal.' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMedalDto,
    @Req() req: Request,
  ): Promise<MedalDto> {
    return this.medalsService.create(user, dto, req.ip ?? null);
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Reorder the whole catalogue (set precedence from an ordered id list)' })
  @ApiOkResponse({ type: [MedalDto], description: 'The reordered catalogue.' })
  reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderMedalsDto,
    @Req() req: Request,
  ): Promise<MedalDto[]> {
    return this.medalsService.reorder(user, dto, req.ip ?? null);
  }

  @Patch(':id')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Update a medal (partial)' })
  @ApiOkResponse({ type: MedalDto, description: 'The updated medal.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMedalDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MedalDto> {
    return this.medalsService.update(user, id, dto, req.ip ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Delete a medal (blocked when it has been awarded)' })
  @ApiNoContentResponse({ description: 'The medal was deleted.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    return this.medalsService.remove(user, id, req.ip ?? null);
  }

  @Post(':id/link-discord')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Link a medal to a Discord role' })
  @ApiOkResponse({ type: MedalDto, description: 'The linked medal.' })
  linkDiscord(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkDiscordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MedalDto> {
    return this.medalsService.linkDiscord(user, id, dto, req.ip ?? null);
  }

  @Post(':id/unlink-discord')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Unlink a medal from its Discord role' })
  @ApiOkResponse({ type: MedalDto, description: 'The unlinked medal.' })
  unlinkDiscord(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MedalDto> {
    return this.medalsService.unlinkDiscord(user, id, req.ip ?? null);
  }
}
