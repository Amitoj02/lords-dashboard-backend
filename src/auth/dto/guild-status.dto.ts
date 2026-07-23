import { ApiProperty } from '@nestjs/swagger';

/**
 * The answer to "may this session still be treated as a regiment Discord
 * member?" (T-0167), served by GET /auth/guild-status.
 *
 * It is deliberately four fields rather than one boolean because the client has
 * to distinguish three different situations that a single flag would flatten
 * into "blocked": genuinely not in the guild, gating switched off entirely, and
 * "we could not check". Only the first is a real verdict.
 */
export class GuildStatusDto {
  @ApiProperty({
    description:
      'Last known verdict for "is this Discord identity in the regiment guild?". ' +
      'Reported honestly even for exempt callers and even when the gate is off.',
  })
  guildMember: boolean;

  @ApiProperty({ description: 'Whether guild-membership gating is switched on for this regiment' })
  gateEnabled: boolean;

  @ApiProperty({
    description:
      'True when this caller bypasses the gate (holds manage_settings), so a bot or ' +
      'invite misconfiguration can never lock the regiment out of its own settings.',
  })
  exempt: boolean;

  @ApiProperty({
    nullable: true,
    description: 'ISO-8601 of the last successful bot lookup, or null if never checked',
  })
  checkedAt: string | null;

  @ApiProperty({
    description:
      'True when the verdict could not be refreshed (bot down, timed out, or the ' +
      'circuit breaker is open). The verdict shown is then the last known one — or ' +
      '`guildMember: true` when there has never been one, because the gate FAILS OPEN.',
  })
  degraded: boolean;
}
