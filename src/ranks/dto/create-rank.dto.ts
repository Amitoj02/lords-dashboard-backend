import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Body for POST /api/ranks. The regiment is taken from the JWT, not the body.
 * `precedence` (when omitted) is placed at the end of the ladder — applied
 * server-side, so no property initializer is used here (that would leak a default
 * through PartialType into the PATCH DTO). The rank insignia is a custom uploaded
 * image (`imageKey`); there is no chevron count.
 */
export class CreateRankDto {
  @ApiProperty({ minLength: 1, maxLength: 60, example: 'Sergeant' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Ladder position (1 = top). Omit to append at the end of the ladder.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  precedence?: number;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Storage key of an uploaded rank image (from POST /storage/uploads)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageKey?: string;

  @ApiPropertyOptional({ maxLength: 80, example: '@Sergeant' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  discordRoleName?: string;
}
