import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Body for POST /api/settings/dissolve. `confirmName` MUST exactly equal the
 * regiment name — a mismatch is rejected. Destructive: soft-deletes the regiment.
 *
 * The only action DTO left in this file: T-0170 retired TransferOwnershipDto
 * (no ownership-transfer endpoint remains) and TransferDiscordDto (POST
 * /api/discord/bind is the sole guild binder).
 */
export class DissolveDto {
  @ApiProperty({ description: 'Must exactly match the regiment name to confirm dissolution' })
  @IsString()
  confirmName: string;
}
