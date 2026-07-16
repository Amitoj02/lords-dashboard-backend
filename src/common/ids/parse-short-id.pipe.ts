import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { SHORT_ID_REGEX } from './short-id';

/**
 * Route-param pipe validating the 12-char base62 short-id format (T-0084).
 * Drop-in replacement for `ParseUUIDPipe` on entity-id path params — a malformed
 * id is rejected with 400 before the handler runs.
 */
@Injectable()
export class ParseShortIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !SHORT_ID_REGEX.test(value)) {
      throw new BadRequestException('Validation failed (id expected)');
    }
    return value;
  }
}
