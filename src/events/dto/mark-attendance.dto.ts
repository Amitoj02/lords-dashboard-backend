import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Body for POST /api/events/:id/attendees — the member ids to mark present. */
export class MarkAttendanceDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Member ids to check in' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  memberIds: string[];
}
