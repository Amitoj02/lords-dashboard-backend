import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { EventStatus } from '../../common/enums';

/** Query params for the event list endpoints (public + member). */
export class EventQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EventStatus, description: 'Filter by lifecycle status' })
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;
}
