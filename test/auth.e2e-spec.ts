import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { MemberRole } from '../src/common/enums';
import { OWNER_DISCORD_USER_ID } from '../src/database/seeds/seed.util';

const NEW_DISCORD_ID = '987654321000111222';

/** Mutable Discord profile the fake returns; swapped per test. */
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
  buildAvatarUrl: (id: string, hash: string | null) =>
    hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png` : null,
};

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

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
    await dataSource.getRepository(DiscordIdentity).delete({ discordUserId: NEW_DISCORD_ID });
  });

  afterAll(async () => {
    await dataSource.getRepository(DiscordIdentity).delete({ discordUserId: NEW_DISCORD_ID });
    await app.close();
  });

  /** Drive the OAuth handshake; returns the token + isMember from the callback redirect. */
  async function signIn(): Promise<{ token: string; isMember: boolean }> {
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/api/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    expect(state).toBeTruthy();

    const cb = await agent
      .get(`/api/auth/discord/callback?code=fake-code&state=${state}`)
      .expect(302);
    const redirect = new URL(cb.headers.location);
    // The JWT + isMember are handed off in the URL FRAGMENT now, not the query
    // string (LDA-H4) — a fragment never reaches server logs or the Referer header.
    const frag = new URLSearchParams(redirect.hash.replace(/^#/, ''));
    return {
      token: frag.get('token') as string,
      isMember: frag.get('isMember') === 'true',
    };
  }

  it('GET /api/auth/discord redirects to Discord with a state cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/discord').expect(302);
    expect(res.headers.location).toContain('discord.com/oauth2/authorize');
    expect(String(res.headers['set-cookie'])).toContain('discord_oauth_state');
  });

  it('GET /api/auth/me without a token is 401', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('callback with a mismatched state redirects to the failure URL', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/auth/discord').expect(302);
    const res = await agent
      .get('/api/auth/discord/callback?code=fake-code&state=tampered')
      .expect(302);
    expect(res.headers.location).toContain('error=invalid_state');
  });

  it('a brand-new sign-in creates a Discord identity (user record) and is not yet a member', async () => {
    currentProfile = {
      id: NEW_DISCORD_ID,
      username: 'freshrecruit',
      global_name: 'Fresh Recruit',
      discriminator: '0',
      avatar: 'avatarhash',
      email: 'fresh@example.com',
    };

    const { token, isMember } = await signIn();
    expect(isMember).toBe(false);
    expect(token).toBeTruthy();

    // The user record now exists in the database.
    const identity = await dataSource
      .getRepository(DiscordIdentity)
      .findOne({ where: { discordUserId: NEW_DISCORD_ID } });
    expect(identity).toBeTruthy();
    expect(identity?.discordTag).toBe('@freshrecruit');
    expect(identity?.globalName).toBe('Fresh Recruit');
    // Token is encrypted at rest but decrypts transparently through the transformer.
    expect(identity?.accessToken).toBe('at');
    expect(identity?.lastSignInAt).toBeTruthy();

    // /auth/me returns the identity projection for a not-yet-member.
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body).toMatchObject({
      inGameName: 'Fresh Recruit',
      role: MemberRole.Applicant,
      rank: null,
      isMember: false,
    });
    // The guild-gate fields are on the identity-only projection too (T-0166):
    // an applicant who is not in the guild is precisely who needs the invite.
    expect(me.body).toMatchObject({ guildGateEnabled: false, guildGateExempt: false });
    expect(me.body).toHaveProperty('guildMember');
    expect(me.body).toHaveProperty('discordInviteUrl');
  });

  it('the authorize URL still asks for identify+email only — no guilds scope (T-0166)', async () => {
    // Surfacing guild membership on the session must not widen the OAuth consent
    // screen; the verdict comes from the bot, never from the `guilds` scope.
    const res = await request(app.getHttpServer()).get('/api/auth/discord').expect(302);
    expect(res.headers.location).not.toContain('guilds');
  });

  it('GET /api/auth/guild-status is authenticated and reports the gate as OFF by default', async () => {
    await request(app.getHttpServer()).get('/api/auth/guild-status').expect(401);

    currentProfile = {
      id: NEW_DISCORD_ID,
      username: 'freshrecruit',
      global_name: 'Fresh Recruit',
      discriminator: '0',
      avatar: 'avatarhash',
      email: 'fresh@example.com',
    };
    const { token } = await signIn();
    const status = await request(app.getHttpServer())
      .get('/api/auth/guild-status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Shipped OFF (owner decision): with no bot rolled out, every verdict would
    // be wrong and enforcing one would lock the regiment out.
    expect(status.body).toMatchObject({ gateEnabled: false, exempt: false });
    expect(typeof status.body.guildMember).toBe('boolean');
    expect(typeof status.body.degraded).toBe('boolean');
  });

  it('a returning sign-in linked to a roster member resolves the member (owner)', async () => {
    currentProfile = {
      id: OWNER_DISCORD_USER_ID,
      username: 'lord_commander',
      global_name: 'Lord Commander',
      discriminator: '0',
      avatar: 'ownerhash',
      email: 'owner@example.com',
    };

    const { token, isMember } = await signIn();
    expect(isMember).toBe(true);

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body).toMatchObject({
      // For a linked member, /auth/me returns the seeded roster member's in-game
      // name (the sole display identity after T-0106) — NOT the Discord global_name.
      inGameName: 'Lord_Commander',
      role: MemberRole.Owner,
      rank: 'General',
      isMember: true,
    });
  });
});
