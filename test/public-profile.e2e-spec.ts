import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { MemberRole, MemberStatus } from '../src/common/enums';
import { Member } from '../src/members/entities/member.entity';
import { UsernameReservationReason } from '../src/members/entities/username-reservation.entity';
import { OWNER_DISCORD_USER_ID } from '../src/database/seeds/seed.util';

/**
 * E2E for T-0215: the anonymous roster and profile surface.
 *
 * The assertions that matter most here are the NEGATIVE ones. A redaction bug
 * on this endpoint is not a 500 anyone notices — it is a field quietly served
 * to the whole internet and then cached at the edge for five minutes, so the
 * suite checks what is ABSENT at least as hard as what is present.
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

describe('public roster + profiles (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let members: ReturnType<DataSource['getRepository']>;
  let ownerId: string;

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
    members = dataSource.getRepository(Member);

    const owner = await members.findOne({
      where: { role: MemberRole.Owner },
      order: { createdAt: 'ASC' },
    });
    ownerId = (owner as Member).id;
    await members.update(ownerId, { username: 'panda', status: MemberStatus.Active });
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
    return new URLSearchParams(new URL(cb.headers.location).hash.replace(/^#/, '')).get(
      'token',
    ) as string;
  }

  describe('the roster is reachable with no credentials at all', () => {
    it('serves a page anonymously, where the authenticated route 401s', async () => {
      await request(app.getHttpServer()).get('/api/members').expect(401);

      const res = await request(app.getHttpServer()).get('/api/public/members').expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toHaveProperty('total');
    });

    it('is edge-cacheable — nothing in the response varies by caller', async () => {
      const res = await request(app.getHttpServer()).get('/api/public/members').expect(200);

      // main.ts sets a blanket `no-store` before routing; a public read has to
      // override it explicitly or the whole point of the projection is lost.
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('max-age=300');
    });

    it('NEVER carries the fields that would make it caller-dependent or personal', async () => {
      const res = await request(app.getHttpServer()).get('/api/public/members').expect(200);
      const row = res.body.data[0];

      for (const field of [
        'discordTag',
        'discordLinked',
        'status',
        'standing',
        'lastSeenAt',
        'suspendedUntil',
        'bannedAt',
        'permittedActions',
        'publicProfile',
      ]) {
        expect(row).not.toHaveProperty(field);
      }
      // And no Discord snowflake anywhere in the payload, including inside an
      // avatar URL — that is the leak an <img src> would smuggle past the DTO.
      expect(JSON.stringify(res.body)).not.toContain('cdn.discordapp.com');
    });
  });

  describe('a profile resolves by @handle and by short id', () => {
    it('serves the same member either way, with one canonical path', async () => {
      const byHandle = await request(app.getHttpServer())
        .get('/api/public/members/@panda')
        .expect(200);
      const byId = await request(app.getHttpServer())
        .get(`/api/public/members/${ownerId}`)
        .expect(200);

      expect(byHandle.body.id).toBe(ownerId);
      expect(byId.body.id).toBe(ownerId);
      // Both URLs answer, and both agree on which one Google should keep.
      expect(byHandle.body.canonicalPath).toBe('/u/@panda');
      expect(byId.body.canonicalPath).toBe('/u/@panda');
    });

    it('normalises the case in a handle rather than 404ing on it', async () => {
      await request(app.getHttpServer()).get('/api/public/members/@PANDA').expect(200);
    });

    it('REFUSES a bare handle — the @ is what keeps the namespaces disjoint', async () => {
      // Without the sigil a 12-char handle would be indistinguishable from a
      // short id, so a bare name is not a valid address at all.
      await request(app.getHttpServer()).get('/api/public/members/panda').expect(404);
    });

    it('404s an unknown handle and an unknown id alike', async () => {
      await request(app.getHttpServer()).get('/api/public/members/@nobodyhere').expect(404);
      await request(app.getHttpServer()).get('/api/public/members/zzzzzzzzzzzz').expect(404);
    });
  });

  describe('the exclusion predicate', () => {
    async function withRole<T>(patch: Partial<Member>, run: () => Promise<T>): Promise<T> {
      const before = await members.findOne({ where: { id: ownerId } });
      await members.update(ownerId, patch);
      try {
        return await run();
      } finally {
        await members.update(ownerId, {
          role: (before as Member).role,
          status: (before as Member).status,
          bannedAt: null,
          suspendedUntil: null,
        });
      }
    }

    it('hides an APPLICANT entirely rather than labelling them publicly', async () => {
      await withRole({ role: MemberRole.Applicant }, async () => {
        await request(app.getHttpServer()).get('/api/public/members/@panda').expect(404);
      });
    });

    it('hides a PENDING member — that status means an application is under review', async () => {
      await withRole({ status: MemberStatus.Pending }, async () => {
        await request(app.getHttpServer()).get('/api/public/members/@panda').expect(404);
      });
    });

    it('hides a BANNED member with a plain 404, never a distinguishable code', async () => {
      // A 410 here would turn the endpoint into an oracle answering "was this
      // member disciplined?" to anyone holding the old URL.
      await withRole({ bannedAt: new Date() }, async () => {
        await request(app.getHttpServer()).get('/api/public/members/@panda').expect(404);
      });
    });

    it('hides a member whose suspension is still running', async () => {
      await withRole({ suspendedUntil: new Date(Date.now() + 86_400_000) }, async () => {
        await request(app.getHttpServer()).get('/api/public/members/@panda').expect(404);
      });
    });

    it('restores a member whose suspension has LAPSED, with nothing to run', async () => {
      // suspended_until is a timestamp, not a status — the profile comes back on
      // its own.
      await withRole({ suspendedUntil: new Date(Date.now() - 86_400_000) }, async () => {
        await request(app.getHttpServer()).get('/api/public/members/@panda').expect(200);
      });
    });

    it('applies the same predicate to the roster list, not just the profile', async () => {
      await withRole({ role: MemberRole.Applicant }, async () => {
        const res = await request(app.getHttpServer()).get('/api/public/members').expect(200);
        expect(res.body.data.map((m: { id: string }) => m.id)).not.toContain(ownerId);
      });
    });
  });

  describe('410 Gone is reserved for a deliberately deleted account', () => {
    it('answers 410 for a permanently blocked handle', async () => {
      await dataSource.query(
        "INSERT INTO `username_reservations` (`username`, `reason`, `former_member_id`, `held_until`) VALUES ('departed', ?, NULL, NULL)",
        [UsernameReservationReason.Blocked],
      );
      try {
        await request(app.getHttpServer()).get('/api/public/members/@departed').expect(410);
      } finally {
        await dataSource.query("DELETE FROM `username_reservations` WHERE `username` = 'departed'");
      }
    });
  });

  describe('the signed-in roster keeps the fields the public one drops', () => {
    it('still serves discordTag and lastSeenAt to an authenticated member', async () => {
      const token = await signIn();

      const res = await request(app.getHttpServer())
        .get('/api/members')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const row = res.body.data.find((m: { id: string }) => m.id === ownerId);
      expect(row).toHaveProperty('discordTag');
      expect(row).toHaveProperty('lastSeenAt');
      expect(row).toHaveProperty('permittedActions');
    });
  });

  describe('vanity handles', () => {
    it('refuses a reserved handle with a 409, not a 500 from the index', async () => {
      const token = await signIn();

      await request(app.getHttpServer())
        .patch(`/api/members/${ownerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'moderator' })
        .expect(409);
    });

    it('refuses a malformed handle at the DTO boundary with a 400', async () => {
      const token = await signIn();

      await request(app.getHttpServer())
        .patch(`/api/members/${ownerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'No.Dots' })
        .expect(400);
    });

    it('answers the availability probe without throwing on a malformed candidate', async () => {
      const token = await signIn();

      const res = await request(app.getHttpServer())
        .get('/api/members/me/username-available?username=no')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toEqual({ available: false, reason: 'invalid' });
    });
  });

  describe('the crawler surface', () => {
    it('renders a profile as real HTML with canonical, JSON-LD and no meta refresh', async () => {
      const res = await request(app.getHttpServer()).get('/api/seo/u/@panda').expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<link rel="canonical"');
      expect(res.text).toContain('application/ld+json');
      expect(res.text).toContain('ProfilePage');
      // The bug this replaced: a 0-second refresh back to the URL the crawler
      // was rewritten from, which Googlebot follows into a loop.
      expect(res.text).not.toContain('http-equiv="refresh"');
      // Equivalence: the crawler sees the same facts a human does, not a stub.
      // `Events attended` used to be the sentinel here; it left every surface in
      // T-0297, so the rank — which the SPA also shows in the particulars — is
      // what stands in for "a real facts list, not a head full of meta tags".
      expect(res.text).toContain('<h1>');
      expect(res.text).toContain('<dt>Rank</dt>');
      expect(res.text).not.toContain('Events attended');
      // The oEmbed link is the only source of Discord's author line, and it is
      // discoverable ONLY as this element — Discord ignores the `Link:` header
      // form the spec also permits.
      expect(res.text).toContain('type="application/json+oembed"');
      expect(res.text).toContain('<meta property="profile:username" content="panda" />');
    });

    it('propagates the SAME status code the API gives, so a dead URL de-indexes', async () => {
      await request(app.getHttpServer()).get('/api/seo/u/@nobodyhere').expect(404);
    });

    it('renders the roster with crawlable anchors to each profile', async () => {
      const res = await request(app.getHttpServer()).get('/api/seo/roster').expect(200);

      expect(res.text).toContain('href="');
      expect(res.text).toContain('/u/@panda');
      expect(res.text).toContain('ItemList');
    });

    it('serves a well-formed sitemap that lists the roster and the profiles', async () => {
      const res = await request(app.getHttpServer()).get('/api/sitemap.xml').expect(200);

      expect(res.headers['content-type']).toContain('xml');
      expect(res.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(res.text).toContain('<urlset');
      expect(res.text).toContain('/roster</loc>');
      expect(res.text).toContain('/u/@panda</loc>');
      // The dashboard must never be advertised to a crawler.
      expect(res.text).not.toContain('/app');
    });
  });
});
