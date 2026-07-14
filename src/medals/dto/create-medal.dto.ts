import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { MedalRibbon } from '../../common/enums';

/**
 * Body for POST /api/medals. The owning regiment is taken from the JWT, not the
 * body. `title` must be unique per regiment (enforced in the service).
 * `precedence` is optional — when omitted the medal is placed at the end of the
 * ladder (max precedence + 1).
 */
export class CreateMedalDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: 'Distinguished Service Cross' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiProperty({ minLength: 1, maxLength: 4, example: 'DSC', description: 'Short glyph (1..4)' })
  @IsString()
  @MinLength(1)
  @MaxLength(4)
  glyph: string;

  @ApiProperty({ enum: MedalRibbon })
  @IsEnum(MedalRibbon)
  ribbon: MedalRibbon;

  @ApiPropertyOptional({ maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Storage key of an uploaded medal image (from POST /storage/uploads)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageKey?: string;

  @ApiPropertyOptional({ description: 'Display order; defaults to end of the ladder', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  precedence?: number;

  @ApiPropertyOptional({ maxLength: 80, description: 'Mapped Discord role name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  discordRoleName?: string;
}
