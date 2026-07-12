import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Body for POST /api/events/:id/complete — closes an event out as `previous`. */
export class CompleteEventDto {
  @ApiPropertyOptional({ maxLength: 160, description: 'Short outcome / result summary' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  outcome?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Final head count that formed up in line' })
  @IsOptional()
  @IsInt()
  @Min(0)
  inLineCount?: number;
}
