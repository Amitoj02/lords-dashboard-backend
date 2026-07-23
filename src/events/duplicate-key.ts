/**
 * True when a driver error is a MySQL duplicate-key failure (ER_DUP_ENTRY /
 * errno 1062), whichever layer wrapped it — TypeORM's `QueryFailedError` copies
 * `code`/`errno` onto itself but older/other drivers only expose them on
 * `driverError`.
 *
 * Shared (T-0163) because two callers depend on the SAME judgement about
 * UQ_event_occurrence(recurrence_template_id, starts_at): the recurrence sweep,
 * which treats a collision as "a concurrent sweep already made this occurrence"
 * and skips it, and the re-anchor action, which turns it into a 409 instead of a
 * 500. If one of them ever stopped recognising a wrapping, the two would
 * disagree about the same database error — so they read one predicate.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const e = error as { code?: string; errno?: number; driverError?: { errno?: number } };
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 || e?.driverError?.errno === 1062;
}
