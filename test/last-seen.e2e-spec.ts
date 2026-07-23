import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { Member } from '../src/members/entities/member.entity';
import { OWNER_DISCORD_USER_ID } from '../src/database/seeds/seed.util';

/**
 * E2E for T-0108: an authenticated request advances `last_seen_at` to reflect
 * last site ACCESS, not only last sign-in. This suite runs in its own app
 * instance so the in-memory throttle map starts empty and the first authenticated
 * request deterministically issues the bump.
 */
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
  fetchUser: jest.fn().mockResolvedValue({
    id: OWNER_DISCORD_USER_ID,
    username: 'lord_commander',
    global_name: 'Lord Commander',
    discriminator: '0',
    avatar: 'ownerhash',
    email: 'owner@example.com',
  }),
  buildAvatarUrl: (id: string, hash: string | null) =>
    hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png` : null,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('last_seen_at bump (e2e)', () => {
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
  });

  afterAll(async () => {
    await app.close();
  });

  async function signIn(): Promise<string> {
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/api/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await agent
      .get(`/api/auth/discord/callback?code=fake-code&state=${state}`)
      .expect(302);
    // Token is in the URL fragment now (LDA-H4), not the query string.
    return new URLSearchParams(new URL(cb.headers.location).hash.replace(/^#/, '')).get(
      'token',
    ) as string;
  }

  it('advances last_seen_at on an authenticated request, beyond the login timestamp', async () => {
    const token = await signIn();

    const identities = dataSource.getRepository(DiscordIdentity);
    const membersRepo = dataSource.getRepository(Member);
    const identity = await identities.findOne({
      where: { discordUserId: OWNER_DISCORD_USER_ID },
    });
    expect(identity).toBeTruthy();
    const member = await membersRepo.findOne({
      where: { discordIdentityId: identity!.id },
    });
    expect(member).toBeTruthy();

    // Backdate last_seen_at to simulate a stale "last logged in" value.
    const stale = new Date('2000-01-01T00:00:00.000Z');
    await membersRepo.update({ id: member!.id }, { lastSeenAt: stale });

    // A single authenticated request should trigger the throttled bump.
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The bump is fire-and-forget, so poll briefly for the async write to commit.
    let after: Date | null = null;
    for (let i = 0; i < 40; i++) {
      const fresh = await membersRepo.findOne({ where: { id: member!.id } });
      if (fresh?.lastSeenAt && fresh.lastSeenAt.getTime() > stale.getTime()) {
        after = fresh.lastSeenAt;
        break;
      }
      await sleep(50);
    }

    expect(after).toBeTruthy();
    // Advanced to ~now (well within the last 5 minutes), not the backdated value.
    expect(Date.now() - (after as Date).getTime()).toBeLessThan(5 * 60_000);
  });
});
