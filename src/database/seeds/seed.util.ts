import { DeepPartial, FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';

/** Deterministic ids so re-seeding is idempotent and tests can rely on them. */
export const REGIMENT_ID = '00000000-0000-4000-8000-000000000001';
export const OWNER_MEMBER_ID = '00000000-0000-4000-8000-000000000010';
export const OWNER_IDENTITY_ID = '00000000-0000-4000-8000-000000000020';
export const OWNER_DISCORD_USER_ID = '100000000000000001';

/**
 * Idempotent upsert-by-natural-key: find the row, merge new data and save; or
 * create it. Used by all seeders so `npm run seed` is safe to re-run.
 */
export async function ensure<T extends ObjectLiteral>(
  repo: Repository<T>,
  where: FindOptionsWhere<T>,
  data: DeepPartial<T>,
): Promise<T> {
  const existing = await repo.findOne({ where });
  if (existing) {
    repo.merge(existing, data);
    return repo.save(existing);
  }
  const entity = repo.create({ ...(where as object), ...(data as object) } as DeepPartial<T>);
  return repo.save(entity);
}
