import { ApiProperty } from '@nestjs/swagger';
import { Capability, MemberRole } from '../../common/enums';

/**
 * The full authorization matrix (capability × role) for a regiment. `roles` and
 * `capabilities` give the client stable axis labels; `matrix[role][capability]`
 * is the granted boolean for every cell (missing rows default to `false`). Backs
 * `GET /api/settings/permissions` and is echoed back after an update.
 */
export class PermissionsMatrixDto {
  @ApiProperty({ enum: MemberRole, isArray: true })
  roles: MemberRole[];

  @ApiProperty({
    type: [String],
    description: 'Every capability key (role_permissions.capability)',
  })
  capabilities: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'role -> (capability -> granted). Absent cells are false.',
  })
  matrix: Record<string, Record<string, boolean>>;

  /** Wrap a fully-populated (all roles × all capabilities) matrix in the DTO. */
  static from(matrix: Record<string, Record<string, boolean>>): PermissionsMatrixDto {
    const dto = new PermissionsMatrixDto();
    dto.roles = Object.values(MemberRole);
    dto.capabilities = Object.values(Capability);
    dto.matrix = matrix;
    return dto;
  }
}
