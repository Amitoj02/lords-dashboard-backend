import { DeepPartial, FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';

/**
 * Deterministic ids so re-seeding is idempotent and tests can rely on them.
 * REGIMENT_ID / OWNER_MEMBER_ID use the 12-char short-id scheme (T-0085).
 * OWNER_IDENTITY_ID stays a uuid because discord_identities.id is retained
 * opaque (the JWT `sub`); OWNER_DISCORD_USER_ID is an external Discord snowflake.
 */
export const REGIMENT_ID = 'Rgmt00000001';
export const OWNER_MEMBER_ID = 'Ownr00000001';
export const OWNER_IDENTITY_ID = '00000000-0000-4000-8000-000000000020';
export const OWNER_DISCORD_USER_ID = '100000000000000001';

/**
 * Upsert-by-natural-key: find the row, merge new data and save; or create it.
 *
 * ⚠️ Idempotent is NOT the same as non-destructive. Re-running this hands the
 * hardcoded defaults back to an existing row, so it belongs ONLY on code-owned
 * reference catalogs (accent tones, audit actions) where the seed file is the
 * source of truth and refreshing on deploy is the point. For anything an admin
 * can edit in the UI, use `provision` — `seed:prod` runs on EVERY deploy.
 *
 * `insertOnly` fields are applied ONLY when the row is first created and are
 * never merged over an existing row on re-seed — so a value the owner has since
 * customized (e.g. their display name) survives `npm run seed` (T-0057). Omit it
 * for the plain merge-upsert behaviour the reference catalogs rely on.
 */
export async function ensure<T extends ObjectLiteral>(
  repo: Repository<T>,
  where: FindOptionsWhere<T>,
  data: DeepPartial<T>,
  insertOnly?: DeepPartial<T>,
): Promise<T> {
  const existing = await repo.findOne({ where });
  if (existing) {
    repo.merge(existing, data);
    return repo.save(existing);
  }
  const entity = repo.create({
    ...(where as object),
    ...(data as object),
    ...(insertOnly as object),
  } as DeepPartial<T>);
  return repo.save(entity);
}

/**
 * Insert-only: create the row if it is missing, and do NOTHING at all when it
 * already exists (not even a no-op UPDATE, so `updated_at` is left alone).
 *
 * Use this for any row the ADMIN owns after provisioning. `ensure` merges its
 * `data` over the existing row, which is correct for a code-owned reference
 * catalog and destructive for anything editable in the UI — re-seeding would
 * quietly hand back the defaults and discard the admin's configuration.
 *
 * Only safe when `where` is an IMMUTABLE key. Keying on something the admin can
 * rename (a rank's `name`, a medal's `title`) would fail to find the renamed row
 * and provision a duplicate — which is why those catalogs are gated on a
 * greenfield database in MainSeeder rather than provisioned row by row.
 */
export async function provision<T extends ObjectLiteral>(
  repo: Repository<T>,
  where: FindOptionsWhere<T>,
  data: DeepPartial<T>,
): Promise<T> {
  const existing = await repo.findOne({ where });
  if (existing) return existing;
  return repo.save(repo.create({ ...(where as object), ...(data as object) } as DeepPartial<T>));
}
