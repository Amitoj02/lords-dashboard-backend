import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray } from 'class-validator';
import { IsShortId } from '../../common/ids/short-id';

/** Body for POST /api/events/:id/attendees — the member ids to mark present. */
export class MarkAttendanceDto {
  @ApiProperty({ type: [String], description: 'Member ids to check in' })
  @IsArray()
  @ArrayNotEmpty()
  @IsShortId({ each: true })
  memberIds: string[];
}
