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
}
