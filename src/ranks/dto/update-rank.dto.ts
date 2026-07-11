import { PartialType } from '@nestjs/swagger';
import { CreateRankDto } from './create-rank.dto';

/**
 * Body for PATCH /api/ranks/:id. Every field of the create body is optional here;
 * only provided fields are applied. Uniqueness on (regiment, name) and
 * (regiment, precedence) is re-checked server-side, excluding the row itself.
 */
export class UpdateRankDto extends PartialType(CreateRankDto) {}
