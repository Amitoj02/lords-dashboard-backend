import { ApiProperty } from '@nestjs/swagger';
import { MemberRole } from '../../common/enums';

/** The `CurrentUser` projection the frontend's AuthService expects from /auth/me. */
export class CurrentUserDto {
  @ApiProperty({ description: 'Member id when enrolled, else the Discord identity id' })
  id: string;

  @ApiProperty({ description: 'In-game name (member) or Discord display name (identity-only)' })
  inGameName: string;

  @ApiProperty({
    nullable: true,
    description:
      'The vanity handle backing /u/@handle, or null when unclaimed. Always null for an ' +
      'identity-only caller — they are not on the roster and have no handle to claim yet.',
  })
  username: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Rank name; null for identity-only (not yet a member)',
  })
  rank: string | null;

  @ApiProperty({ enum: MemberRole })
  role: MemberRole;

  @ApiProperty({ nullable: true })
  discordTag: string | null;

  @ApiProperty()
  discordLinked: boolean;

  @ApiProperty({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ description: 'True when the identity is linked to a roster member' })
  isMember: boolean;

  @ApiProperty({
    type: [String],
    description:
      "The caller's effective capability keys, resolved from the role_permissions " +
      'matrix for their role. The frontend gates UI on these rather than on the ' +
      'coarse role (e.g. `manage_applications`, `edit_ranks_medals`).',
    example: ['view_members_directory', 'manage_applications'],
  })
  capabilities: string[];

  @ApiProperty({
    description:
      'Last known verdict for "is this Discord identity in the regiment guild?" (T-0166). ' +
      'Reported honestly even for exempt callers. An identity whose membership has never ' +
      'been confirmed reads as `true`, because the check FAILS OPEN (T-0168).',
  })
  guildMember: boolean;

  @ApiProperty({
    nullable: true,
    description:
      "The regiment's Discord invite, or null when unconfigured. Never omitted — the client " +
      'needs it to offer a way OUT of the gate, not just a wall. Already public on the ' +
      'anonymous regiment profile, so surfacing it here exposes nothing new.',
  })
  discordInviteUrl: string | null;

  @ApiProperty({
    description:
      'Whether guild-membership gating is switched on for this regiment. False by default ' +
      '(the bot rollout has not happened), in which case `guildMember` is informational only.',
  })
  guildGateEnabled: boolean;

  @ApiProperty({
    description:
      'Whether this caller bypasses the gate (holds manage_settings), so a bot or invite ' +
      'misconfiguration can never lock the regiment out of its own settings.',
  })
  guildGateExempt: boolean;
}
