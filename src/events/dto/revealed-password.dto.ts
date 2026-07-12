import { ApiProperty } from '@nestjs/swagger';
import { RegimentEvent } from '../entities/event.entity';

/**
 * Response of POST /api/events/:id/reveal-password. SENSITIVE — this is the only
 * projection that exposes the decrypted server password, and only to a caller who
 * holds the RevealEventPasswords capability AND has RSVP'd to the event.
 */
export class RevealedPasswordDto {
  @ApiProperty({ nullable: true })
  serverName: string | null;

  @ApiProperty({ nullable: true })
  serverRegion: string | null;

  @ApiProperty({ nullable: true, description: 'Decrypted server password' })
  serverPassword: string | null;

  static from(event: RegimentEvent): RevealedPasswordDto {
    const dto = new RevealedPasswordDto();
    dto.serverName = event.serverName;
    dto.serverRegion = event.serverRegion;
    dto.serverPassword = event.serverPassword;
    return dto;
  }
}
