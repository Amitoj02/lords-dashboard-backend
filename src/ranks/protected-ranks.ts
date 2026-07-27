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
 * The rank whose LINKED DISCORD ROLE marks someone with an application in
 * flight. `ApplicationsService.submit` resolves it by name to add that role, and
 * both `approve` and `decline` resolve it again to take the role back — so the
 * row is how the server finds the "Applicant" role at all three points.
 *
 * Nobody is ever placed ON this rank in the dashboard: an applicant has no
 * membership yet. It exists as a rank purely so the admin has one Discord-role
 * link to configure, in the same screen as every other role link.
 */
export const APPLICANT_RANK_NAME = 'Applicant';

/**
 * The rank a mercenary wears. The membership-role policy resolves it by name to
 * decide who does NOT receive the regiment's Membership role — a mercenary
 * fights alongside the regiment without being of it, which is exactly the
 * distinction that role is there to draw.
 */
export const MERCENARY_RANK_NAME = 'Mercenary';

/**
 * Every rank the server depends on by name. Ordered as it reads to a human; the
 * lookup below is what actually decides membership.
 *
 * Each entry carries the mechanism holding it, because an admin who cannot
 * rename a rank deserves to be told which one — a bare "this is protected" makes
 * the ladder feel arbitrary. {@link RanksService.assertNotProtected} renders the
 * `because` clause straight into its refusal, so the explanation cannot drift
 * from the list.
 */
export const PROTECTED_RANKS: readonly { name: string; because: string }[] = [
  {
    name: ENTRY_RANK_NAME,
    because:
      'every approved applicant is enlisted onto it by name, so renaming or ' +
      'removing it would break application approvals',
  },
  {
    name: APPLICANT_RANK_NAME,
    because:
      'its linked Discord role is what marks an application in flight — the ' +
      'server adds that role on submit and takes it back on the decision, and ' +
      'finds it through this row',
  },
  {
    name: MERCENARY_RANK_NAME,
    because:
      'it is how the server tells a mercenary from a member when deciding who ' +
      'receives the regiment Membership role',
  },
];

/** Just the names, for callers that only need the set. */
export const PROTECTED_RANK_NAMES: readonly string[] = PROTECTED_RANKS.map((rank) => rank.name);

/** Normalised form used for every comparison in this module. */
function normalise(name: string): string {
  return name.trim().toLowerCase();
}

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
  const needle = normalise(name);
  return PROTECTED_RANK_NAMES.some((protectedName) => normalise(protectedName) === needle);
}

/**
 * Why this rank is protected, or null if it is not. Same matching rules as
 * {@link isProtectedRankName}.
 */
export function protectedRankReason(name: string): string | null {
  const needle = normalise(name);
  return PROTECTED_RANKS.find((rank) => normalise(rank.name) === needle)?.because ?? null;
}
