import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsString,
  ValidateNested,
} from 'class-validator';
import { MemberRole } from '../../common/enums';

/** A single cell edit: grant/revoke one capability for one role. */
export class PermissionChangeDto {
  @ApiProperty({ enum: MemberRole })
  @IsEnum(MemberRole)
  role: MemberRole;

  @ApiProperty({ description: 'Capability key (role_permissions.capability)' })
  @IsString()
  capability: string;

  @ApiProperty()
  @IsBoolean()
  granted: boolean;
}

/**
 * Body for PATCH /api/settings/permissions. A batch of cell edits applied
 * atomically after the Owner "floor guard" verifies the resulting matrix still
 * leaves the regiment governable (see SettingsService.updatePermissions).
 */
export class UpdatePermissionsDto {
  @ApiProperty({ type: [PermissionChangeDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PermissionChangeDto)
  changes: PermissionChangeDto[];
}
