import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Body for POST /api/ranks. The regiment is taken from the JWT, not the body.
 * `chevrons` defaults to 0 and `precedence` (when omitted) is placed at the end
 * of the ladder — both defaults are applied server-side, so no property
 * initializer is used here (that would leak a default through PartialType into
 * the PATCH DTO).
 */
export class CreateRankDto {
  @ApiProperty({ minLength: 1, maxLength: 60, example: 'Sergeant' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 5, default: 0, description: 'Chevron count' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  chevrons?: number;

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
