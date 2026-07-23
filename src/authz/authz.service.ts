import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Capability, MemberRole } from '../common/enums';
import { RolePermission } from './entities/role-permission.entity';

/**
 * How long a cached matrix may be trusted without re-reading the table.
 *
 * The cache is invalidated eagerly whenever the matrix is edited THROUGH THE
 * API, so this TTL is not the propagation path for an admin's change — that is
 * still instant. It exists for changes that arrive OUT OF BAND, where nothing
 * can call {@link AuthzService.invalidate}:
 *
 *  - `seed:prod` runs on every deploy and back-fills the default grant for any
 *    capability added since the database was provisioned. It writes straight to
 *    the table, in a separate process.
 *  - a migration, or a manual SQL repair against a live database.
 *
 * Without a TTL those changes are invisible until the process restarts, and the
 * failure is silent AND self-contradictory: `GET /settings/permissions` reads
 * the table and reports the capability as granted, while the guard reads the
 * stale cache and denies it. Thirty seconds bounds that window without making
 * the matrix a per-request query.
 */
const CACHE_TTL_MS = 30_000;

/** A memoised matrix plus the moment it was read, so it can expire. */
interface CachedMatrix {
  matrix: Map<MemberRole, Set<string>>;
  loadedAt: number;
}

/**
 * Reads and caches the `role_permissions` matrix (capability × role, per
 * regiment). The cache is lazily populated per regiment; any mutation made
 * through the API must call {@link AuthzService.invalidate} so the next check
 * reloads immediately, and an out-of-band change is picked up within
 * {@link CACHE_TTL_MS}.
 *
 * This is the source of truth for capability checks — stricter than the coarse
 * role tier (e.g. Moderator can manage applications but cannot view the audit
 * log or edit ranks/medals).
 */
@Injectable()
export class AuthzService {
  /** regimentId → the memoised matrix + its load time. */
  private readonly cache = new Map<string, CachedMatrix>();

  constructor(
    @InjectRepository(RolePermission)
    private readonly permissions: Repository<RolePermission>,
  ) {}

  /** True when `role` is granted `capability` within `regimentId`. */
  async can(
    regimentId: string,
    role: MemberRole,
    capability: Capability | string,
  ): Promise<boolean> {
    const matrix = await this.getRegimentMatrix(regimentId);
    return matrix.get(role)?.has(capability) ?? false;
  }

  /** Every capability key granted to `role` within `regimentId`. */
  async grantedCapabilities(regimentId: string, role: MemberRole): Promise<string[]> {
    const matrix = await this.getRegimentMatrix(regimentId);
    return [...(matrix.get(role) ?? [])];
  }

  /** Drop the cached matrix for a regiment (or all regiments) after it changes. */
  invalidate(regimentId?: string): void {
    if (regimentId) {
      this.cache.delete(regimentId);
    } else {
      this.cache.clear();
    }
  }

  /** Load (and memoise) the granted-capability sets for a regiment. */
  private async getRegimentMatrix(regimentId: string): Promise<Map<MemberRole, Set<string>>> {
    const cached = this.cache.get(regimentId);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.matrix;
    }

    const rows = await this.permissions.find({ where: { regimentId, granted: true } });
    const matrix = new Map<MemberRole, Set<string>>();
    for (const row of rows) {
      const set = matrix.get(row.role) ?? new Set<string>();
      set.add(row.capability);
      matrix.set(row.role, set);
    }
    this.cache.set(regimentId, { matrix, loadedAt: Date.now() });
    return matrix;
  }
}
