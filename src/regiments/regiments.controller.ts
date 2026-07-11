import { Controller, Get } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RegimentProfileDto } from './dto/regiment-profile.dto';
import { RegimentStatsDto } from './dto/regiment-stats.dto';
import { RegimentsService } from './regiments.service';

/**
 * Public regiment API. Both routes are unauthenticated (`@Public()`) and read
 * the single-tenant regiment resolved server-side — no caller scoping. These
 * endpoints back the anonymous landing page (profile + stat counters).
 */
@ApiTags('regiment')
@Controller('regiment')
export class RegimentsController {
  constructor(private readonly regimentsService: RegimentsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Get the regiment's public profile" })
  @ApiOkResponse({ description: 'The public regiment profile', type: RegimentProfileDto })
  @ApiNotFoundResponse({ description: 'No regiment has been provisioned' })
  getProfile(): Promise<RegimentProfileDto> {
    return this.regimentsService.getProfile();
  }

  @Public()
  @Get('stats')
  @ApiOperation({ summary: 'Get landing-page statistics for the regiment' })
  @ApiOkResponse({ description: 'Computed landing counters', type: RegimentStatsDto })
  @ApiForbiddenResponse({ description: 'Regiment statistics are private' })
  @ApiNotFoundResponse({ description: 'No regiment has been provisioned' })
  getStats(): Promise<RegimentStatsDto> {
    return this.regimentsService.getStats();
  }
}
