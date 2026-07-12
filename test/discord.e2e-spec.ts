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
const REGIMENT_ID = '00000000-0000-4000-8000-000000000001';

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
    // Reset the bot to its dormant defaults.
    await dataSource.getRepository(DiscordBotSettings).update(
      { regimentId: REGIMENT_ID },
      {
        botEnabled: false,
        applyBanRoleOnBan: false,
        banRoleId: null,
        joinRoleId: null,
        announcementChannelId: null,
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
      .send({ botEnabled: true, joinRoleId: '900000000000000001', announcementChannelId: '123456' })
      .expect(200);

    const verify = await request(server())
      .post('/api/discord/verify-connection')
      .set(bearer(ownerToken))
      .expect(200);
    expect(verify.body.connected).toBe(true);
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

  it('queues + drains an announcement broadcast', async () => {
    const res = await request(server())
      .post('/api/discord/announce')
      .set(bearer(ownerToken))
      .send({ content: 'Stand to! Line battle at 1900.' })
      .expect(200);
    expect(res.body.enqueued).toBe(true);

    await drainAll();
    const announces = await jobsOfType(DiscordSyncJobType.Announce);
    expect(announces.length).toBeGreaterThanOrEqual(1);
    expect(announces.every((j) => j.status === DiscordSyncJobStatus.Succeeded)).toBe(true);
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

  it('stops enqueuing entirely when the bot is disabled', async () => {
    await dataSource.getRepository(DiscordSyncJob).delete({ regimentId: REGIMENT_ID });
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ botEnabled: false })
      .expect(200);

    const res = await request(server())
      .post('/api/discord/announce')
      .set(bearer(ownerToken))
      .send({ content: 'should not queue' })
      .expect(200);
    expect(res.body.enqueued).toBe(false);
    expect(await jobsOfType(DiscordSyncJobType.Announce)).toHaveLength(0);
  });
});
