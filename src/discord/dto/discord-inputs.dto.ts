import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/** Compose an announcement to cross-post to Discord. */
export class AnnounceDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  @ApiPropertyOptional({ description: 'Override the configured announcement channel.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  channelId?: string;
}

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

/** Query for the recent bot operations list. */
export class DiscordOperationsQueryDto extends PaginationQueryDto {}
