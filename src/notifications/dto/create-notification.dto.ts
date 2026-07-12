import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NotificationTone } from '../../common/enums';

/**
 * Body for POST /api/notifications. The regiment is taken from the JWT, not the
 * body. `authorLabel` defaults to the caller's member name (falling back to
 * 'Command') when omitted.
 */
export class CreateNotificationDto {
  @ApiProperty({ minLength: 1, maxLength: 160, example: 'Operation Thunderclap briefing' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title: string;

  @ApiProperty({ minLength: 1, description: 'Announcement body (free text)' })
  @IsString()
  @MinLength(1)
  body: string;

  @ApiPropertyOptional({ enum: NotificationTone, default: NotificationTone.Info })
  @IsOptional()
  @IsEnum(NotificationTone)
  tone?: NotificationTone;

  @ApiPropertyOptional({ maxLength: 120, example: 'Command' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  authorLabel?: string;
}
