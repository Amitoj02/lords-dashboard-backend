import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/** Bind (or rebind) the regiment to a Discord guild. */
export class BindGuildDto {
  @ApiProperty()
  @IsString()
  @MaxLength(20)
  discordServerId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  discordServerName?: string;
}

/** Simulate a guild-member-add (dev/testing: exercises onboarding via the mock). */
export class SimulateJoinDto {
  @ApiProperty()
  @IsString()
  @MaxLength(20)
  discordUserId: string;
}

/**
 * Simulate a guild-member-remove (dev/testing). Mirrors {@link SimulateJoinDto}
 * so the leave half of the membership flow (T-0169) is exercisable with
 * DISCORD_BOT_MOCK=true — otherwise a departure could only be tested against a
 * real guild.
 */
export class SimulateLeaveDto {
  @ApiProperty()
  @IsString()
  @MaxLength(20)
  discordUserId: string;
}

/** Query for the recent bot operations list. */
export class DiscordOperationsQueryDto extends PaginationQueryDto {}
