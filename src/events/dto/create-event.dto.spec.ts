import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateEventDto } from './create-event.dto';
import { UpdateEventDto } from './update-event.dto';

/**
 * T-0080 — event tags are hard-capped at 10 at the DTO layer (the DB cannot cap
 * per-event row count without a trigger). UpdateEventDto inherits the rule via
 * PartialType, so PATCH is covered by the same constraint.
 */
const base = {
  title: 'Friday Line Battle',
  startsAt: '2026-08-01T18:00:00.000Z',
};

function hasTagsError<T extends object>(dto: object, cls: new () => T): boolean {
  return validateSync(plainToInstance(cls, dto), { whitelist: true }).some(
    (e) => e.property === 'tags',
  );
}

describe('CreateEventDto tags limit (T-0080)', () => {
  it('accepts exactly 10 tags', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    expect(hasTagsError({ ...base, tags }, CreateEventDto)).toBe(false);
  });

  it('rejects 11 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    expect(hasTagsError({ ...base, tags }, CreateEventDto)).toBe(true);
  });

  it('still rejects a tag longer than 40 chars', () => {
    expect(hasTagsError({ ...base, tags: ['x'.repeat(41)] }, CreateEventDto)).toBe(true);
  });

  it('UpdateEventDto inherits the 10-tag cap via PartialType', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    expect(hasTagsError({ tags }, UpdateEventDto)).toBe(true);
    expect(hasTagsError({ tags: tags.slice(0, 10) }, UpdateEventDto)).toBe(false);
  });
});
