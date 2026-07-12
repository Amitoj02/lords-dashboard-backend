import { PartialType } from '@nestjs/swagger';
import { CreateEventDto } from './create-event.dto';

/**
 * Body for PATCH /api/events/:id. Every field of the create body is optional; only
 * provided scalar fields are applied. When `platforms`, `tags` or `notifyOffsets`
 * arrays are provided they REPLACE the existing child rows wholesale (omit them to
 * leave a collection untouched).
 */
export class UpdateEventDto extends PartialType(CreateEventDto) {}
