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
import { ServiceRecordEntry } from '../src/members/entities/service-record-entry.entity';
import {
  DECORATION_ACTIONS,
  MEMBER_ADMIN_ACTIONS,
  MODERATION_ACTIONS,
  MemberAdminAction,
} from '../src/members/member-hierarchy';
import { Rank } from '../src/ranks/entities/rank.entity';
import { Regiment } from '../src/regiments/entities/regiment.entity';

/**
 * E2E for T-0176/T-0177/T-0211: the member admin actions honour a role
 * hierarchy, and the `permittedActions` flags on the member projection say
 * exactly what the endpoints do.
 *
 * TWO rules, not one (T-0211). The MODERATION actions — role, suspend,
 * unsuspend, ban, unban — keep the full hierarchy: not yourself, not the
 * regiment owner, and only against a strictly lower role. The DECORATION
 * actions — rank, medal award/remove, derive — have no target rule at all, so an
 * `edit_ranks_medals` holder may decorate a peer, a superior, the owner and
 * their own record. Nearly every case below is therefore run per family.
 *
 * Sessions are minted directly from a saved identity (the pattern from
 * account-deletion.e2e-spec) rather than through the OAuth flow, because the
 * whole point is to exercise callers at ARBITRARY roles — something the sign-in
 * flow cannot produce.
 *
 * The e2e database persists between runs and is shared, so every row this suite
 * creates is torn down in both beforeAll and afterAll, the three capability
 * grants it flips are reverted, and the seeded regiment owner's mutable fields
 * are snapshotted and restored.
 *
 * ⚠️ That owner snapshot used to be a safety net for a regressed guard. Since
 * T-0211 it is REQUIRED: the decoration cases below really do write the shared
 * owner row — a rank change lands, and `removeMedal` can take away an award this
 * suite never created — so `ownerSnapshot` and `ownerMedalSnapshot` are the only
 * thing putting the seeded owner back as it found them.
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
/** A peer for the Moderator actor — the "can decorate its own kind" case (T-0211). */
const DISCORD_ID_TARGET_MODERATOR = '900900900900900819';
/** Promotion targets (T-0203) — one per case, never a fixture another test reads. */
const DISCORD_ID_GRANT_ADMIN = '900900900900900815';
const DISCORD_ID_GRANT_MODERATOR = '900900900900900816';
const DISCORD_ID_GRANT_REFUSED = '900900900900900817';
const DISCORD_ID_GRANT_ONE_WAY = '900900900900900818';
const ALL_DISCORD_IDS = [
  DISCORD_ID_ADMIN,
  DISCORD_ID_MODERATOR,
  DISCORD_ID_TARGET_ADMIN,
  DISCORD_ID_TARGET_MODERATOR,
  DISCORD_ID_TARGET_MEMBER,
  DISCORD_ID_GRANT_ADMIN,
  DISCORD_ID_GRANT_MODERATOR,
  DISCORD_ID_GRANT_REFUSED,
  DISCORD_ID_GRANT_ONE_WAY,
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
  let adminMemberId: string;
  let moderatorToken: string;
  let moderatorMemberId: string;
  let ownerMemberId: string;
  let adminTargetId: string;
  let moderatorTargetId: string;
  let memberTargetId: string;

  /** Owner fields restored in afterAll — see the suite docblock. */
  let ownerSnapshot: Pick<Member, 'role' | 'rankId' | 'status' | 'bannedAt' | 'suspendedUntil'>;
  /**
   * The owner's medal awards as this suite found them. `removeMedal` against the
   * owner is now a PERMITTED action, so it can delete a row seeded long before
   * this run; anything missing at the end is put back (T-0211).
   */
  let ownerMedalSnapshot: MemberMedal[];
  /** The owner's service-record entry ids as found; anything newer is this run's. */
  let ownerServiceRecordIds: string[];

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
    deriveFromDiscord: async (id, token) =>
      (await request(server()).post(`/api/members/${id}/derive-from-discord`).set(bearer(token)))
        .status,
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

    // ⚠️ Snapshotted AFTER cleanup(), not before. A crashed prior run can leave
    // awards pinned on the owner by actors this run is about to delete; captured
    // beforehand, the restore below would re-insert one whose awardedByMemberId
    // no longer exists, throw on the FK, and take the grant revert down with it —
    // leaving the shared e2e regiment with a widened permission matrix.
    ownerMedalSnapshot = await dataSource
      .getRepository(MemberMedal)
      .find({ where: { memberId: ownerMemberId } });
    // Same window, same reason: a permitted changeRank against the owner appends
    // to their service record, and the owner row itself is never deleted, so
    // nothing else would sweep those entries out of the shared database.
    ownerServiceRecordIds = (
      await dataSource
        .getRepository(ServiceRecordEntry)
        .find({ where: { memberId: ownerMemberId }, select: ['id'] })
    ).map((entry) => entry.id);

    // Widen the matrix so the CAPABILITY guard is out of the way and what the
    // tests observe is the hierarchy guard, not a missing grant. Reverted in
    // afterAll; the cache is dropped because the write bypasses the API.
    for (const grant of FLIPPED_GRANTS) {
      await dataSource.getRepository(RolePermission).update(grant, { granted: true });
    }
    app.get(AuthzService).invalidate();

    const admin = await createMember(DISCORD_ID_ADMIN, MemberRole.Admin);
    adminToken = admin.token;
    adminMemberId = admin.member.id;
    const moderator = await createMember(DISCORD_ID_MODERATOR, MemberRole.Moderator);
    moderatorToken = moderator.token;
    moderatorMemberId = moderator.member.id;
    adminTargetId = (await createMember(DISCORD_ID_TARGET_ADMIN, MemberRole.Admin)).member.id;
    moderatorTargetId = (await createMember(DISCORD_ID_TARGET_MODERATOR, MemberRole.Moderator))
      .member.id;
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
      // Wrapped, because everything after it — the FLIPPED_GRANTS revert — must
      // run even if a restore fails. A suite that leaves the shared permission
      // matrix widened breaks every suite that follows it.
      try {
        // Awards this suite pinned on the owner are swept by `cleanup()` (it
        // deletes everything the created actors awarded). This puts back anything
        // a permitted `removeMedal` took OFF the owner — a row that predates the
        // run and that nothing else would restore.
        const medalRepo = dataSource.getRepository(MemberMedal);
        for (const award of ownerMedalSnapshot ?? []) {
          if (!(await medalRepo.findOne({ where: { id: award.id } }))) await medalRepo.save(award);
        }
        // ...and drop the service-record entries a permitted rank change appended
        // to the owner. They cannot cascade: the owner row is not deleted.
        if (ownerServiceRecordIds) {
          const entries = dataSource.getRepository(ServiceRecordEntry);
          const written = await entries.find({ where: { memberId: ownerMemberId } });
          const added = written.filter((e) => !ownerServiceRecordIds.includes(e.id));
          if (added.length > 0) await entries.delete({ id: In(added.map((e) => e.id)) });
        }
      } catch (error) {
        console.error('member-hierarchy e2e: owner restore failed', error);
      }
    }
    for (const grant of FLIPPED_GRANTS) {
      await dataSource.getRepository(RolePermission).update(grant, { granted: false });
    }
    app.get(AuthzService).invalidate();
    await app.close();
  });

  // ── T-0176: the guard ────────────────────────────────────────────────────────

  describe('the moderation guard (T-0176)', () => {
    it.each(MODERATION_ACTIONS)(
      'an Admin holding the capability still cannot %s the regiment owner',
      async (action) => {
        expect(await ACTIONS[action](ownerMemberId, adminToken)).toBe(403);
      },
    );

    it.each(MODERATION_ACTIONS)('a Moderator cannot %s an Admin', async (action) => {
      expect(await ACTIONS[action](adminTargetId, moderatorToken)).toBe(403);
    });

    it('the refused actions left the regiment owner untouched', async () => {
      const owner = await dataSource
        .getRepository(Member)
        .findOne({ where: { id: ownerMemberId } });
      expect(owner!.role).toBe(ownerSnapshot.role);
      expect(owner!.bannedAt).toEqual(ownerSnapshot.bannedAt);
      expect(owner!.suspendedUntil).toEqual(ownerSnapshot.suspendedUntil);
      // ⚠️ NOT rankId. The owner's rank is a decoration and the block below
      // legitimately writes it; only the seat is untouchable (T-0211).
    });

    it('a Moderator may moderate a Member', async () => {
      expect(await ACTIONS.suspend(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.unsuspend(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.ban(memberTargetId, moderatorToken)).toBe(201);
      expect(await ACTIONS.unban(memberTargetId, moderatorToken)).toBe(201);
    });
  });

  // ── T-0211: the decoration half answers to the capability alone ──────────────

  describe('the decoration exemption (T-0211)', () => {
    /**
     * A rank/medal write that the authorization layer allowed through. It is the
     * 403 that is under test, so anything the action's own state produces — a 404
     * for a medal the target does not hold, a 409 from a derive with no bot — is
     * a pass. `FLIPPED_GRANTS` has already given the Moderator edit_ranks_medals.
     */
    const expectNotRefused = async (
      action: MemberAdminAction,
      targetId: string,
      token: string,
      label: string,
    ): Promise<void> => {
      const status = await ACTIONS[action](targetId, token);
      expect(`${label}.${action}: forbidden=${status === 403} (${status})`).toBe(
        `${label}.${action}: forbidden=false (${status})`,
      );
    };

    it.each(DECORATION_ACTIONS)('a Moderator may %s an Admin', async (action) => {
      await expectNotRefused(action, adminTargetId, moderatorToken, 'admin-target');
    });

    it.each(DECORATION_ACTIONS)('a Moderator may %s a peer Moderator', async (action) => {
      await expectNotRefused(action, moderatorTargetId, moderatorToken, 'moderator-target');
    });

    it.each(DECORATION_ACTIONS)('a Moderator may %s the regiment owner', async (action) => {
      await expectNotRefused(action, ownerMemberId, moderatorToken, 'owner');
    });

    // ⚠️ AND THEIR OWN RECORD, deliberately (T-0211). This is the self-promotion
    // path: an edit_ranks_medals holder may set their own rank, pin their own
    // medal, and derive their own record — which credits whatever their own
    // Discord roles say they have earned, a trigger that lives in the guild
    // rather than in this application. Asserted so it reads as a decision
    // somebody took, not a guard somebody dropped.
    it.each(DECORATION_ACTIONS)('and may %s their OWN record', async (action) => {
      await expectNotRefused(action, adminMemberId, adminToken, 'self-admin');
      await expectNotRefused(action, moderatorMemberId, moderatorToken, 'self-moderator');
    });

    it.each(MODERATION_ACTIONS)('but still may not %s their own record', async (action) => {
      expect(await ACTIONS[action](adminMemberId, adminToken)).toBe(403);
      expect(await ACTIONS[action](moderatorMemberId, moderatorToken)).toBe(403);
    });

    it('the rank really landed on the owner — permitted means written, not merely un-403ed', async () => {
      expect(await ACTIONS.changeRank(ownerMemberId, moderatorToken)).toBe(201);

      const owner = await dataSource
        .getRepository(Member)
        .findOne({ where: { id: ownerMemberId } });
      expect(owner!.rankId).toBe(rankId);
      // Restored wholesale in afterAll — see the suite docblock.
    });
  });

  // ── T-0177: the flags agree with the guard ───────────────────────────────────

  describe('permittedActions (T-0177)', () => {
    it('splits the block per family on a target the caller may not moderate', async () => {
      const onOwner = await permittedActionsFor(ownerMemberId, adminToken);
      const onPeerAdmin = await permittedActionsFor(adminTargetId, adminToken);

      for (const action of MODERATION_ACTIONS) {
        expect(`owner.${action}: ${onOwner[action]}`).toBe(`owner.${action}: false`);
        expect(`peer.${action}: ${onPeerAdmin[action]}`).toBe(`peer.${action}: false`);
      }
      // The Admin holds edit_ranks_medals by default, so the decoration half of
      // the very same block is true — the mixed shape the client had never seen
      // before T-0211.
      for (const action of DECORATION_ACTIONS) {
        expect(`owner.${action}: ${onOwner[action]}`).toBe(`owner.${action}: true`);
        expect(`peer.${action}: ${onPeerAdmin[action]}`).toBe(`peer.${action}: true`);
      }
    });

    it('splits the block on the caller’s own record too', async () => {
      const onSelf = await permittedActionsFor(adminMemberId, adminToken);

      // Your own row is no longer all-false: the rank and medal controls are
      // offered there (T-0211) while suspend/ban/role stay withheld.
      for (const action of MODERATION_ACTIONS) {
        expect(`self.${action}: ${onSelf[action]}`).toBe(`self.${action}: false`);
      }
      for (const action of DECORATION_ACTIONS) {
        expect(`self.${action}: ${onSelf[action]}`).toBe(`self.${action}: true`);
      }
    });

    it('never advertises an action the endpoint then refuses (and vice versa)', async () => {
      // Walked target by target: the flags are read first, then every action is
      // actually invoked, so a flag and a 403 can never disagree.
      for (const [label, targetId, token] of [
        ['owner', ownerMemberId, adminToken],
        ['admin-target', adminTargetId, moderatorToken],
        ['moderator-peer', moderatorTargetId, moderatorToken],
        ['member-target', memberTargetId, moderatorToken],
        ['self', adminMemberId, adminToken],
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
      // The list row is where the two tiers visibly diverge on ONE record: the
      // Moderator cannot ban the owner and can still record their promotion.
      expect(owner!.permittedActions.changeRank).toBe(true);
    });
  });

  // ── T-0203: manage_roles appoints its own tier ───────────────────────────────

  describe('the grant ceiling (T-0203)', () => {
    /**
     * A fresh Member target per case. The suite's shared fixtures are read by the
     * tests above and below; a promotion must not mutate one out from under them.
     */
    const target = async (discordUserId: string): Promise<string> =>
      (await createMember(discordUserId, MemberRole.Member)).member.id;

    const grantRole = (targetId: string, token: string, role: MemberRole) =>
      request(server()).post(`/api/members/${targetId}/role`).set(bearer(token)).send({ role });

    it('an Admin holding manage_roles may appoint another Admin', async () => {
      const targetId = await target(DISCORD_ID_GRANT_ADMIN);

      const res = await grantRole(targetId, adminToken, MemberRole.Admin);

      expect(res.status).toBe(201);
      expect(res.body.role).toBe(MemberRole.Admin);
      const stored = await dataSource.getRepository(Member).findOne({ where: { id: targetId } });
      expect(stored!.role).toBe(MemberRole.Admin);
    });

    it('a Moderator holding manage_roles may appoint another Moderator', async () => {
      const targetId = await target(DISCORD_ID_GRANT_MODERATOR);

      const res = await grantRole(targetId, moderatorToken, MemberRole.Moderator);

      expect(res.status).toBe(201);
      expect(res.body.role).toBe(MemberRole.Moderator);
    });

    it('but never a tier above their own, and never Owner', async () => {
      const targetId = await target(DISCORD_ID_GRANT_REFUSED);

      expect((await grantRole(targetId, moderatorToken, MemberRole.Admin)).status).toBe(403);
      expect((await grantRole(targetId, adminToken, MemberRole.Owner)).status).toBe(403);
      expect((await grantRole(targetId, moderatorToken, MemberRole.Owner)).status).toBe(403);

      const stored = await dataSource.getRepository(Member).findOne({ where: { id: targetId } });
      expect(stored!.role).toBe(MemberRole.Member);
    });

    it('the appointment is one-way: the new peer is beyond the appointer’s reach', async () => {
      // Appointing a peer is additive; moderating one is not. The Admin who just
      // made this member an Admin can no longer demote, suspend or ban them —
      // only the Owner can — so a seat holder widens the command, never hollows
      // it out. The `permittedActions` flags say so too, so the UI folds those
      // controls away rather than offering a button that 403s.
      const promotedId = await target(DISCORD_ID_GRANT_ONE_WAY);
      expect((await grantRole(promotedId, adminToken, MemberRole.Admin)).status).toBe(201);

      expect((await grantRole(promotedId, adminToken, MemberRole.Member)).status).toBe(403);
      const flags = await permittedActionsFor(promotedId, adminToken);
      for (const action of MODERATION_ACTIONS) {
        expect(`promoted.${action}: ${flags[action]}`).toBe(`promoted.${action}: false`);
      }
      // Out of MODERATION reach, not out of reach: the appointer keeps the
      // regiment's service record for the peer they just made (T-0211).
      for (const action of DECORATION_ACTIONS) {
        expect(`promoted.${action}: ${flags[action]}`).toBe(`promoted.${action}: true`);
      }
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
