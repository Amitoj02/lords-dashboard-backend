import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AuditSeverity } from '../../common/enums';

/** Query params for GET /api/audit (extends the shared pagination params). */
export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AuditSeverity, description: 'Filter by severity' })
  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @ApiPropertyOptional({ description: 'Filter by action code, e.g. application.approve' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Filter by actor member id' })
  @IsOptional()
  @IsUUID()
  actorMemberId?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound (ISO 8601) on occurredAt' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound (ISO 8601) on occurredAt' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
