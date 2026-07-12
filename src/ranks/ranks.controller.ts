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
import { CreateRankDto } from './dto/create-rank.dto';
import { LinkDiscordDto } from './dto/link-discord.dto';
import { RankDto } from './dto/rank.dto';
import { RanksService } from './ranks.service';
import { ReorderRanksDto } from './dto/reorder-ranks.dto';
import { UpdateRankDto } from './dto/update-rank.dto';

/**
 * Rank ladder API. Listing is open to any authenticated member; every mutation
 * requires the EditRanksMedals capability. All routes are auth-guarded globally
 * and scoped to the caller's regiment in the service, and every mutation writes
 * an audit row.
 */
@ApiTags('ranks')
@ApiBearerAuth('access-token')
@Controller('ranks')
export class RanksController {
  constructor(private readonly ranksService: RanksService) {}

  @Get()
  @ApiOperation({ summary: 'List the regiment rank ladder (top-to-bottom, with holder counts)' })
  @ApiOkResponse({ description: 'The full rank ladder, ordered by precedence.', type: [RankDto] })
  findAll(@CurrentUser() user: AuthenticatedUser): Promise<RankDto[]> {
    return this.ranksService.findAll(user);
  }

  @Post()
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Create a rank' })
  @ApiCreatedResponse({ type: RankDto, description: 'The created rank.' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRankDto,
    @Req() req: Request,
  ): Promise<RankDto> {
    return this.ranksService.create(user, dto, req.ip ?? null);
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Reorder the whole ladder (set precedence from an ordered id list)' })
  @ApiOkResponse({ type: [RankDto], description: 'The reordered ladder.' })
  reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderRanksDto,
    @Req() req: Request,
  ): Promise<RankDto[]> {
    return this.ranksService.reorder(user, dto, req.ip ?? null);
  }

  @Patch(':id')
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Update a rank' })
  @ApiOkResponse({ type: RankDto, description: 'The updated rank.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateRankDto,
    @Req() req: Request,
  ): Promise<RankDto> {
    return this.ranksService.update(user, id, dto, req.ip ?? null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Delete a rank (blocked while any member still holds it)' })
  @ApiNoContentResponse({ description: 'The rank was deleted.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    return this.ranksService.remove(user, id, req.ip ?? null);
  }

  @Post(':id/link-discord')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Link a rank to a Discord role' })
  @ApiOkResponse({ type: RankDto, description: 'The linked rank.' })
  linkDiscord(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LinkDiscordDto,
    @Req() req: Request,
  ): Promise<RankDto> {
    return this.ranksService.linkDiscord(user, id, dto, req.ip ?? null);
  }

  @Post(':id/unlink-discord')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.EditRanksMedals)
  @ApiOperation({ summary: 'Unlink a rank from its Discord role' })
  @ApiOkResponse({ type: RankDto, description: 'The unlinked rank.' })
  unlinkDiscord(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<RankDto> {
    return this.ranksService.unlinkDiscord(user, id, req.ip ?? null);
  }
}
