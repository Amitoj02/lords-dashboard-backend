import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { GuildMembershipService } from '../src/auth/guild-membership.service';
import { DiscordBotSettings } from '../src/discord/entities/discord-bot-settings.entity';
import { DiscordGateway } from '../src/discord/gateway/discord-gateway';
import { OWNER_DISCORD_USER_ID, REGIMENT_ID } from '../src/database/seeds/seed.util';

/**
 * End-to-end coverage of guild-membership re-validation (T-0166/T-0167/T-0169)
 * against real MySQL and the MOCK Discord gateway.
 *
 * The properties under test are the ones that decide whether a bot outage is an
 * annoyance or a regiment-wide lockout: the verdict is cached and never fetched
 * on an ordinary request, a live join/leave writes through immediately, and the
 * gate ships OFF.
 */
const GUEST_DISCORD_ID = '901000000000000101';

/**
 * This suite tests the CONFIRMED-verdict paths, and a verdict can only be
 * confirmed when a guild is bound: with no `DISCORD_GUILD_ID`, `probe()`
 * deliberately returns null, writes nothing, and every identity stays
 * "never confirmed" and fails open. That is correct behaviour, but it makes the
 * suite's precondition ambient — it passed locally only because the developer's
 * `.env` happens to set the variable, and failed in CI, which sets no `.env` at
 * all. Pin it here, before ConfigModule reads the environment, so the suite is
 * deterministic wherever it runs. The bot is mocked, so the value is arbitrary.
 */
process.env.DISCORD_GUILD_ID ||= '900000000000000900';

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

describe('Guild membership (e2e, mock gateway)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let gateway: DiscordGateway;
  let guildMembership: GuildMembershipService;
  let fetchMember: jest.SpyInstance;

  let ownerToken: string;
  let guestToken: string;
  let guestIdentityId: string;

  const ownerProfile = {
    id: OWNER_DISCORD_USER_ID,
    username: 'lord_commander',
    global_name: 'Lord Commander',
    discriminator: '0',
    avatar: null,
    email: 'owner@example.com',
  };
  const guestProfile = {
    id: GUEST_DISCORD_ID,
    username: 'e2e_guild_guest',
    global_name: 'Guild Guest',
    discriminator: '0',
    avatar: null,
    email: 'guild-guest@example.com',
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
    gateway = app.get(DiscordGateway);
    guildMembership = app.get(GuildMembershipService);
    await cleanup();

    ownerToken = (await signIn(ownerProfile)).token;
    guestToken = (await signIn(guestProfile)).token;
    const guest = await identityRow();
    guestIdentityId = guest!.id;

    // Spy AFTER sign-in so the inline sign-in lookup is not counted.
    fetchMember = jest.spyOn(gateway, 'fetchMember');
  });

  afterAll(async () => {
    fetchMember?.mockRestore();
    await cleanup();
    await app.close();
  });

  /**
   * Drop this suite's own identity and pin the shared, single-row bot settings
   * to their shipped defaults — with the bot dormant a simulated join enqueues
   * nothing, so this suite leaves no outbox rows behind for the next one.
   */
  async function cleanup(): Promise<void> {
    await dataSource.getRepository(DiscordIdentity).delete({ discordUserId: GUEST_DISCORD_ID });
    await dataSource
      .getRepository(DiscordBotSettings)
      .update({ regimentId: REGIMENT_ID }, { botEnabled: false, guildGateEnabled: false });
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
  const identityRow = () =>
    dataSource
      .getRepository(DiscordIdentity)
      .findOne({ where: { discordUserId: GUEST_DISCORD_ID } });

  it('serves the cached verdict without touching the bot inside the TTL (T-0167)', async () => {
    const first = await request(server())
      .get('/api/auth/guild-status')
      .set(bearer(guestToken))
      .expect(200);
    expect(first.body).toMatchObject({ gateEnabled: false, exempt: false, degraded: false });
    // The mock guild only pre-joins the seeded owner, so this identity is a
    // CONFIRMED non-member — stamped, not merely unknown.
    expect(first.body.guildMember).toBe(false);
    expect(first.body.checkedAt).toEqual(expect.any(String));

    const callsAfterFirst = fetchMember.mock.calls.length;
    await request(server()).get('/api/auth/guild-status').set(bearer(guestToken)).expect(200);
    await request(server()).get('/api/auth/guild-status').set(bearer(guestToken)).expect(200);
    expect(fetchMember.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-checks exactly once after the verdict expires, and persists it (T-0167)', async () => {
    guildMembership.invalidate(guestIdentityId);
    fetchMember.mockClear();

    // Two callers racing a cold cache must still cost the bot ONE call.
    await Promise.all([
      request(server()).get('/api/auth/guild-status').set(bearer(guestToken)).expect(200),
      request(server()).get('/api/auth/guild-status').set(bearer(guestToken)).expect(200),
    ]);

    expect(fetchMember).toHaveBeenCalledTimes(1);
    expect(fetchMember).toHaveBeenCalledWith(GUEST_DISCORD_ID);
    const row = await identityRow();
    expect(row?.guildMember).toBe(false);
    expect(row?.guildCheckedAt).toBeInstanceOf(Date);
  });

  it('never asks the bot on ordinary authenticated requests (T-0167)', async () => {
    fetchMember.mockClear();

    for (let i = 0; i < 3; i++) {
      await request(server()).get('/api/members').set(bearer(ownerToken)).expect(200);
      await request(server()).get('/api/events/mine').set(bearer(ownerToken)).expect(200);
      await request(server()).get('/api/gallery/archive').set(bearer(ownerToken)).expect(200);
      await request(server()).get('/api/auth/me').set(bearer(ownerToken)).expect(200);
    }

    // A Discord round-trip anywhere on the request path would put the bot's
    // availability in front of the entire dashboard.
    expect(fetchMember).not.toHaveBeenCalled();
  });

  it('flips the verdict to false on a live departure, without another bot call (T-0169)', async () => {
    // Join first so there is something to lose.
    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: GUEST_DISCORD_ID })
      .expect(200);
    expect((await identityRow())?.guildMember).toBe(true);

    fetchMember.mockClear();
    await request(server())
      .post('/api/discord/simulate/member-leave')
      .set(bearer(ownerToken))
      .send({ discordUserId: GUEST_DISCORD_ID })
      .expect(200);

    expect((await identityRow())?.guildMember).toBe(false);
    const status = await request(server())
      .get('/api/auth/guild-status')
      .set(bearer(guestToken))
      .expect(200);
    // Enforced on the NEXT visit, not at the end of the 15-minute TTL — and
    // without re-deriving what Discord just told us.
    expect(status.body).toMatchObject({ guildMember: false, degraded: false });
    expect(fetchMember).not.toHaveBeenCalled();
  });

  it('clears the gate again on re-join (T-0169)', async () => {
    fetchMember.mockClear();
    await request(server())
      .post('/api/discord/simulate/member-join')
      .set(bearer(ownerToken))
      .send({ discordUserId: GUEST_DISCORD_ID })
      .expect(200);

    const status = await request(server())
      .get('/api/auth/guild-status')
      .set(bearer(guestToken))
      .expect(200);
    expect(status.body).toMatchObject({ guildMember: true, degraded: false });
    expect(fetchMember).not.toHaveBeenCalled();
  });

  it('exposes the gate fields on /auth/me and ships the gate OFF (T-0166)', async () => {
    const me = await request(server()).get('/api/auth/me').set(bearer(guestToken)).expect(200);
    expect(me.body).toMatchObject({
      guildMember: true,
      guildGateEnabled: false,
      guildGateExempt: false,
    });
    expect(me.body).toHaveProperty('discordInviteUrl');
  });

  it('reports the gate as on once an admin enables it, and exempts manage_settings (T-0167)', async () => {
    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ guildGateEnabled: true })
      .expect(200);

    const owner = await request(server())
      .get('/api/auth/guild-status')
      .set(bearer(ownerToken))
      .expect(200);
    // The owner holds manage_settings, so the gate can never lock them out of
    // the screen that turns it back off.
    expect(owner.body).toMatchObject({ gateEnabled: true, exempt: true });

    const guest = await request(server())
      .get('/api/auth/guild-status')
      .set(bearer(guestToken))
      .expect(200);
    expect(guest.body).toMatchObject({ gateEnabled: true, exempt: false });

    const me = await request(server()).get('/api/auth/me').set(bearer(guestToken)).expect(200);
    expect(me.body).toMatchObject({ guildGateEnabled: true, guildGateExempt: false });

    await request(server())
      .patch('/api/discord/settings')
      .set(bearer(ownerToken))
      .send({ guildGateEnabled: false })
      .expect(200);
  });

  it('requires a session for the guild-status check', async () => {
    await request(server()).get('/api/auth/guild-status').expect(401);
  });
});
