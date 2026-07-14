import { ApiProperty } from '@nestjs/swagger';

/**
 * Response of POST /api/storage/uploads. The client PUTs the file bytes to
 * `uploadUrl` (with the same Content-Type it declared), then submits `key` back
 * to the owning resource (e.g. PATCH /members/me { avatarKey }). The server
 * re-validates the key's namespace and stores `publicUrl` on the entity.
 */
export class PresignedUploadDto {
  @ApiProperty({ description: 'The namespaced object key to submit back to the owning resource' })
  key: string;

  @ApiProperty({ description: 'Presigned PUT URL — upload the bytes here (expires soon)' })
  uploadUrl: string;

  @ApiProperty({ description: 'Stable public URL the object will be served from once uploaded' })
  publicUrl: string;

  @ApiProperty({ description: 'Seconds until the presigned URL expires' })
  expiresIn: number;

  @ApiProperty({
    description: 'Content-Type the client MUST send on the PUT to match the signature',
  })
  requiredContentType: string;
}
