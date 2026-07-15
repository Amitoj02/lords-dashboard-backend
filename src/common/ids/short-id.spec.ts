import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  generateShortId,
  isShortId,
  IsShortId,
  SHORT_ID_ALPHABET,
  SHORT_ID_LENGTH,
  SHORT_ID_REGEX,
} from './short-id';
import { ParseShortIdPipe } from './parse-short-id.pipe';
import { ShortIdSubscriber } from './short-id.subscriber';

type PkMeta = { propertyName: string; type: unknown; length: unknown };
const evt = (entity: { id?: string | null }, pks: PkMeta[]) =>
  ({ entity, metadata: { primaryColumns: pks } }) as never;

class Sample {
  @IsShortId()
  id!: string;
}

describe('short-id (T-0081/T-0082/T-0084)', () => {
  it('generates 12-char base62 ids', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = generateShortId();
      expect(id).toHaveLength(SHORT_ID_LENGTH);
      expect(SHORT_ID_REGEX.test(id)).toBe(true);
      for (const ch of id) {
        expect(SHORT_ID_ALPHABET).toContain(ch);
      }
    }
  });

  it('generates distinct ids (no immediate collisions)', () => {
    const set = new Set(Array.from({ length: 2000 }, () => generateShortId()));
    expect(set.size).toBe(2000);
  });

  it('isShortId accepts valid and rejects malformed ids', () => {
    expect(isShortId(generateShortId())).toBe(true);
    expect(isShortId('too-short')).toBe(false);
    expect(isShortId('0000000000000')).toBe(false); // 13 chars
    expect(isShortId('00000000-0000-4000-8000-000000000001')).toBe(false); // a uuid
    expect(isShortId(123)).toBe(false);
  });

  it('IsShortId validator passes valid and fails malformed', () => {
    expect(validateSync(plainToInstance(Sample, { id: generateShortId() }))).toHaveLength(0);
    expect(validateSync(plainToInstance(Sample, { id: 'nope' }))).not.toHaveLength(0);
  });

  it('ParseShortIdPipe returns valid ids and throws on malformed', () => {
    const pipe = new ParseShortIdPipe();
    const id = generateShortId();
    expect(pipe.transform(id)).toBe(id);
    expect(() => pipe.transform('bad')).toThrow();
    expect(() => pipe.transform('00000000-0000-4000-8000-000000000001')).toThrow();
  });

  describe('ShortIdSubscriber (T-0082)', () => {
    const sub = new ShortIdSubscriber();
    const charPk = [{ propertyName: 'id', type: 'char', length: '12' }];

    it('mints a short id for a char(12) `id` PK when unset', () => {
      const entity: { id?: string | null } = {};
      sub.beforeInsert(evt(entity, charPk));
      expect(isShortId(entity.id)).toBe(true);
    });

    it('does not overwrite an explicitly-set id', () => {
      const entity = { id: 'Preset000001' };
      sub.beforeInsert(evt(entity, charPk));
      expect(entity.id).toBe('Preset000001');
    });

    it('ignores retained-uuid PKs (varchar 36) and composite/non-id PKs', () => {
      const uuidEntity: { id?: string | null } = {};
      sub.beforeInsert(evt(uuidEntity, [{ propertyName: 'id', type: 'varchar', length: '36' }]));
      expect(uuidEntity.id).toBeUndefined();

      const composite: { id?: string | null } = {};
      sub.beforeInsert(
        evt(composite, [
          { propertyName: 'galleryItemId', type: 'char', length: '12' },
          { propertyName: 'tag', type: 'varchar', length: '40' },
        ]),
      );
      expect(composite.id).toBeUndefined();
    });
  });
});
