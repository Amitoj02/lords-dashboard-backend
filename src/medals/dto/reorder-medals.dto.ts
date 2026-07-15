import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray } from 'class-validator';
import { IsShortId } from '../../common/ids/short-id';

/**
 * Body for POST /api/medals/reorder. `order` is the full list of the regiment's
 * medal ids in the new order — the first id becomes precedence 1, the last
 * becomes precedence N. The set MUST match all of the regiment's medals exactly
 * (validated server-side); a partial or foreign id set is rejected.
 */
export class ReorderMedalsDto {
  @ApiProperty({
    type: [String],
    description: 'All medal ids in the new order (precedence 1..N)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsShortId({ each: true })
  order: string[];
}
