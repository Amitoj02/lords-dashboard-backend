import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { RsvpStatus } from '../../common/enums';

/** Body for POST /api/events/:id/rsvp — the caller's attendance intent. */
export class RsvpDto {
  @ApiProperty({ enum: RsvpStatus })
  @IsEnum(RsvpStatus)
  status: RsvpStatus;

  @ApiPropertyOptional({ minimum: 0, description: 'Personal reminder lead time in minutes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  reminderOffsetMinutes?: number;
}
