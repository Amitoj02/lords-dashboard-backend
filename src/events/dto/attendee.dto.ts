import { ApiProperty } from '@nestjs/swagger';
import { EventAttendee } from '../entities/event-attendee.entity';

/** A confirmed attendee row, enriched with the member's roster display name. */
export class AttendeeDto {
  @ApiProperty({ format: 'uuid' })
  memberId: string;

  @ApiProperty({
    nullable: true,
    description: 'Roster display name (null if the member was removed)',
  })
  name: string | null;

  @ApiProperty({ nullable: true, description: 'ISO timestamp the member was checked in' })
  checkedInAt: string | null;

  static from(attendee: EventAttendee, name: string | null): AttendeeDto {
    const dto = new AttendeeDto();
    dto.memberId = attendee.memberId;
    dto.name = name;
    dto.checkedInAt = attendee.checkedInAt ? attendee.checkedInAt.toISOString() : null;
    return dto;
  }
}
