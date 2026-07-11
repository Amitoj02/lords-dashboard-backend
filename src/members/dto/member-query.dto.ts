import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { MemberRole, MemberStatus } from '../../common/enums';

/**
 * Query params for the roster list endpoint. Extends the shared pagination DTO
 * (page/limit/search) with roster-specific filters. `search` is a case-insensitive
 * LIKE across member name, in-game name and the linked Discord tag.
 */
export class MemberQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: MemberRole,
    description: 'Filter by member role',
  })
  @IsOptional()
  @IsEnum(MemberRole)
  role?: MemberRole;

  @ApiPropertyOptional({
    enum: MemberStatus,
    description: 'Filter by member status',
  })
  @IsOptional()
  @IsEnum(MemberStatus)
  status?: MemberStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filter by rank id',
  })
  @IsOptional()
  @IsUUID()
  rankId?: string;
}
