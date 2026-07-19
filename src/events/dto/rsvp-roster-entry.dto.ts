import { ApiProperty } from '@nestjs/swagger';
import { RsvpStatus } from '../../common/enums';
import { EventRsvp } from '../entities/event-rsvp.entity';

/**
 * One entry of an event's RSVP roster (T-0127): who RSVP'd, their avatar and
 * their choice. Distinct from {@link AttendeeDto} (who was checked in). Exposed
 * only to callers with ViewMembersDirectory — it surfaces member identities.
 */
export class RsvpRosterEntryDto {
  @ApiProperty({ format: 'uuid' })
  memberId: string;

  @ApiProperty({ nullable: true, description: 'Roster display name (in-game name)' })
  name: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Custom avatar, falling back to the linked Discord avatar, else null',
  })
  avatarUrl: string | null;

  @ApiProperty({ enum: RsvpStatus, description: 'The member’s RSVP choice' })
  status: RsvpStatus;

  /**
   * Build from an RSVP row with its member relation loaded (and the member's
   * discordIdentity, for the avatar fallback). Mirrors the member.dto avatar
   * precedence: custom avatar first, then the linked Discord avatar.
   */
  static from(rsvp: EventRsvp): RsvpRosterEntryDto {
    const dto = new RsvpRosterEntryDto();
    dto.memberId = rsvp.memberId;
    dto.name = rsvp.member?.inGameName ?? null;
    dto.avatarUrl = rsvp.member?.avatarUrl ?? rsvp.member?.discordIdentity?.avatarUrl ?? null;
    dto.status = rsvp.status;
    return dto;
  }
}
