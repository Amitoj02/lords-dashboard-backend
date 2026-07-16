import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { EventStatus } from '../../common/enums';

/** Query params for the event list endpoints (public + member). */
export class EventQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EventStatus, description: 'Filter by lifecycle status' })
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @ApiPropertyOptional({
    description:
      'Include archived events in the member list (moderators/ManageEvents only; ' +
      'ignored for callers without the capability).',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  archived?: boolean;
}
