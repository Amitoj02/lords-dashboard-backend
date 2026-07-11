import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { Application } from '../src/applications/entities/application.entity';
import { Member } from '../src/members/entities/member.entity';

/**
 * End-to-end coverage of the MVP core loop against a real MySQL schema:
 *   ranks/medals/regiment reads → apply → approve → member on roster →
 *   admin actions (award repeatable medal, change rank) → capability gating.
 *
 * Discord is faked (the OAuth service is overridden) so the whole sign-in →
 * JWT → capability flow runs offline. All rows the spec creates are cleaned up
 * in afterAll so it is safe to re-run against the seeded database.
 */
const APPLICANT_DISCORD_ID = '900900900900900901';

let currentProfile: Record<string, unknown> = {};

const fakeDiscord = {
  buildAuthorizeUrl: (state: string) =>
    `https://discord.com/oauth2/authorize?client_id=test&state=${state}`,
  exchangeCode: jest.fn().mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt',
    token_type: 'Bearer',
    expires_in: 604800,
    scope: 'identify email guilds',
  }),
  fetchUser: jest.fn().mockImplementation(() => Promise.resolve(currentProfile)),
  isMemberOfGuild: jest.fn().mockResolvedValue(true),
  buildAvatarUrl: () => null,
};

describe('MVP core loop (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ownerProfile = {
    id: '100000000000000001', // the seeded dev-owner snowflake
    username: 'lord_commander',
    global_name: 'Lord Commander',
    discriminator: '0',
    avatar: null,
    email: 'owner@example.com',
  };
  const applicantProfile = {
    id: APPLICANT_DISCORD_ID,
    username: 'e2e_applicant',
    global_name: 'E2E Applicant',
    discriminator: '0',
    avatar: null,
    email: 'e2e@example.com',
  };

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
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const identity = await dataSource
      .getRepository(DiscordIdentity)
      .findOne({ where: { discordUserId: APPLICANT_DISCORD_ID } });
    if (identity) {
      // Deleting the member cascades member_medals + service_record_entries.
      await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
      await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
      await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
    }
  }

  /** Sign in as the given profile; returns the JWT + isMember from the callback. */
  async function signIn(
    profile: Record<string, unknown>,
  ): Promise<{ token: string; isMember: boolean }> {
    currentProfile = profile;
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/api/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`).expect(302);
    const redirect = new URL(cb.headers.location);
    return {
      token: redirect.searchParams.get('token') as string,
      isMember: redirect.searchParams.get('isMember') === 'true',
    };
  }

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('owner sees the rank ladder, medal cabinet, regiment profile and real stats', async () => {
    const { token } = await signIn(ownerProfile);
    const server = app.getHttpServer();

    const ranks = await request(server).get('/api/ranks').set(bearer(token)).expect(200);
    expect(ranks.body.length).toBeGreaterThanOrEqual(12);
    expect(ranks.body[0]).toHaveProperty('holdersCount');

    const medals = await request(server).get('/api/medals').set(bearer(token)).expect(200);
    expect(medals.body.length).toBeGreaterThanOrEqual(5);
    expect(medals.body[0]).toHaveProperty('holdersCount');
    expect(medals.body[0]).toHaveProperty('awardsCount');

    const regiment = await request(server).get('/api/regiment').expect(200); // public
    expect(regiment.body).toHaveProperty('name');
    expect(regiment.body).toHaveProperty('memberCount');

    const stats = await request(server).get('/api/regiment/stats').expect(200); // public
    expect(stats.body).toHaveProperty('totalMembers');
    expect(stats.body).toHaveProperty('membersByRole');
  });

  it('runs the recruitment loop: apply → approve → member on roster, with admin actions', async () => {
    const server = app.getHttpServer();

    // 1) A brand-new applicant signs in (identity-only, not a member).
    const applicant = await signIn(applicantProfile);
    expect(applicant.isMember).toBe(false);

    // Applicant cannot read the roster (lacks view_members_directory).
    await request(server).get('/api/members').set(bearer(applicant.token)).expect(403);

    // 2) They submit an application.
    const created = await request(server)
      .post('/api/applications')
      .set(bearer(applicant.token))
      .send({
        applicantName: 'E2E Applicant',
        inGameName: 'E2E_App',
        platform: 'steam',
        applicantType: 'Applicant',
        whyJoin: 'For the line battles',
        howFound: 'discord',
        ageConfirmed: true,
      })
      .expect(201);
    const applicationId = created.body.id as string;

    // 3) The owner reviews + approves it.
    const owner = await signIn(ownerProfile);
    const queue = await request(server)
      .get('/api/applications')
      .set(bearer(owner.token))
      .expect(200);
    expect(queue.body.data.some((a: { id: string }) => a.id === applicationId)).toBe(true);

    const approved = await request(server)
      .post(`/api/applications/${applicationId}/approve`)
      .set(bearer(owner.token))
      .expect(200); // approve/decline/hold are @HttpCode(200)
    expect(approved.body.status).toBe('approved');
    const memberId = approved.body.promotedMemberId as string;
    expect(memberId).toBeTruthy();

    // 4) The new member is on the roster with a service record.
    const roster = await request(server).get('/api/members').set(bearer(owner.token)).expect(200);
    expect(roster.body.data.some((m: { id: string }) => m.id === memberId)).toBe(true);

    const record = await request(server)
      .get(`/api/members/${memberId}/service-record`)
      .set(bearer(owner.token))
      .expect(200);
    expect(record.body.some((e: { type: string }) => e.type === 'enlistment')).toBe(true);

    // 5) Award a medal twice (repeatable) and change the member's rank.
    const medals = await request(server).get('/api/medals').set(bearer(owner.token)).expect(200);
    const medalId = medals.body[0].id as string;

    await request(server)
      .post(`/api/members/${memberId}/medals`)
      .set(bearer(owner.token))
      .send({ medalId })
      .expect(201);
    const second = await request(server)
      .post(`/api/members/${memberId}/medals`)
      .set(bearer(owner.token))
      .send({ medalId })
      .expect(201);
    // Same medal awarded twice => two award rows (medals are repeatable).
    expect(
      second.body.medals.filter((m: { medalId: string }) => m.medalId === medalId),
    ).toHaveLength(2);

    const ranks = await request(server).get('/api/ranks').set(bearer(owner.token)).expect(200);
    const captainId = ranks.body.find((r: { name: string }) => r.name === 'Captain').id as string;
    const ranked = await request(server)
      .post(`/api/members/${memberId}/rank`)
      .set(bearer(owner.token))
      .send({ rankId: captainId })
      .expect(201);
    expect(ranked.body.rank).toBe('Captain');
  });
});
