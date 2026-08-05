import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsShortId } from '../../common/ids/short-id';

/**
 * Query for the PUBLIC roster (T-0215).
 *
 * Deliberately not `MemberQueryDto`. That one exposes `role` and `status`
 * filters, and both are meaningless-to-harmful here: the public roster already
 * hard-excludes every role and status a filter would be used to select
 * (Applicant, Pending, suspended, banned), so offering them would only let an
 * anonymous caller probe the exclusion predicate for who is missing and why.
 */
export class PublicMemberQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Case-insensitive match against the in-game name or the vanity handle',
  })
  // Narrows the inherited field: the base declares it unbounded, and an
  // unbounded LIKE term on an anonymous endpoint is a free table scan.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  declare search?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single rank' })
  @IsOptional()
  @IsShortId()
  rankId?: string;
}
