/**
 * The rank names the server resolves by string rather than by id — and are
 * therefore load-bearing, not just conventional.
 *
 * The ladder is otherwise entirely the admin's: they may add, remove, reorder,
 * re-icon and re-link anything on it. The rows named here are the exception,
 * because a piece of server logic looks them up by name at runtime, so a rename
 * or a delete does not change a label — it removes the row that logic resolves.
 *
 * Protection is derived from the SAME constants the coupled code imports, so a
 * rank cannot become load-bearing without also becoming protected: there is no
 * second list to keep in step.
 */

/**
 * The rank every approved applicant enlists at. `ApplicationsService.approve`
 * resolves it by name inside the enlistment transaction, so if this row is gone
 * (or renamed out from under it) no application can be approved at all.
 */
export const ENTRY_RANK_NAME = 'Recruit';

/**
 * Every rank the server depends on by name. Ordered as it reads to a human; the
 * lookup below is what actually decides membership.
 *
 * Adding a name here means revisiting the refusal message in
 * `RanksService.assertNotProtected`, which names the enlistment coupling
 * concretely — an admin who cannot rename a rank deserves to be told which
 * mechanism is holding it.
 */
export const PROTECTED_RANK_NAMES: readonly string[] = [ENTRY_RANK_NAME];

/**
 * Whether a rank carrying this name is one the server depends on.
 *
 * Case- and whitespace-insensitive on purpose: MySQL's default collation is
 * case-insensitive, so the `WHERE name = 'Recruit'` this exists to defend
 * already matches a row stored as `recruit`. A stricter comparison here would
 * leave a "protected" rank renameable to a casing variant the lookup still
 * finds — protection that disagrees with the query it protects.
 */
export function isProtectedRankName(name: string): boolean {
  const needle = name.trim().toLowerCase();
  return PROTECTED_RANK_NAMES.some((protectedName) => protectedName.toLowerCase() === needle);
}
