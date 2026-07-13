import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateEventDto } from './create-event.dto';

/**
 * Body for PATCH /api/events/:id. Every field of the create body is optional; only
 * provided scalar fields are applied. When `platforms`, `tags` or `notifyOffsets`
 * arrays are provided they REPLACE the existing child rows wholesale (omit them to
 * leave a collection untouched). `recurrenceActive` is update-only: set it false to
 * permanently stop a recurring template; `recurrenceCadence` (inherited) can be
 * changed to alter the cadence going forward.
 */
export class UpdateEventDto extends PartialType(CreateEventDto) {
  @ApiPropertyOptional({
    description: 'Stop flag for a recurring template; set false to permanently stop generation.',
  })
  @IsOptional()
  @IsBoolean()
  recurrenceActive?: boolean;
}
