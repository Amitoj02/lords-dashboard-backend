import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource, In } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuditLogEntry } from '../src/audit/entities/audit-log-entry.entity';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { AuthzService } from '../src/authz/authz.service';
import { RolePermission } from '../src/authz/entities/role-permission.entity';
import { Capability, MemberRole, MemberStatus } from '../src/common/enums';
import { Medal } from '../src/medals/entities/medal.entity';
import { MemberMedal } from '../src/medals/entities/member-medal.entity';
import { Member } from '../src/members/entities/member.entity';
import { MEMBER_ADMIN_ACTIONS, MemberAdminAction } from '../src/members/member-hierarchy';
import { Rank } from '../src/ranks/entities/rank.entity';
import { Regiment } from '../src/regiments/entities/regiment.entity';

/**
 * E2E for T-0176/T-0177: the member admin actions honour a role hierarchy, and
 * the `permittedActions` flags on the member projection say exactly what the
 * endpoints do.
 *
 * Sessions are minted directly from a saved identity (the pattern from
 * account-deletion.e2e-spec) rather than through the OAuth flow, because the
 * whole point is to exercise callers at ARBITRARY roles — something the sign-in
 * flow cannot produce.
 *
 * The e2e database persists between runs and is shared, so every row this suite
 * creates is torn down in both beforeAll and afterAll, the two capability grants
 * it flips are reverted, and the seeded regiment owner's mutable fields are
 * snapshotted and restored (a safety net: if the guard under test regressed, an
 * action against the owner would otherwise land on a shared row).
 */
const fakeDiscord = {
  buildAuthorizeUrl: (state: string) => `https://discord.com/oauth2/authorize?state=${state}`,
  exchangeCode: jest.fn(),
  fetchUser: jest.fn(),
  buildAvatarUrl: () => null,
};

const DISCORD_ID_ADMIN = '900900900900900811';
const DISCORD_ID_MODERATOR = '900900900900900812';
const DISCORD_ID_TARGET_ADMIN = '900900900900900813';
const DISCORD_ID_TARGET_MEMBER = '900900900900900814';
const ALL_DISCORD_IDS = [
  DISCORD_ID_ADMIN,
  DISCORD_ID_MODERATOR,
  DISCORD_ID_TARGET_ADMIN,
  DISCORD_ID_TARGET_MEMBER,
];

/** The grants this suite needs and the seeded default it restores them to. */
const FLIPPED_GRANTS: Array<{ role: MemberRole; capability: Capability }> = [
  { role: MemberRole.Admin, capability: Capability.ManageRoles },
  { role: MemberRole.Moderator, capability: Capability.ManageRoles },
  { role: MemberRole.Moderator, capability: Capability.EditRanksMedals },
];

describe('Member role hierarchy (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwt: JwtService;
  let regimentId: string;
  let rankId: string;
  let medalId: string;

  let adminToken: string;
  let moderatorToken: string;
  let ownerMemberId: string;
  let adminTargetId: string;
  let memberTargetId: string;

  /** Owner fields restored in afterAll — see the suite docblock. */
  let ownerSnapshot: Pick<Member, 'role' | 'rankId' | 'status' | 'bannedAt' | 'suspendedUntil'>;

  const createdMemberIds: string[] = [];
  const createdIdentityIds: string[] = [];

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();
  const future = () => new Date(Date.now() + 86_400_000).toISOString();

  /**
   * Each admin action as a single HTTP call reduced to its status code, so a
   * rule can be asserted against the WHOLE endpoint set rather than a sample.
   */
  const ACTIONS: Record<MemberAdminAction, (targetId: string, token: string) => Promise<number>> = {
    changeRole: async (id, token) =>
      (
        await request(server())
          .post(`/api/members/${id}/role`)
          .set(bearer(token))
          .send({ role: MemberRole.Mercenary })
      ).status,
    changeRank: async (id, token) =>
      (await request(server()).post(`/api/members/${id}/rank`).set(bearer(token)).send({ rankId }))
        .status,
    awardMedal: async (id, token) =>
      (
        await request(server())
          .post(`/api/members/${id}/medals`)
          .set(bearer(token))
          .send({ medalId })
      ).status,
    removeMedal: async (id, token) =>
      (await request(server()).delete(`/api/members/${id}/medals/${medalId}`).set(bearer(token)))
        .status,
    suspend: async (id, token) =>
      (
        await request(server())
          .post(`/api/members/${id}/suspend`)
          .set(bearer(token))
          .send({ until: future() })
      ).status,
    unsuspend: async (id, token) =>
      (await request(server()).post(`/api/members/${id}/unsuspend`).set(bearer(token))).status,
    ban: async (id, token) =>
      (await request(server()).post(`/api/members/${id}/ban`).set(bearer(token)).send({})).status,
    unban: async (id, token) =>
      (await request(server()).post(`/api/members/${id}/unban`).set(bearer(token))).status,
  };

  async function createMember(
    discordUserId: string,
    role: MemberRole,
  ): Promise<{ member: Member; token: string }> {
    const identity = await dataSource.getRepository(DiscordIdentity).save(
      dataSource.getRepository(DiscordIdentity).create({
        discordUserId,
        discordTag: `@hier_${discordUserId}`,
        discordUsername: `hier_${discordUserId}`,
        email: `hier_${discordUserId}@example.com`,
        accessToken: 'at',
        refreshToken: 'rt',
      }),
    );
    const member = await dataSource.getRepository(Member).save(
      dataSource.getRepository(Member).create({
        regimentId,
        rankId,
        discordIdentityId: identity.id,
        inGameName: `Hierarchy ${role} ${discordUserId.slice(-3)}`,
        role,
        status: MemberStatus.Active,
        discordLinked: true,
      }),
    );
    createdIdentityIds.push(identity.id);
    createdMemberIds.push(member.id);
    return { member, token: await jwt.signAsync({ sub: identity.id }) };
  }

  /** The `permittedActions` block the projection advertises for one target. */
  async function permittedActionsFor(
    targetId: string,
    token: string,
  ): Promise<Record<MemberAdminAction, boolean>> {
    const res = await request(server())
      .get(`/api/members/${targetId}`)
      .set(bearer(token))
      .expect(200);
    return res.body.permittedActions as Record<MemberAdminAction, boolean>;
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DiscordOAuthService)
      .useValue(fakeDiscord)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    dataSource = app.get(DataSource);
    jwt = app.get(JwtService);

    const regiment = await dataSource.getRepository(Regiment).findOne({ where: {} });
    regimentId = regiment!.id;
    rankId = (await dataSource.getRepository(Rank).findOne({ where: { regimentId } }))!.id;
    medalId = (await dataSource.getRepository(Medal).findOne({ where: { regimentId } }))!.id;

    // The regiment owner POINTER is the authoritative "untouchable" target.
    ownerMemberId = regiment!.ownerMemberId!;
    expect(ownerMemberId).toBeTruthy();
    const owner = await dataSource.getRepository(Member).findOne({ where: { id: ownerMemberId } });
    ownerSnapshot = {
      role: owner!.role,
      rankId: owner!.rankId,
      status: owner!.status,
      bannedAt: owner!.bannedAt,
      suspendedUntil: owner!.suspendedUntil,
    };

    await cleanup();

    // Widen the matrix so the CAPABILITY guard is out of the way and what the
    // tests observe is the hierarchy guard, not a missing grant. Reverted in
    // afterAll; the cache is dropped because the write bypasses the API.
    for (const grant of FLIPPED_GRANTS) {
      await dataSource.getRepository(RolePermission).update(grant, { granted: true });
    }
    app.get(AuthzService).invalidate();

    adminToken = (await createMember(DISCORD_ID_ADMIN, MemberRole.Admin)).token;
    moderatorToken = (await createMember(DISCORD_ID_MODERATOR, MemberRole.Moderator)).token;
    adminTargetId = (await createMember(DISCORD_ID_TARGET_ADMIN, MemberRole.Admin)).member.id;
    memberTargetId = (await createMember(DISCORD_ID_TARGET_MEMBER, MemberRole.Member)).member.id;
  });

  async function cleanup(): Promise<void> {
    const memberRepo = dataSource.getRepository(Member);
    const identityRepo = dataSource.getRepository(DiscordIdentity);
    const medalRepo = dataSource.getRepository(MemberMedal);
    const auditRepo = dataSource.getRepository(AuditLogEntry);

    if (createdMemberIds.length > 0) {
      // Anything these actors awarded (to any member, including the owner) —
      // service-record rows cascade with the member itself.
      await medalRepo.delete({ awardedByMemberId: In(createdMemberIds) });
      await auditRepo.delete({ actorMemberId: In(createdMemberIds) });
      await auditRepo.delete({ targetMemberId: In(createdMemberIds) });
      await memberRepo.delete({ id: In(createdMemberIds) });
      createdMemberIds.length = 0;
    }
    if (createdIdentityIds.length > 0) {
      await identityRepo.delete({ id: In(createdIdentityIds) });
      createdIdentityIds.length = 0;
    }
    // Belt-and-suspenders for a crashed prior run.
    for (const discordUserId of ALL_DISCORD_IDS) {
      const identity = await identityRepo.findOne({ where: { discordUserId } });
      if (!identity) continue;
      const members = await memberRepo.find({
        where: { discordIdentityId: identity.id },
        withDeleted: true,
      });
      for (const m of members) {
        await medalRepo.delete({ awardedByMemberId: m.id });
        await auditRepo.delete({ actorMemberId: m.id });
        await auditRepo.delete({ targetMemberId: m.id });
        await memberRepo.delete({ id: m.id });
      }
      await identityRepo.delete({ id: identity.id });
    }
  }

  afterAll(async () => {
    await cleanup();
    if (ownerMemberId) {
      await dataSource.getRepository(Member).update({ id: ownerMemberId }, ownerSnapshot);
    }
    for (const grant of FLIPPED_GRANTS) {
      await dataSource.getRepository(RolePermission).update(grant, { granted: false });
    }
    app.get(AuthzService).invalidate();
    await app.close();
  });

  // ── T-0176: the guard ────────────────────────────────────────────────────────

  describe('the hierarchy guard (T-0176)', () => {
    it.each(MEMBER_ADMIN_ACTIONS)(
      'an Admin holding the capability still cannot %s the regiment owner',
      async (action) => {
        expect(await ACTIONS[action](ownerMemberId, adminToken)).toBe(403);
      },
    );

    it.each(MEMBER_ADMIN_ACTIONS)('a Moderator cannot %s an Admin', async (action) => {
      expect(await ACTIONS[action](adminTargetId, moderatorToken)).toBe(403);
    });

    it('the refused actions left the regiment owner untouched', async () => {
      const owner = await dataSource
        .getRepository(Member)
        .findOne({ where: { id: ownerMemberId } });
      expect(owner!.role).toBe(ownerSnapshot.role);
      expect(owner!.bannedAt).toEqual(ownerSnapshot.bannedAt);
      expect(owner!.suspendedUntil).toEqual(ownerSnapshot.suspendedUntil);
      expect(owner!.rankId).toBe(ownerSnapshot.rankId);
    });

    it('a Moderator may moderate a Member', async () => {
      expect(await ACTIONS.suspend(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.unsuspend(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.ban(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.unban(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.changeRank(memberTargetId, moderatorToken)).toBe(201);
    });
  });

  // ── T-0177: the flags agree with the guard ───────────────────────────────────

  describe('permittedActions (T-0177)', () => {
    it('reports every action false for a target the caller may not touch', async () => {
      const onOwner = await permittedActionsFor(ownerMemberId, adminToken);
      const onPeerAdmin = await permittedActionsFor(adminTargetId, adminToken);

      for (const action of MEMBER_ADMIN_ACTIONS) {
        expect(`owner.${action}: ${onOwner[action]}`).toBe(`owner.${action}: false`);
        expect(`peer.${action}: ${onPeerAdmin[action]}`).toBe(`peer.${action}: false`);
      }
    });

    it('never advertises an action the endpoint then refuses (and vice versa)', async () => {
      // Walked target by target: the flags are read first, then every action is
      // actually invoked, so a flag and a 403 can never disagree.
      for (const [label, targetId, token] of [
        ['owner', ownerMemberId, adminToken],
        ['admin-target', adminTargetId, moderatorToken],
        ['member-target', memberTargetId, moderatorToken],
      ] as const) {
        const flags = await permittedActionsFor(targetId, token);
        for (const action of MEMBER_ADMIN_ACTIONS) {
          const status = await ACTIONS[action](targetId, token);
          // A permitted flag may still meet a 404/409 from the action's own
          // state; what it may never meet is an authorization refusal.
          const refused = status === 403;
          expect(`${label}.${action}: permitted=${flags[action]}`).toBe(
            `${label}.${action}: permitted=${!refused}`,
          );
        }
      }
    });

    it('is present on the list projection too, not only the detail one', async () => {
      type Row = { id: string; permittedActions: Record<MemberAdminAction, boolean> };
      const rows = async (query: Record<string, string | number>): Promise<Row[]> => {
        const res = await request(server())
          .get('/api/members')
          .query(query)
          .set(bearer(moderatorToken))
          .expect(200);
        return res.body.data as Row[];
      };

      // Filtered rather than paged through: the seeded roster's size is not
      // this suite's business.
      const owner = (await rows({ role: ownerSnapshot.role, limit: 100 })).find(
        (row) => row.id === ownerMemberId,
      );
      const memberRow = (await rows({ search: 'Hierarchy', limit: 100 })).find(
        (row) => row.id === memberTargetId,
      );

      expect(owner!.permittedActions.ban).toBe(false);
      expect(memberRow!.permittedActions.ban).toBe(true);
    });
  });

  // ── Account deletion stays self-only (owner decision, restated for T-0176) ───

  describe('account deletion is self-only', () => {
    it('offers no route by which one member can delete another — not even to the Owner', async () => {
      // The GDPR endpoints are the ONLY deletion surface and they are all `me`.
      // A target-shaped variant of each must not exist (404/405, never 200/403,
      // which would mean a handler was matched).
      for (const path of [
        `/api/members/${memberTargetId}/deletion-request`,
        `/api/members/${memberTargetId}/deletion-request/execute`,
      ]) {
        const res = await request(server()).post(path).set(bearer(adminToken)).send({});
        expect([404, 405]).toContain(res.status);
      }

      // And the `me` route deletes the CALLER, so an admin firing it at another
      // member is impossible by construction — the member is still there.
      const still = await dataSource
        .getRepository(Member)
        .findOne({ where: { id: memberTargetId } });
      expect(still).toBeTruthy();
    });
  });
});
