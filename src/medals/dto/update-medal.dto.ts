import { PartialType } from '@nestjs/swagger';
import { CreateMedalDto } from './create-medal.dto';

/**
 * Body for PATCH /api/medals/:id. Every field is optional; only the provided
 * fields are applied. `title` uniqueness (per regiment) is re-checked in the
 * service when it changes.
 */
export class UpdateMedalDto extends PartialType(CreateMedalDto) {}
