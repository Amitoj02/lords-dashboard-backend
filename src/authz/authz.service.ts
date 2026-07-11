import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Capability, MemberRole } from '../common/enums';
import { RolePermission } from './entities/role-permission.entity';

/**
 * Reads and caches the `role_permissions` matrix (capability × role, per
 * regiment). The cache is lazily populated per regiment; any mutation to the
 * matrix must call {@link AuthzService.invalidate} so the next check reloads.
 *
 * This is the source of truth for capability checks — stricter than the coarse
 * role tier (e.g. Moderator can manage applications but cannot view the audit
 * log or edit ranks/medals).
 */
@Injectable()
export class AuthzService {
  /** regimentId → (role → set of granted capability keys). */
  private readonly cache = new Map<string, Map<MemberRole, Set<string>>>();

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
    if (cached) return cached;

    const rows = await this.permissions.find({ where: { regimentId, granted: true } });
    const matrix = new Map<MemberRole, Set<string>>();
    for (const row of rows) {
      const set = matrix.get(row.role) ?? new Set<string>();
      set.add(row.capability);
      matrix.set(row.role, set);
    }
    this.cache.set(regimentId, matrix);
    return matrix;
  }
}
