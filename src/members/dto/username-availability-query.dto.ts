import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import { USERNAME_MAX_LENGTH, normalizeUsername } from '../../common/ids/username';

/**
 * Query for the live handle-availability probe.
 *
 * Deliberately does NOT apply `@IsUsername()`: this endpoint has to be able to
 * answer "no, and here is why" for a malformed handle while the member is still
 * typing it. A 400 mid-keystroke would give the form nothing to render.
 */
export class UsernameAvailabilityQueryDto {
  @ApiProperty({ description: 'The candidate handle, without the @ sigil' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeUsername(value) : value,
  )
  @IsString()
  @MaxLength(USERNAME_MAX_LENGTH)
  username: string;
}
