import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsOptional } from 'class-validator';

/**
 * Body for POST /api/events/:id/reanchor — the one-click repair for an event
 * written before T-0156 (T-0163). The action keeps the wall clock the author
 * typed and moves the stored instant onto it; `timezone` is never changed.
 *
 * `expectStartsAtLocal` is not decoration: no column marks a repaired row, so
 * running the repair twice would double-shift it. Stating the expected wall
 * clock turns a repeat into a loud 400 instead of a silent second shift.
 */
export class ReanchorEventDto {
  @ApiProperty({
    example: '2026-07-20T21:57:00',
    description:
      "The wall clock the author originally typed. Must equal the event's current UTC " +
      'field-view (what a pre-T-0156 row encodes) or the request is rejected — this is the ' +
      'guard that makes a second run fail instead of shifting again.',
  })
  @IsDateString()
  expectStartsAtLocal: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Also re-anchor the occurrences already generated from this template. Only meaningful on ' +
      'a recurring template: without it the template moves alone, leaving the existing ' +
      'occurrence set stranded at the old wall clock while the next sweep generates a correct ' +
      'second set.',
  })
  @IsOptional()
  @IsBoolean()
  cascade?: boolean;
}
