import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsShortId } from '../../common/ids/short-id';

/**
 * Body for POST /api/settings/transfer-ownership. `confirm` MUST be true — a
 * false value is rejected as a bad request (the transfer is irreversible from
 * the previous owner's side; they are demoted to Admin).
 */
export class TransferOwnershipDto {
  @ApiProperty({ description: 'The member to make the new Owner' })
  @IsShortId()
  toMemberId: string;

  @ApiProperty({ description: 'Must be true to confirm the ownership transfer' })
  @IsBoolean()
  confirm: boolean;
}

/** Body for POST /api/settings/transfer-discord. Rebinds the regiment's guild. */
export class TransferDiscordDto {
  @ApiProperty({ maxLength: 20, description: 'New Discord guild id (snowflake)' })
  @IsString()
  @MaxLength(20)
  discordServerId: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  discordServerName?: string;
}

/**
 * Body for POST /api/settings/dissolve. `confirmName` MUST exactly equal the
 * regiment name — a mismatch is rejected. Destructive: soft-deletes the regiment.
 */
export class DissolveDto {
  @ApiProperty({ description: 'Must exactly match the regiment name to confirm dissolution' })
  @IsString()
  confirmName: string;
}
