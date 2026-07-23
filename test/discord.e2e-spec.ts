import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { Application } from '../src/applications/entities/application.entity';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../src/common/enums';
import { DiscordSyncWorker } from '../src/discord/discord-sync.worker';
import { DiscordGateway } from '../src/discord/gateway/discord-gateway';
import { MockDiscordGateway } from '../src/discord/gateway/mock-discord-gateway';
import { BotOperation } from '../src/discord/entities/bot-operation.entity';
import { DiscordBotSettings } from '../src/discord/entities/discord-bot-settings.entity';
import { DiscordConnection } from '../src/discord/entities/discord-connection.entity';
import { DiscordSyncJob } from '../src/discord/entities/discord-sync-job.entity';
import { Member } from '../src/members/entities/member.entity';

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
        joinRoleId: null,
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
    return { token: new URL(cb.headers.location).searchParams.get('token') as string };
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
      .send({ botEnabled: true, joinRoleId: '900000000000000001' })
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

  it('enqueues a role sync on rank change and drains it successfully', async () => {
    const ranks = await request(server()).get('/api/ranks').set(bearer(ownerToken)).expect(200);
    const targetRank =
      ranks.body.find((r: { name: string }) => r.name === 'Captain') ?? ranks.body[0];

    await request(server())
      .post(`/api/members/${memberId}/rank`)
      .set(bearer(ownerToken))
      .send({ rankId: targetRank.id })
      .expect(201);

    const syncs = await jobsOfType(DiscordSyncJobType.RoleSync);
    expect(syncs.length).toBeGreaterThanOrEqual(1);
    await drainAll();
    const drained = await jobsOfType(DiscordSyncJobType.RoleSync);
    expect(drained.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);
  });

  it('onboards a joining member: welcome + Guest join-role jobs, then drains them', async () => {
    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: '555000000000000000' })
      .expect(200);

    expect((await jobsOfType(DiscordSyncJobType.Welcome)).length).toBeGreaterThanOrEqual(1);
    expect((await jobsOfType(DiscordSyncJobType.RoleAssign)).length).toBeGreaterThanOrEqual(1);
    await drainAll();
    const welcomes = await jobsOfType(DiscordSyncJobType.Welcome);
    expect(welcomes.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);
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
        .send({ botEnabled: true, joinRoleId: '900000000000000001' })
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
      expect(dm?.embeds[0].fields?.[0].name).toBe('Next steps');
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

  it('stops enqueuing entirely when the bot is disabled', async () => {
    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ botEnabled: false })
      .expect(200);

    // A member-join normally enqueues Welcome + join-role jobs; with the bot
    // disabled every enqueue no-ops, so nothing is queued at all.
    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: '555000000000000001' })
      .expect(200);
    expect(await jobsOfType(DiscordSyncJobType.Welcome)).toHaveLength(0);
    expect(await jobsOfType(DiscordSyncJobType.RoleAssign)).toHaveLength(0);
  });
});
