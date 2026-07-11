import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ApplicationStatus } from '../../common/enums';

/** Query params for GET /api/applications (the admin recruitment queue). */
export class ApplicationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ApplicationStatus, description: 'Filter by application status' })
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;
}
