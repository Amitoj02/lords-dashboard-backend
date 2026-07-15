import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray } from 'class-validator';
import { IsShortId } from '../../common/ids/short-id';

/**
 * Body for POST /api/ranks/reorder. `order` is the full list of the regiment's
 * rank ids in the new top-to-bottom order — the first id becomes precedence 1,
 * the last becomes precedence N. The set MUST match all of the regiment's ranks
 * exactly (validated server-side); a partial or foreign id set is rejected.
 */
export class ReorderRanksDto {
  @ApiProperty({
    type: [String],
    description: 'All rank ids in the new top-to-bottom order (precedence 1..N)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsShortId({ each: true })
  order: string[];
}
