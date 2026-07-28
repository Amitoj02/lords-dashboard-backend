import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { Application } from '../src/applications/entities/application.entity';
import {
  DiscordSyncJobStatus,
  DiscordSyncJobType,
  EventStatus,
  RsvpStatus,
} from '../src/common/enums';
import { DiscordSyncWorker } from '../src/discord/discord-sync.worker';
import { rsvpCustomId } from '../src/discord/embeds/event-components';
import { DiscordGateway } from '../src/discord/gateway/discord-gateway';
import { MockDiscordGateway } from '../src/discord/gateway/mock-discord-gateway';
import { BotOperation } from '../src/discord/entities/bot-operation.entity';
import { DiscordBotSettings } from '../src/discord/entities/discord-bot-settings.entity';
import { DiscordConnection } from '../src/discord/entities/discord-connection.entity';
import { DiscordSyncJob } from '../src/discord/entities/discord-sync-job.entity';
import { EventAnnouncement } from '../src/events/entities/event-announcement.entity';
import { EventRsvp } from '../src/events/entities/event-rsvp.entity';
import { RegimentEvent } from '../src/events/entities/event.entity';
import { EventReminderScheduler } from '../src/events/event-reminder.scheduler';
import { EventStatusScheduler } from '../src/events/event-status.scheduler';
import { Medal } from '../src/medals/entities/medal.entity';
import { MemberMedal } from '../src/medals/entities/member-medal.entity';
import { Member } from '../src/members/entities/member.entity';
import { Rank } from '../src/ranks/entities/rank.entity';

/**
 * End-to-end coverage of the Discord bot (MOCK gateway) against real MySQL:
 * the outbox pipeline (enqueue → drain → bot_operation), the SENSITIVE ban →
 * strip-roles + apply-Ban-role gate (off by default, fires only when
 * applyBanRoleOnBan is enabled AND a Ban role is set), rank-change role sync,
 * announcements, and join onboarding (welcome + Guest role). The bot runs mocked
 * (no DISCORD_BOT_TOKEN), so nothing touches a real Discord guild.
 */
const APPLICANT_DISCORD_ID = '900900900900900903';
// Matches the seeded dev regiment id (src/database/seeds/seed.util.ts REGIMENT_ID).
const REGIMENT_ID = 'Rgmt00000001';

let currentProfile: Record<string, unknown> = {};

const fakeDiscord = {
  buildAuthorizeUrl: (state: string) =>
    `https://discord.com/oauth2/authorize?client_id=test&state=${state}`,
  exchangeCode: jest.fn().mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt',
    token_type: 'Bearer',
    expires_in: 604800,
    scope: 'identify email',
  }),
  fetchUser: jest.fn().mockImplementation(() => Promise.resolve(currentProfile)),
  buildAvatarUrl: () => null,
};

describe('Discord bot pipeline (e2e, mock gateway)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let worker: DiscordSyncWorker;
  let mockGateway: MockDiscordGateway;

  let ownerToken: string;
  let memberId: string;

  const ownerProfile = {
    id: '100000000000000001',
    username: 'lord_commander',
    global_name: 'Lord Commander',
    discriminator: '0',
    avatar: null,
    email: 'owner@example.com',
  };
  const applicantProfile = {
    id: APPLICANT_DISCORD_ID,
    username: 'e2e_discord_applicant',
    global_name: 'Discord Applicant',
    discriminator: '0',
    avatar: null,
    email: 'discord@example.com',
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DiscordOAuthService)
      .useValue(fakeDiscord)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    dataSource = app.get(DataSource);
    worker = app.get(DiscordSyncWorker);
    // The bot runs mocked, so the gateway IS the MockDiscordGateway and its
    // recorded sent-message buffer is how message/embed shape is asserted.
    mockGateway = app.get(DiscordGateway);
    await cleanup();

    // Enrol a test member (with a linked Discord identity) via the apply→approve loop.
    ownerToken = (await signIn(ownerProfile)).token;
    const applicant = await signIn(applicantProfile);
    const created = await request(server())
      .post('/api/applications')
      .set(bearer(applicant.token))
      .send({
        applicantName: 'Discord Applicant',
        inGameName: 'DiscordApp',
        currentRegiment: 'None',
        howFound: 'Discord invite',
        preferredClasses: 'Line Infantry',
        skillsToImprove: 'Melee',
        interestConfirmed: true,
      })
      .expect(201);
    ownerToken = (await signIn(ownerProfile)).token;
    const approved = await request(server())
      .post(`/api/applications/${created.body.id}/approve`)
      .set(bearer(ownerToken))
      .expect(200);
    memberId = approved.body.promotedMemberId as string;
  });

  afterAll(async () => {
    await cleanup();
    // Reset the bot to its dormant defaults. The e2e suites share one MySQL
    // database and this single-tenant settings row, so anything these cases
    // write has to be put back — including the welcome copy and channel names
    // the T-0184/T-0185 cases edit.
    await dataSource.getRepository(DiscordBotSettings).update(
      { regimentId: REGIMENT_ID },
      {
        botEnabled: false,
        applyBanRoleOnBan: false,
        banRoleId: null,
        banRoleName: null,
        membershipRoleId: null,
        gallerySubmissionChannelId: null,
        galleryApprovedChannelId: null,
        welcomeChannelId: null,
        welcomeMessage: null,
        enlistmentChannelId: null,
        enlistmentChannelName: null,
        auditLogChannelName: null,
      },
    );
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
    const conn = await dataSource
      .getRepository(DiscordConnection)
      .findOne({ where: { regimentId: REGIMENT_ID } });
    if (conn) {
      await dataSource.getRepository(BotOperation).delete({ discordConnectionId: conn.id });
    }
    const identity = await dataSource
      .getRepository(DiscordIdentity)
      .findOne({ where: { discordUserId: APPLICANT_DISCORD_ID } });
    if (identity) {
      await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
      await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
      await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
    }
  }

  async function signIn(profile: Record<string, unknown>): Promise<{ token: string }> {
    currentProfile = profile;
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/api/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`).expect(302);
    // Token is in the URL fragment now (LDA-H4), not the query string.
    const token = new URLSearchParams(new URL(cb.headers.location).hash.replace(/^#/, '')).get(
      'token',
    ) as string;
    return { token };
  }

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const server = () => app.getHttpServer();
  const jobsOfType = (type: DiscordSyncJobType) =>
    dataSource
      .getRepository(DiscordSyncJob)
      .find({ where: { regimentId: REGIMENT_ID, jobType: type } });

  /** Drain repeatedly so a concurrently-firing background tick can't leave a job unprocessed. */
  async function drainAll(): Promise<void> {
    for (let i = 0; i < 5; i++) await worker.drain();
  }

  it('enables the bot and verifies the connection (wizard step)', async () => {
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ botEnabled: true, membershipRoleId: '900000000000000001' })
      .expect(200);

    const verify = await request(server())
      .post('/api/discord/verify-connection')
      .set(bearer(ownerToken))
      .expect(200);
    expect(verify.body.connected).toBe(true);
  });

  it('exposes STAFF bot status + live metrics, omitting sensitive fields (T-0076/T-0077)', async () => {
    const res = await request(server())
      .get('/api/discord/status')
      .set(bearer(ownerToken))
      .expect(200);
    // Live metrics present (mock gateway canned values).
    expect(res.body.connected).toBe(true);
    expect(typeof res.body.wsPing).toBe('number');
    expect(typeof res.body.uptimeMs).toBe('number');
    expect(typeof res.body.memoryBytes).toBe('number');
    expect(typeof res.body.cpu).toBe('number');
    expect(res.body.readyAt).toEqual(expect.any(String));
    // Sensitive authority/config fields are omitted from the STAFF widget.
    expect(res.body).not.toHaveProperty('botRolePosition');
    expect(res.body).not.toHaveProperty('requiredPermissions');
    expect(res.body).not.toHaveProperty('applyBanRoleOnBan');
  });

  it('does NOT enqueue a ban-role job on ban while applyBanRoleOnBan is off (the default)', async () => {
    await request(server())
      .post(`/api/members/${memberId}/ban`)
      .set(bearer(ownerToken))
      .expect(201);
    expect(await jobsOfType(DiscordSyncJobType.MemberBanRole)).toHaveLength(0);
    await request(server())
      .post(`/api/members/${memberId}/unban`)
      .set(bearer(ownerToken))
      .expect(201);
  });

  it('rejects enabling applyBanRoleOnBan without a Ban role set', async () => {
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ applyBanRoleOnBan: true })
      .expect(400);
  });

  it('enqueues + drains a ban-role job once applyBanRoleOnBan + a Ban role are set', async () => {
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ applyBanRoleOnBan: true, banRoleId: '900000000000000006', banRoleName: 'Banned' })
      .expect(200);

    await request(server())
      .post(`/api/members/${memberId}/ban`)
      .set(bearer(ownerToken))
      .expect(201);
    const jobs = await jobsOfType(DiscordSyncJobType.MemberBanRole);
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    await drainAll();
    const drained = await jobsOfType(DiscordSyncJobType.MemberBanRole);
    expect(drained.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);

    const ops = await request(server())
      .get('/api/discord/operations')
      .set(bearer(ownerToken))
      .expect(200);
    expect(
      ops.body.data.some((o: { operation: string }) => o.operation === 'member.ban_role'),
    ).toBe(true);

    await request(server())
      .post(`/api/members/${memberId}/unban`)
      .set(bearer(ownerToken))
      .expect(201);
  });

  it('suspends then unsuspends a member; a repeat unsuspend conflicts (T-0118)', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await request(server())
      .post(`/api/members/${memberId}/suspend`)
      .set(bearer(ownerToken))
      .send({ until, reason: 'e2e cooldown' })
      .expect(201);

    const lifted = await request(server())
      .post(`/api/members/${memberId}/unsuspend`)
      .set(bearer(ownerToken))
      .expect(201);
    expect(lifted.body.suspendedUntil).toBeNull();

    // No longer suspended → a second unsuspend is a 409 Conflict (mirrors unban).
    await request(server())
      .post(`/api/members/${memberId}/unsuspend`)
      .set(bearer(ownerToken))
      .expect(409);
  });

  /**
   * T-0209 — THE REPORTED BUG, END TO END.
   *
   * A member of a regiment that lived on Discord before it had a dashboard: they
   * wear their rank role, a medal role the roster has no award row for, and a
   * role nobody ever linked to anything. Promote them, and before this fix the
   * whole-member reconcile took the medal role off — because the roster could
   * not account for it — even though a rank change cannot legitimately touch a
   * medal. The scoped sync moves the two rank roles and leaves the rest alone.
   */
  it('a rank change swaps ONLY the rank roles and leaves everything else on', async () => {
    const OLD_RANK_ROLE = '900000000000000071';
    const NEW_RANK_ROLE = '900000000000000072';
    const UNACCOUNTED_MEDAL_ROLE = '900000000000000073';
    const MANUAL_ROLE = '900000000000000074';

    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });

    const ranks = await request(server()).get('/api/ranks').set(bearer(ownerToken)).expect(200);
    const targetRank =
      ranks.body.find((r: { name: string }) => r.name === 'Captain') ?? ranks.body[0];
    const member = await dataSource
      .getRepository(Member)
      .findOneOrFail({ where: { id: memberId } });

    // Link both ends of the swap, plus a medal whose role the member wears but
    // holds no award for — the collateral the old reconcile destroyed.
    const currentRank = await dataSource
      .getRepository(Rank)
      .findOneOrFail({ where: { id: member.rankId } });
    await dataSource
      .getRepository(Rank)
      .update({ id: member.rankId }, { discordRoleId: OLD_RANK_ROLE });
    await dataSource
      .getRepository(Rank)
      .update({ id: targetRank.id as string }, { discordRoleId: NEW_RANK_ROLE });
    const medal = await dataSource.getRepository(Medal).findOneOrFail({ where: {} });
    await dataSource
      .getRepository(Medal)
      .update({ id: medal.id }, { discordRoleId: UNACCOUNTED_MEDAL_ROLE });
    // Restore the PRIOR values, not null — this catalogue is shared, and blanking
    // a link some other suite had set would be its own cross-test bug.
    const previousRankRole = currentRank.discordRoleId;
    const targetRankRole = (targetRank as { discordRoleId?: string | null }).discordRoleId ?? null;
    const medalRole = medal.discordRoleId;

    // Seed what the member actually wears — an unseeded member has NO roles in
    // the mock gateway, which would make every survival assertion vacuous.
    await mockGateway.assignRole(APPLICANT_DISCORD_ID, OLD_RANK_ROLE);
    await mockGateway.assignRole(APPLICANT_DISCORD_ID, UNACCOUNTED_MEDAL_ROLE);
    await mockGateway.assignRole(APPLICANT_DISCORD_ID, MANUAL_ROLE);

    // try/finally, not a trailing restore: these suites share one MySQL database,
    // and a failed assertion that left `Captain` linked to a snowflake would hand
    // the T-0204 block a role bound to two catalogue rows.
    try {
      await request(server())
        .post(`/api/members/${memberId}/rank`)
        .set(bearer(ownerToken))
        .send({ rankId: targetRank.id })
        .expect(201);

      // The blast radius is visible in the payload rather than implied by the
      // catalogue: exactly the two rank roles are in scope.
      const syncs = await jobsOfType(DiscordSyncJobType.RoleScopedSync);
      expect(syncs).toHaveLength(1);
      expect((syncs[0].payload as { roleIds: string[] }).roleIds.sort()).toEqual([
        OLD_RANK_ROLE,
        NEW_RANK_ROLE,
      ]);
      // The destructive whole-member reconcile is unreachable from a mutation.
      expect(await jobsOfType(DiscordSyncJobType.RoleFullResync)).toHaveLength(0);

      await drainAll();
      const drained = await jobsOfType(DiscordSyncJobType.RoleScopedSync);
      expect(drained.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);

      const ref = await mockGateway.fetchMember(APPLICANT_DISCORD_ID);
      expect(ref!.roles).toContain(NEW_RANK_ROLE);
      expect(ref!.roles).not.toContain(OLD_RANK_ROLE);
      // *** THE REGRESSION GUARD. *** Neither the unrecorded decoration nor the
      // unmanaged role may be collateral of a promotion.
      expect(ref!.roles).toContain(UNACCOUNTED_MEDAL_ROLE);
      expect(ref!.roles).toContain(MANUAL_ROLE);
    } finally {
      await dataSource
        .getRepository(Rank)
        .update({ id: member.rankId }, { discordRoleId: previousRankRole });
      await dataSource
        .getRepository(Rank)
        .update({ id: targetRank.id }, { discordRoleId: targetRankRole });
      await dataSource.getRepository(Medal).update({ id: medal.id }, { discordRoleId: medalRole });
    }
  });

  /**
   * T-0191/T-0193. A guild join used to assign the configured join role to
   * WHOEVER walked in, which is what made that role useless as the regiment's
   * permission anchor: a visitor who had never applied held exactly what an
   * enlisted member held. Roles now come from roster state, so the two halves
   * of that rule have to be asserted together — the stranger case is the one
   * that regresses silently if the old grant is ever reinstated.
   */
  it('welcomes a STRANGER who joins, and gives them no roles whatsoever', async () => {
    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });

    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: '555000000000000000' })
      .expect(200);

    expect((await jobsOfType(DiscordSyncJobType.Welcome)).length).toBeGreaterThanOrEqual(1);
    expect(await jobsOfType(DiscordSyncJobType.RoleAssign)).toHaveLength(0);
    expect(await jobsOfType(DiscordSyncJobType.RoleGrant)).toHaveLength(0);

    await drainAll();
    const welcomes = await jobsOfType(DiscordSyncJobType.Welcome);
    expect(welcomes.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);
  });

  it('restores a RETURNING member’s roles when they rejoin the guild', async () => {
    // Leaving a guild strips every role Discord holds for you and rejoining
    // gives none of them back, so a veteran reappeared with the rank the roster
    // still credited them with and nothing to show for it.
    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });

    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: APPLICANT_DISCORD_ID })
      .expect(200);

    const syncs = await jobsOfType(DiscordSyncJobType.RoleGrant);
    expect(syncs).toHaveLength(1);
    expect((syncs[0].payload as { memberId: string }).memberId).toBe(memberId);
  });

  describe('embed transport (T-0172 / T-0173 / T-0174 / T-0175)', () => {
    beforeEach(async () => {
      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
      mockGateway.resetSentMessages();
    });

    it('delivers an enlistment post as an EMBED, recorded by the mock gateway', async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true, enlistmentChannelId: '910000000000000002' })
        .expect(200);

      const applicant = await signIn({
        ...applicantProfile,
        id: '900900900900900904',
        email: 'embed@example.com',
      });
      await request(server())
        .post('/api/applications')
        .set(bearer(applicant.token))
        .send({
          applicantName: 'Embed Applicant',
          inGameName: 'EmbedApp',
          currentRegiment: 'None',
          howFound: 'Discord invite',
          preferredClasses: 'Line Infantry',
          skillsToImprove: 'Melee',
          interestConfirmed: true,
        })
        .expect(201);

      await drainAll();

      const post = mockGateway.sentMessages.find((m) => m.target === '910000000000000002');
      expect(post).toBeDefined();
      expect(post?.embeds).toHaveLength(1);
      expect(post?.embeds[0].title).toContain('New enlistment application');
      expect(post?.embeds[0].fields?.map((f) => f.name)).toContain('In-game name');
      // The message IS the embed — nothing is duplicated as markdown text.
      expect(post?.content).toBe('');

      const jobs = await jobsOfType(DiscordSyncJobType.ApplicationSubmitted);
      expect(jobs.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);
      // The embed survived the MySQL `json` round-trip as a real object.
      expect((jobs[0].payload as { embed: { title: string } }).embed.title).toContain('enlistment');

      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ enlistmentChannelId: null })
        .expect(200);
      await dataSource
        .getRepository(DiscordIdentity)
        .delete({ discordUserId: '900900900900900904' });
    });

    it('still delivers a LEGACY content-only job as plain text', async () => {
      // The hard backward-compatibility requirement: rows written by the previous
      // release carry only `content`. This inserts exactly such a row.
      await dataSource.getRepository(DiscordSyncJob).save(
        dataSource.getRepository(DiscordSyncJob).create({
          regimentId: REGIMENT_ID,
          jobType: DiscordSyncJobType.Announce,
          payload: { channelId: '910000000000000004', content: '📅 **Legacy announcement**' },
          scheduledAt: new Date(),
        }),
      );

      await drainAll();

      const post = mockGateway.sentMessages.find((m) => m.target === '910000000000000004');
      expect(post?.content).toBe('📅 **Legacy announcement**');
      expect(post?.embeds).toEqual([]);
      const jobs = await jobsOfType(DiscordSyncJobType.Announce);
      expect(jobs.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);
    });

    /**
     * The clamp cannot be reached through HTTP, and that is the finding worth
     * pinning: EVERY free-text DTO cap sits BELOW the Discord limit it feeds —
     * `skillsToImprove` is `@MaxLength(1000)` against a 1024-character field
     * value, an event description is 512 against 4096, and the whole enlistment
     * body sums to roughly 3 000 against the 6 000-character embed total. So no
     * request a client can send produces an over-limit embed; the compose-time
     * clamp is defence in depth for server-composed text, and its edges are
     * pinned by `src/discord/embeds/embed-limits.spec.ts`.
     *
     * What this case proves end to end is the property that actually protects
     * the outbox: the LARGEST answer the API will accept still composes to a
     * legal embed and the job SUCCEEDS rather than failing forever on a
     * Discord validation error.
     */
    it('composes a legal embed from the largest answer the API accepts (T-0172)', async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true, enlistmentChannelId: '910000000000000002' })
        .expect(200);

      const applicant = await signIn({
        ...applicantProfile,
        id: '900900900900900905',
        email: 'huge@example.com',
      });
      await request(server())
        .post('/api/applications')
        .set(bearer(applicant.token))
        .send({
          applicantName: 'Verbose Applicant',
          inGameName: 'VerboseApp',
          currentRegiment: 'None',
          howFound: 'Discord invite',
          preferredClasses: 'Line Infantry',
          // Exactly the DTO ceiling — one more character is a 400.
          skillsToImprove: 'M'.repeat(1000),
          interestConfirmed: true,
        })
        .expect(201);

      await drainAll();

      const post = mockGateway.sentMessages.find((m) => m.target === '910000000000000002');
      const improve = post?.embeds[0].fields?.find((f) => f.name === 'Wants to improve');
      expect(improve?.value).toHaveLength(1000);
      expect(improve?.value.length).toBeLessThanOrEqual(1024);
      const jobs = await jobsOfType(DiscordSyncJobType.ApplicationSubmitted);
      expect(jobs.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);

      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ enlistmentChannelId: null })
        .expect(200);
      await dataSource
        .getRepository(DiscordIdentity)
        .delete({ discordUserId: '900900900900900905' });
    });

    it('delivers the welcome as a branded embed and keeps the DM fallback', async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true, membershipRoleId: '900000000000000001' })
        .expect(200);

      await request(server())
        .post('/api/discord/simulate/member-join')
        .set(bearer(ownerToken))
        .send({ discordUserId: '555000000000000002' })
        .expect(200);
      await drainAll();

      // No welcome channel is configured, so it must still arrive as a DM.
      const dm = mockGateway.sentMessages.find((m) => m.target === '555000000000000002');
      expect(dm?.kind).toBe('dm');
      expect(dm?.embeds[0].title).toContain('Welcome to');
      // The configured message is the WHOLE message — nothing is appended to it.
      expect(dm?.embeds[0].fields ?? []).toEqual([]);
    });
  });

  /**
   * T-0183 — the standing guard. T-0154 fenced the staff-only columns out of the
   * applicant REST projection, but the Discord DM path went around that fence and
   * delivered the moderator note to the very person it was written about. So the
   * guard walks EVERY applicant-facing channel there is (the projection AND the
   * outbox) and asserts one distinctive sentinel appears in neither.
   *
   * It runs against the mock gateway with the bot ENABLED on purpose: the whole
   * decision-DM producer is wrapped in `guarded()`, which no-ops when the bot is
   * off — so the same assertions in a suite that never enables the bot would find
   * zero jobs and pass while the leak was live.
   */
  describe('staff-only fields never reach an applicant-facing channel (T-0183)', () => {
    // High-entropy so `not.toContain` can never be satisfied by accident, and
    // grep-verified absent from src/database/seeds.
    const STAFF_SENTINEL = 'zz-staffnote-sentinel-7f21a9';
    const REASON_SENTINEL = 'zz-declinereason-sentinel-3c84be';
    const USER_MESSAGE = 'Thank you for applying — do try again after fifty more hours.';
    const LEAK_APPLICANT_ID = '900900900900900906';

    let applicantToken: string;
    let applicationId: string;

    beforeAll(async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true })
        .expect(200);

      applicantToken = (
        await signIn({ ...applicantProfile, id: LEAK_APPLICANT_ID, email: 'leak@example.com' })
      ).token;
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(applicantToken))
        .send({
          applicantName: 'Leak Applicant',
          inGameName: 'LeakApp',
          currentRegiment: 'None',
          howFound: 'Discord invite',
          preferredClasses: 'Line Infantry',
          skillsToImprove: 'Melee',
          interestConfirmed: true,
        })
        .expect(201);
      applicationId = created.body.id as string;

      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
      mockGateway.resetSentMessages();

      // The decline that carries BOTH staff-only fields plus the applicant's text.
      await request(server())
        .post(`/api/applications/${applicationId}/decline`)
        .set(bearer(ownerToken))
        .send({
          reason: REASON_SENTINEL,
          note: STAFF_SENTINEL,
          discordDmMessage: USER_MESSAGE,
        })
        .expect(200);
      await drainAll();
    });

    afterAll(async () => {
      const identity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId: LEAK_APPLICANT_ID } });
      if (identity) {
        await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
      }
    });

    it('enqueues the decision DM at all — the guard below must not pass vacuously', async () => {
      const jobs = await jobsOfType(DiscordSyncJobType.ApplicationDecision);
      expect(jobs.length).toBeGreaterThan(0);
      expect(JSON.stringify(jobs[0].payload)).toContain(USER_MESSAGE);
    });

    it('keeps every staff-only field out of the enqueued decision payload', async () => {
      // The WHOLE payload is stringified rather than one named field: that is what
      // catches a future embed field wired to a staff-only source, which is the
      // failure mode this guard exists for.
      const jobs = await jobsOfType(DiscordSyncJobType.ApplicationDecision);
      const serialised = JSON.stringify(jobs.map((j) => j.payload));
      expect(serialised).not.toContain(STAFF_SENTINEL);
      expect(serialised).not.toContain(REASON_SENTINEL);
    });

    it('keeps every staff-only field out of the message the gateway actually sent', () => {
      const dm = mockGateway.sentMessages.find((m) => m.target === LEAK_APPLICANT_ID);
      expect(dm).toBeDefined();
      expect(dm?.kind).toBe('dm');
      expect(dm?.embeds[0].description).toBe(USER_MESSAGE);
      // Nowhere left to render a note: the decision embed has no fields at all.
      expect(dm?.embeds[0].fields).toBeUndefined();
      expect(JSON.stringify(dm)).not.toContain(STAFF_SENTINEL);
      expect(JSON.stringify(dm)).not.toContain(REASON_SENTINEL);
    });

    it('keeps every staff-only field out of GET /api/applications/mine', async () => {
      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(applicantToken))
        .expect(200);

      const serialised = JSON.stringify(mine.body);
      expect(serialised).not.toContain(STAFF_SENTINEL);
      expect(serialised).not.toContain(REASON_SENTINEL);
      // The applicant DOES still get told what the officer wrote for them.
      expect(mine.body.application.userMessage).toBe(USER_MESSAGE);
    });

    it('still records both staff-only fields for staff', async () => {
      // Closing the leak must not close the RECORD.
      const staffView = await request(server())
        .get(`/api/applications/${applicationId}`)
        .set(bearer(ownerToken))
        .expect(200);

      expect(staffView.body.moderatorNote).toBe(STAFF_SENTINEL);
      expect(staffView.body.declineReason).toBe(REASON_SENTINEL);
    });
  });

  /**
   * T-0184 / T-0185 — the welcome message an admin authors in Settings.
   * A blank box means "use the house default" rather than "greet with silence",
   * and the two documented tokens expand against the joining member.
   */
  describe('configurable welcome message (T-0184 / T-0185)', () => {
    const readSettings = async (): Promise<Record<string, unknown>> =>
      (await request(server()).get('/api/discord/settings').set(bearer(ownerToken)).expect(200))
        .body as Record<string, unknown>;

    const patchSettings = (body: Record<string, unknown>) =>
      request(server()).patch('/api/discord/settings').set(bearer(ownerToken)).send(body);

    beforeEach(async () => {
      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
      mockGateway.resetSentMessages();
      // welcomeChannelId back to null too: with a channel configured the greeting
      // is posted there instead of DM'd, and the DM is what these cases read.
      await patchSettings({
        botEnabled: true,
        welcomeMessage: null,
        welcomeChannelId: null,
      }).expect(200);
    });

    it('trims a saved message and stores a blank one as NULL', async () => {
      await patchSettings({ welcomeMessage: '  Fall in!  ' }).expect(200);
      expect((await readSettings()).welcomeMessage).toBe('Fall in!');

      await patchSettings({ welcomeMessage: '   ' }).expect(200);
      expect((await readSettings()).welcomeMessage).toBeNull();

      await patchSettings({ welcomeMessage: '' }).expect(200);
      expect((await readSettings()).welcomeMessage).toBeNull();
    });

    it('leaves every other optional setting untouched when only one field is PATCHed', async () => {
      // The blanking guard for the recorded T-0184 risk: a normaliser applied one
      // field too widely would blank a channel id or role name here. Comparing the
      // WHOLE projection covers every optional string at once, so this keeps
      // working as columns are added.
      await patchSettings({
        welcomeMessage: 'Fall in!',
        welcomeChannelId: '910000000000000009',
        enlistmentChannelName: 'new-enlistments',
        auditLogChannelName: 'audit-logs',
        banRoleName: 'Cashiered',
      }).expect(200);
      const before = await readSettings();

      await patchSettings({ botEnabled: true }).expect(200);
      const after = await readSettings();

      expect(after).toEqual(before);
    });

    it('greets with the house default when the message is blank', async () => {
      await patchSettings({ welcomeMessage: '' }).expect(200);

      await request(server())
        .post('/api/discord/simulate/member-join')
        .set(bearer(ownerToken))
        .send({ discordUserId: '555000000000000003' })
        .expect(200);
      await drainAll();

      const dm = mockGateway.sentMessages.find((m) => m.target === '555000000000000003');
      expect(dm?.embeds[0].description).toBe('Welcome to the regiment!');
    });

    it('expands {user} and {regiment}, and cannot ping through the embed', async () => {
      await patchSettings({
        welcomeMessage: 'Hello {user}, welcome to {regiment}! @everyone say hi. {nope}',
      }).expect(200);

      await request(server())
        .post('/api/discord/simulate/member-join')
        .set(bearer(ownerToken))
        .send({ discordUserId: '555000000000000004' })
        .expect(200);
      await drainAll();

      const dm = mockGateway.sentMessages.find((m) => m.target === '555000000000000004');
      // `Lords Regiment` is the seeded brand name (src/database/seeds/regiment.seed.ts).
      expect(dm?.embeds[0].description).toBe(
        'Hello <@555000000000000004>, welcome to Lords Regiment! @everyone say hi. {nope}',
      );
      // The greeting IS the embed. `@everyone` in an embed body notifies nobody;
      // it would only ping if the admin's text reached the message content.
      expect(dm?.content).toBe('');
    });

    it('rejects a message longer than the documented 512-character limit', async () => {
      await patchSettings({ welcomeMessage: 'x'.repeat(513) }).expect(400);
      await patchSettings({ welcomeMessage: 'x'.repeat(512) }).expect(200);
    });
  });

  /**
   * T-0192/T-0193/T-0194 — the enlistment lifecycle against REAL MySQL.
   *
   * This is the suite that would have caught the original bug. The unit tests
   * assert against a mocked DiscordSyncService; only a real round-trip proves a
   * job row is actually written, and the fixture member at the top of this file
   * is enrolled through the genuine apply -> approve loop.
   *
   * ⚠️ THE BOT MUST BE ON BEFORE THE ACTION. Every producer runs inside
   * `guarded()`, which no-ops when `botEnabled` is false — so these same
   * assertions in a block that forgot to enable it would find zero jobs and
   * pass while the feature was dead.
   */
  describe('enlistment writes Discord roles (T-0194)', () => {
    const APPLICANT_TWO = '900900900900900907';
    let applicantToken: string;
    let applicationId: string;

    const applicantProfileTwo = {
      id: APPLICANT_TWO,
      username: 'e2e_second_applicant',
      global_name: 'Second Applicant',
      discriminator: '0',
      avatar: null,
      email: 'second@example.com',
    };

    beforeAll(async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true })
        .expect(200);
      // Link the Applicant rank to a role, which is what makes the marker
      // resolvable at all — an unlinked rank is a silent no-op by design.
      const ranks = await request(server()).get('/api/ranks').set(bearer(ownerToken)).expect(200);
      const applicantRank = (ranks.body as { id: string; name: string }[]).find(
        (r) => r.name === 'Applicant',
      );
      await dataSource
        .getRepository(Rank)
        .update({ id: applicantRank!.id }, { discordRoleId: '900000000000000077' });
    });

    afterAll(async () => {
      const ranks = await request(server()).get('/api/ranks').set(bearer(ownerToken));
      const applicantRank = (ranks.body as { id: string; name: string }[]).find(
        (r) => r.name === 'Applicant',
      );
      if (applicantRank) {
        await dataSource
          .getRepository(Rank)
          .update({ id: applicantRank.id }, { discordRoleId: null });
      }
      const identity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId: APPLICANT_TWO } });
      if (identity) {
        await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
      }
      ownerToken = (await signIn(ownerProfile)).token;
    });

    it('marks a SUBMITTED application with the Applicant role', async () => {
      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
      applicantToken = (await signIn(applicantProfileTwo)).token;
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(applicantToken))
        .send({
          applicantName: 'Second Applicant',
          inGameName: 'SecondApp',
          currentRegiment: 'None',
          howFound: 'Discord invite',
          preferredClasses: 'Line Infantry',
          skillsToImprove: 'Melee',
          interestConfirmed: true,
        })
        .expect(201);
      applicationId = created.body.id as string;

      const assigns = await jobsOfType(DiscordSyncJobType.RoleAssign);
      expect(assigns.map((j) => (j.payload as { roleId: string }).roleId)).toContain(
        '900000000000000077',
      );
    });

    it('APPROVE strips the marker and enqueues an ADDITIVE role sync', async () => {
      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
      ownerToken = (await signIn(ownerProfile)).token;

      await request(server())
        .post(`/api/applications/${applicationId}/approve`)
        .set(bearer(ownerToken))
        .expect(200);

      // *** THE REGRESSION GUARD. *** Before this, approve() enqueued only the
      // decision DM: the member got the Recruit rank in the database and no
      // Discord role for it until an unrelated later change happened to sync.
      // T-0209: additive, so an approval can add the Recruit role it owes them
      // without taking off a decoration the roster has not caught up with.
      const syncs = await jobsOfType(DiscordSyncJobType.RoleGrant);
      expect(syncs.length).toBeGreaterThan(0);
      expect((syncs[0].payload as { discordUserId: string }).discordUserId).toBe(APPLICANT_TWO);

      const removes = await jobsOfType(DiscordSyncJobType.RoleRemove);
      expect(removes.map((j) => (j.payload as { roleId: string }).roleId)).toContain(
        '900000000000000077',
      );
    });
  });

  /**
   * T-0202 — enlisting a veteran the guild already decorated.
   *
   * This is the case the roster-derived reconcile got wrong. The regiment ran on
   * Discord for years before it ran on this dashboard, so a veteran's rank and
   * medals live ONLY as guild roles. The reconcile stripped every managed role
   * the roster could not account for, and a brand-new member row accounts for
   * nothing — so approval, the first reconcile of that member's life, wiped years
   * of history off the person it had just admitted. Doubly guarded since T-0209:
   * approval now drains as an ADDITIVE sync that cannot remove a role at all.
   *
   * The assertion that matters is the LAST one: after a full drain, the veteran
   * still wears every role they walked in with. Checking only the database rows
   * would pass even if the bot took the roles straight back off again.
   */
  describe('an approved applicant keeps the rank + medals Discord already gave them (T-0202)', () => {
    const VETERAN = '900900900900900908';
    const SERGEANT_ROLE = '900000000000000061';
    const VALOUR_ROLE = '900000000000000062';
    const UNLINKED_ROLE = '900000000000000063';
    let sergeantRankId: string;
    let valourMedalId: string;

    const veteranProfile = {
      id: VETERAN,
      username: 'e2e_veteran',
      global_name: 'Old Guard',
      discriminator: '0',
      avatar: null,
      email: 'veteran@example.com',
    };

    beforeAll(async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true })
        .expect(200);

      // Link a rank ABOVE the entry rank and a medal to real guild roles — the
      // links are what make either role adoptable at all.
      const ranks = await dataSource
        .getRepository(Rank)
        .find({ where: { regimentId: REGIMENT_ID } });
      sergeantRankId = ranks.find((r) => r.name === 'Sergeant')!.id;
      await dataSource
        .getRepository(Rank)
        .update({ id: sergeantRankId }, { discordRoleId: SERGEANT_ROLE });

      const medals = await dataSource
        .getRepository(Medal)
        .find({ where: { regimentId: REGIMENT_ID } });
      valourMedalId = medals[0].id;
      await dataSource
        .getRepository(Medal)
        .update({ id: valourMedalId }, { discordRoleId: VALOUR_ROLE });

      // The veteran walks in already wearing all three. The third is linked to
      // nothing, which is what makes it the control.
      await mockGateway.assignRole(VETERAN, SERGEANT_ROLE);
      await mockGateway.assignRole(VETERAN, VALOUR_ROLE);
      await mockGateway.assignRole(VETERAN, UNLINKED_ROLE);
    });

    afterAll(async () => {
      await dataSource.getRepository(Rank).update({ id: sergeantRankId }, { discordRoleId: null });
      await dataSource.getRepository(Medal).update({ id: valourMedalId }, { discordRoleId: null });
      const identity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId: VETERAN } });
      if (identity) {
        const member = await dataSource
          .getRepository(Member)
          .findOne({ where: { discordIdentityId: identity.id } });
        if (member) await dataSource.getRepository(MemberMedal).delete({ memberId: member.id });
        await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
      }
      ownerToken = (await signIn(ownerProfile)).token;
    });

    it('enlists them at their Discord rank, credits the medal, and does NOT strip either', async () => {
      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
      const veteran = await signIn(veteranProfile);
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(veteran.token))
        .send({
          applicantName: 'Old Guard',
          inGameName: 'OldGuard',
          currentRegiment: 'None',
          howFound: 'Been here since the start',
          preferredClasses: 'Line Infantry',
          skillsToImprove: 'Nothing, frankly',
          interestConfirmed: true,
        })
        .expect(201);

      ownerToken = (await signIn(ownerProfile)).token;
      const approved = await request(server())
        .post(`/api/applications/${created.body.id}/approve`)
        .set(bearer(ownerToken))
        .expect(200);

      // The roster now records what the guild already knew.
      const newMemberId = approved.body.promotedMemberId as string;
      const member = await dataSource.getRepository(Member).findOne({ where: { id: newMemberId } });
      expect(member!.rankId).toBe(sergeantRankId);
      const awards = await dataSource
        .getRepository(MemberMedal)
        .find({ where: { memberId: newMemberId } });
      expect(awards.map((a) => a.medalId)).toEqual([valourMedalId]);

      // *** THE REGRESSION GUARD. *** Drain the reconcile the approval queued and
      // confirm it left the veteran's roles alone. Before T-0202 this is exactly
      // where the Sergeant and medal roles came off.
      await drainAll();
      const ref = await mockGateway.fetchMember(VETERAN);
      expect(ref!.roles).toEqual(expect.arrayContaining([SERGEANT_ROLE, VALOUR_ROLE]));
      // And the role the dashboard manages nothing for is still untouched — the
      // carry-over did not widen what the bot considers its business.
      expect(ref!.roles).toContain(UNLINKED_ROLE);
    });
  });

  /**
   * T-0204 — the same carry-over, for the members it came too late for.
   *
   * T-0202 fixed enlistment going forward. It did nothing for the people already
   * on the roster: anyone approved before it shipped (or while the gateway was
   * unreachable, or before an admin had linked the rank and medal roles at all)
   * was enlisted at the entry rank with no decorations, and their Discord roles
   * were the only record of the truth. "Derive data from Discord" is the repair,
   * and this suite stages the failure exactly as it happened — approve FIRST,
   * link the roles AFTERWARDS — so the button is tested against the mess it
   * exists for rather than a tidy fixture.
   */
  describe("deriving an existing member's rank + medals from Discord (T-0204)", () => {
    const STRAGGLER = '900900900900900909';
    const CAPTAIN_ROLE = '900000000000000071';
    const CROSS_ROLE = '900000000000000072';
    let captainRankId: string;
    let recruitRankId: string;
    let crossMedalId: string;
    let crossMedalTitle: string;
    let stragglerId: string;
    let ownerMemberId: string;

    const stragglerProfile = {
      id: STRAGGLER,
      username: 'e2e_straggler',
      global_name: 'Missed Out',
      discriminator: '0',
      avatar: null,
      email: 'straggler@example.com',
    };

    beforeAll(async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true })
        .expect(200);

      const ranks = await dataSource
        .getRepository(Rank)
        .find({ where: { regimentId: REGIMENT_ID } });
      captainRankId = ranks.find((r) => r.name === 'Captain')!.id;
      recruitRankId = ranks.find((r) => r.name === 'Recruit')!.id;
      const medals = await dataSource
        .getRepository(Medal)
        .find({ where: { regimentId: REGIMENT_ID } });
      crossMedalId = medals[1].id;
      crossMedalTitle = medals[1].title;

      // The straggler is a decorated veteran in the guild...
      await mockGateway.assignRole(STRAGGLER, CAPTAIN_ROLE);
      await mockGateway.assignRole(STRAGGLER, CROSS_ROLE);

      // ...and is approved while NOTHING is linked, so the carry-over has nothing
      // to see and enlists them bare. This is the bug, reproduced.
      const straggler = await signIn(stragglerProfile);
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(straggler.token))
        .send({
          applicantName: 'Missed Out',
          inGameName: 'MissedOut',
          currentRegiment: 'None',
          howFound: 'Was already here',
          preferredClasses: 'Line Infantry',
          skillsToImprove: 'Nothing',
          interestConfirmed: true,
        })
        .expect(201);
      ownerToken = (await signIn(ownerProfile)).token;
      const approved = await request(server())
        .post(`/api/applications/${created.body.id}/approve`)
        .set(bearer(ownerToken))
        .expect(200);
      stragglerId = approved.body.promotedMemberId as string;

      // Only NOW does an admin link the roles — the state the regiment is in when
      // somebody finally notices the ranks and medals never came across.
      await dataSource
        .getRepository(Rank)
        .update({ id: captainRankId }, { discordRoleId: CAPTAIN_ROLE });
      await dataSource
        .getRepository(Medal)
        .update({ id: crossMedalId }, { discordRoleId: CROSS_ROLE });

      const ownerIdentity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId: ownerProfile.id } });
      ownerMemberId = (await dataSource
        .getRepository(Member)
        .findOne({ where: { discordIdentityId: ownerIdentity!.id } }))!.id;
    });

    afterAll(async () => {
      await dataSource.getRepository(Rank).update({ id: captainRankId }, { discordRoleId: null });
      await dataSource.getRepository(Medal).update({ id: crossMedalId }, { discordRoleId: null });
      const identity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId: STRAGGLER } });
      if (identity) {
        const member = await dataSource
          .getRepository(Member)
          .findOne({ where: { discordIdentityId: identity.id } });
        if (member) await dataSource.getRepository(MemberMedal).delete({ memberId: member.id });
        await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
      }
      ownerToken = (await signIn(ownerProfile)).token;
    });

    const derive = (memberId: string) =>
      request(server())
        .post(`/api/members/${memberId}/derive-from-discord`)
        .set(bearer(ownerToken));

    it('starts from the broken state: enlisted at the entry rank with nothing', async () => {
      const member = await dataSource.getRepository(Member).findOne({ where: { id: stragglerId } });
      expect(member!.rankId).toBe(recruitRankId);
      expect(
        await dataSource.getRepository(MemberMedal).count({ where: { memberId: stragglerId } }),
      ).toBe(0);
    });

    it('pulls the rank and the medal across, and says what it did', async () => {
      await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });

      const res = await derive(stragglerId).expect(200);

      expect(res.body.rank).toBe('Captain');
      expect(res.body.medals).toEqual([crossMedalTitle]);
      expect(res.body.summary).toBe(
        `Derived from Discord: MissedOut promoted to Captain and awarded ${crossMedalTitle}.`,
      );
      // The member projection in the same response is already up to date, so the
      // client does not have to refetch to show the result.
      expect(res.body.member.rank).toBe('Captain');
      expect(res.body.member.medals.map((m: { title: string }) => m.title)).toEqual([
        crossMedalTitle,
      ]);

      // Persisted, not merely projected.
      const member = await dataSource.getRepository(Member).findOne({ where: { id: stragglerId } });
      expect(member!.rankId).toBe(captainRankId);
      const awards = await dataSource
        .getRepository(MemberMedal)
        .find({ where: { memberId: stragglerId } });
      expect(awards.map((a) => a.medalId)).toEqual([crossMedalId]);
      // Marked as inferred from a role, so nobody later reads it as an award an
      // officer sat down and made.
      expect(awards[0].detail).toContain('Derived from');

      // The member's own timeline records both, which is where staff will look.
      const record = await request(server())
        .get(`/api/members/${stragglerId}/service-record`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(record.body.map((e: { event: string }) => e.event)).toEqual(
        expect.arrayContaining(['Rank set to Captain', `Awarded ${crossMedalTitle}`]),
      );

      // *** THE ONE THAT MATTERS. *** Drain the reconcile the derive queued: the
      // roster now agrees with the guild, so the roles it learned from must still
      // be there. If the diff were wrong this is where they would come off.
      await drainAll();
      const ref = await mockGateway.fetchMember(STRAGGLER);
      expect(ref!.roles).toEqual(expect.arrayContaining([CAPTAIN_ROLE, CROSS_ROLE]));
    });

    it('is safe to press twice: the second run finds nothing and writes nothing', async () => {
      const res = await derive(stragglerId).expect(200);

      expect(res.body).toMatchObject({ rank: null, medals: [] });
      expect(res.body.summary).toContain('Nothing to derive');
      // Still ONE award. A medal role is a boolean; pressing the button again is
      // not new evidence of anything.
      expect(
        await dataSource.getRepository(MemberMedal).count({ where: { memberId: stragglerId } }),
      ).toBe(1);
    });

    it('refuses your OWN record, where a derive would be a self-promotion', async () => {
      await derive(ownerMemberId).expect(403);
    });

    it('says the bot is switched off rather than reporting nothing to derive', async () => {
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: false })
        .expect(200);

      const res = await derive(stragglerId).expect(409);
      expect(res.body.message).toContain('switched off');

      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true })
        .expect(200);
    });
  });

  describe('the event announcement is the RSVP surface (T-0205)', () => {
    const EVENT_CHANNEL = '910000000000000004';
    const PING_ROLE = '900000000000000003';
    let eventId: string;

    /** The announcement message the bot posted for this event. */
    const announcement = () =>
      dataSource.getRepository(EventAnnouncement).findOne({ where: { eventId } });

    /** The member's stored RSVP, or null. */
    const storedRsvp = () =>
      dataSource.getRepository(EventRsvp).findOne({ where: { eventId, memberId } });

    /** Press one of the announcement's buttons as the enrolled member. */
    const pressButton = async (status: RsvpStatus) => {
      const delivered = await announcement();
      return mockGateway.simulateButtonPress({
        customId: rsvpCustomId(eventId, status),
        discordUserId: APPLICANT_DISCORD_ID,
        channelId: delivered!.channelId,
        messageId: delivered!.messageId,
      });
    };

    /** The roster sections of the announcement, as `name → value`. */
    const rosterFields = async (): Promise<Record<string, string>> => {
      const delivered = await announcement();
      const message = mockGateway.sentMessages.find((m) => m.messageId === delivered!.messageId);
      return Object.fromEntries((message?.embeds[0]?.fields ?? []).map((f) => [f.name, f.value]));
    };

    beforeAll(async () => {
      mockGateway.resetSentMessages();
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ botEnabled: true, eventAnnouncementChannelId: EVENT_CHANNEL })
        .expect(200);

      const created = await request(server())
        .post('/api/events')
        .set(bearer(ownerToken))
        .send({
          title: 'Line Battle',
          // Far enough out that the status sweep leaves it `upcoming`, and that
          // the 60-minute offset is NOT yet due — the reminder case fires the
          // sweep at an explicit instant instead of waiting for one.
          startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          announceRoleId: PING_ROLE,
          notifyOffsets: [60],
        })
        .expect(201);
      eventId = created.body.id as string;
      await drainAll();
    });

    afterAll(async () => {
      await dataSource.getRepository(RegimentEvent).delete({ id: eventId });
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(ownerToken))
        .send({ eventAnnouncementChannelId: null })
        .expect(200);
    });

    it('announces with the role ping, the RSVP sections and three live buttons', async () => {
      const post = mockGateway.sentMessages.find((m) => m.target === EVENT_CHANNEL);

      // The ping is in the CONTENT — an embed never notifies — and the role is
      // named in the allow-list, which is the only thing that makes it notify.
      expect(post?.content).toBe(`<@&${PING_ROLE}>`);
      expect(post?.mentions).toEqual({ roles: [PING_ROLE] });
      expect(post?.components[0].buttons.map((b) => b.label)).toEqual([
        'Attending',
        'Tentative',
        'Declined',
      ]);
      expect(post?.components[0].buttons.every((b) => b.disabled)).toBe(false);
      // Where it landed is recorded, which is what makes it re-renderable later.
      await expect(announcement()).resolves.toMatchObject({
        channelId: EVENT_CHANNEL,
        messageId: post!.messageId,
        threadId: null,
        closedAt: null,
      });
    });

    it('turns a button press into a real RSVP and moves the embed', async () => {
      const reply = await pressButton(RsvpStatus.Interested);
      expect(reply?.content).toContain('Attending');

      await expect(storedRsvp()).resolves.toMatchObject({ status: RsvpStatus.Interested });

      await drainAll();
      const fields = await rosterFields();
      expect(fields['✅ Attending — 1']).toBe(`<@${APPLICANT_DISCORD_ID}>`);
      expect(fields['❔ Tentative — 0']).toBe('—');
      expect(fields['❌ Declined — 0']).toBe('—');
    });

    it('lets the member reconsider — the buttons stay live after a press', async () => {
      await pressButton(RsvpStatus.Declined);
      await drainAll();

      await expect(storedRsvp()).resolves.toMatchObject({ status: RsvpStatus.Declined });
      const fields = await rosterFields();
      expect(fields['✅ Attending — 0']).toBe('—');
      expect(fields['❌ Declined — 1']).toBe(`<@${APPLICANT_DISCORD_ID}>`);

      const delivered = await announcement();
      const message = mockGateway.sentMessages.find((m) => m.messageId === delivered!.messageId);
      expect(message?.components[0].buttons.every((b) => b.disabled)).toBe(false);
      // And a re-render pings NOBODY, or one event would notify the role once
      // per RSVP.
      const edit = mockGateway.editedMessages.get(delivered!.messageId);
      expect(edit).toBeDefined();
      expect(JSON.stringify(edit)).not.toContain(PING_ROLE);

      // Put the member back on Attending for the thread-ping case below.
      await pressButton(RsvpStatus.Interested);
      await drainAll();
    });

    it('refuses a Discord account that is not a member, without creating one', async () => {
      const reply = await mockGateway.simulateButtonPress({
        customId: rsvpCustomId(eventId, RsvpStatus.Interested),
        discordUserId: '555000000000000009',
        channelId: EVENT_CHANNEL,
        messageId: (await announcement())!.messageId,
      });

      expect(reply?.content).toContain('Only enrolled members can RSVP');
      await expect(dataSource.getRepository(EventRsvp).count({ where: { eventId } })).resolves.toBe(
        1,
      );
    });

    it('re-renders the announcement when the event is EDITED, without re-pinging (T-0207)', async () => {
      // The channel must not keep advertising the details as they were when the
      // event was first announced — that is worse than silence, because it is
      // confidently wrong about when to turn up.
      const before = (await announcement())!.messageId;

      await request(server())
        .patch(`/api/events/${eventId}`)
        .set(bearer(ownerToken))
        .send({ title: 'Line Battle — moved to Saturday' })
        .expect(200);
      await drainAll();

      const message = mockGateway.sentMessages.find((m) => m.messageId === before);
      expect(message?.embeds[0]?.title).toContain('moved to Saturday');
      // Edited in place — no second announcement, and therefore no second ping.
      expect(await announcement()).toMatchObject({ messageId: before });
      expect(mockGateway.sentMessages.filter((m) => m.target === EVENT_CHANNEL)).toHaveLength(1);
      const edit = mockGateway.editedMessages.get(before);
      expect(JSON.stringify(edit)).not.toContain(PING_ROLE);
    });

    it('opens a thread on the announcement at the lead time and pings only the attendees', async () => {
      // The whole point of the thread: it reaches the people who said they were
      // coming without a single DM, which Discord's policy treats as abuse.
      mockGateway.resetSentMessages();
      const event = await dataSource.getRepository(RegimentEvent).findOneOrFail({
        where: { id: eventId },
      });
      // 30 minutes past the 60-minute offset's fire time, so the sweep sees it
      // as due while the event itself is still ahead.
      const sweepAt = new Date(event.startsAt.getTime() - 30 * 60 * 1000);
      expect(await app.get(EventReminderScheduler).sweep(sweepAt)).toBe(1);
      await drainAll();

      const threadId = (await announcement())!.threadId;
      expect(threadId).toEqual(expect.any(String));
      const threadPost = mockGateway.sentMessages.find((m) => m.target === threadId);
      expect(threadPost?.content).toBe(`<@${APPLICANT_DISCORD_ID}>`);
      expect(threadPost?.mentions).toEqual({ users: [APPLICANT_DISCORD_ID] });
      expect(threadPost?.embeds[0]?.title).toContain('Reminder');
      // The role is NOT re-pinged: it fired once, at creation.
      expect(JSON.stringify(threadPost)).not.toContain(PING_ROLE);
      // And nothing was DM'd.
      expect(mockGateway.sentMessages.filter((m) => m.kind === 'dm')).toHaveLength(0);
    });

    it('retires the buttons once the event has ended, keeping the roster', async () => {
      await dataSource
        .getRepository(RegimentEvent)
        .update({ id: eventId }, { status: EventStatus.Previous });

      expect(await app.get(EventStatusScheduler).closeEndedAnnouncements()).toBe(1);
      await drainAll();

      const delivered = await announcement();
      expect(delivered?.closedAt).toBeInstanceOf(Date);
      const edit = mockGateway.editedMessages.get(delivered!.messageId);
      expect(edit?.components?.[0].buttons.every((b) => b.disabled)).toBe(true);
      // The announcement stays the historical record of who turned out.
      expect(edit?.embeds?.[0].fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: '✅ Attending — 1' })]),
      );

      // A press after the close is refused rather than silently applied.
      const reply = await pressButton(RsvpStatus.Declined);
      expect(reply?.content).toContain('already finished');

      // And the sweep does not rediscover a retired announcement next tick.
      expect(await app.get(EventStatusScheduler).closeEndedAnnouncements()).toBe(0);
    });
  });

  it('stops enqueuing entirely when the bot is disabled', async () => {
    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ botEnabled: false })
      .expect(200);

    // A member-join normally enqueues a Welcome (and, for a returning member, a
    // role reconcile); with the bot disabled every enqueue no-ops, so nothing is
    // queued at all.
    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: '555000000000000001' })
      .expect(200);
    expect(await jobsOfType(DiscordSyncJobType.Welcome)).toHaveLength(0);
    expect(await jobsOfType(DiscordSyncJobType.RoleAssign)).toHaveLength(0);
  });
});
