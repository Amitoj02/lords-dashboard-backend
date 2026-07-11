import { ApiProperty } from '@nestjs/swagger';
import { ServiceRecordEntry } from '../entities/service-record-entry.entity';
import { Member } from '../entities/member.entity';

/** One entry on a member's service timeline. */
export class ServiceRecordEntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'ISO timestamp the event occurred' })
  occurredAt: string;

  @ApiProperty({ description: 'Entry type, e.g. enlistment/promotion/award/deployment' })
  type: string;

  @ApiProperty()
  event: string;

  @ApiProperty({ nullable: true })
  note: string | null;

  static from(entry: ServiceRecordEntry): ServiceRecordEntryDto {
    const dto = new ServiceRecordEntryDto();
    dto.id = entry.id;
    dto.occurredAt = entry.occurredAt.toISOString();
    dto.type = entry.type;
    dto.event = entry.event;
    dto.note = entry.note;
    return dto;
  }
}

/**
 * Sensitive command information about a member (admin only, gated by
 * view_audit_log). Surfaces the last sign-in trail + moderation state that the
 * roster projection deliberately hides.
 */
export class CommandInfoDto {
  @ApiProperty({ format: 'uuid' })
  memberId: string;

  @ApiProperty({ nullable: true, description: 'ISO timestamp of last Discord sign-in' })
  lastSignInAt: string | null;

  @ApiProperty({ nullable: true, description: 'IP address of last sign-in' })
  lastSignInIp: string | null;

  @ApiProperty({ nullable: true })
  email: string | null;

  @ApiProperty({ nullable: true })
  discordUsername: string | null;

  @ApiProperty({ description: 'Whether the linked Discord identity is in the regiment guild' })
  guildMember: boolean;

  @ApiProperty({ nullable: true, description: 'ISO timestamp until which the member is suspended' })
  suspendedUntil: string | null;

  @ApiProperty({ nullable: true, description: 'ISO timestamp the member was banned' })
  bannedAt: string | null;

  static from(member: Member): CommandInfoDto {
    const dto = new CommandInfoDto();
    const identity = member.discordIdentity ?? null;
    dto.memberId = member.id;
    dto.lastSignInAt = identity?.lastSignInAt ? identity.lastSignInAt.toISOString() : null;
    dto.lastSignInIp = identity?.lastSignInIp ?? null;
    dto.email = identity?.email ?? null;
    dto.discordUsername = identity?.discordUsername ?? null;
    dto.guildMember = identity?.guildMember ?? false;
    dto.suspendedUntil = member.suspendedUntil ? member.suspendedUntil.toISOString() : null;
    dto.bannedAt = member.bannedAt ? member.bannedAt.toISOString() : null;
    return dto;
  }
}
