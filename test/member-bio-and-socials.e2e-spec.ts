import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { MemberRole, MemberStatus } from '../src/common/enums';
import { Member } from '../src/members/entities/member.entity';
import { MemberSocialLink } from '../src/members/entities/member-social-link.entity';
import { OWNER_DISCORD_USER_ID } from '../src/database/seeds/seed.util';

/**
 * E2E for T-0216: the member bio and social links, over real HTTP and a real
 * database.
 *
 * The unit specs already cover the registry, the DTO projections and the
 * service semantics. What only an e2e can prove is the part that spans them:
 * that a handle a member PATCHes survives the global ValidationPipe, lands in
 * `member_social_links` as a normalised handle, comes back out of the ANONYMOUS
 * projection as a URL on an origin we control, and reaches the crawler shell as
 * a `rel="nofollow ugc"` anchor. Each of those four hops is owned by a different
 * file; the contract between them is what breaks silently.
 *
 * The negative assertions carry the weight, as they do in `public-profile`: a
 * bio is member-authored free text on a page served to the whole internet and
 * cached at the edge for five minutes.
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

describe('member bio + social links (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let members: ReturnType<DataSource['getRepository']>;
  let links: ReturnType<DataSource['getRepository']>;
  let ownerId: string;
  let token: string;

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
    // The production pipe, verbatim from main.ts: `forbidNonWhitelisted` and
    // `transform` are what make @ValidateNested on socialLinks do anything, so a
    // laxer pipe here would test a shape the deployed app never sees.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    members = dataSource.getRepository(Member);
    links = dataSource.getRepository(MemberSocialLink);

    const owner = await members.findOne({
      where: { role: MemberRole.Owner },
      order: { createdAt: 'ASC' },
    });
    ownerId = (owner as Member).id;
    await members.update(ownerId, { username: 'panda', status: MemberStatus.Active });

    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/api/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await agent
      .get(`/api/auth/discord/callback?code=fake-code&state=${state}`)
      .expect(302);
    token = new URLSearchParams(new URL(cb.headers.location).hash.replace(/^#/, '')).get(
      'token',
    ) as string;
  });

  afterAll(async () => {
    // This suite shares one database with the others and mutates a row they
    // read, so it puts the owner back the way it found them.
    await links.delete({ memberId: ownerId });
    await members.update(ownerId, { bio: null });
    await app.close();
  });

  function patch(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/members/${ownerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('stores the bio trimmed and publishes it on the anonymous profile', async () => {
    const res = await patch({ bio: '  Line infantry since 1812.  ' }).expect(200);

    expect(res.body.bio).toBe('Line infantry since 1812.');

    const anon = await request(app.getHttpServer()).get('/api/public/members/@panda').expect(200);
    expect(anon.body.bio).toBe('Line infantry since 1812.');
  });

  it('folds a whitespace-only bio to NULL, so blank has one representation', async () => {
    const res = await patch({ bio: '   ' }).expect(200);

    expect(res.body.bio).toBeNull();
    const row = (await members.findOne({ where: { id: ownerId } })) as Member;
    expect(row.bio).toBeNull();
  });

  it('refuses a bio past the 280-character product cap', async () => {
    await patch({ bio: 'x'.repeat(281) }).expect(400);
  });

  it('normalises handles on the way in and builds every URL server-side', async () => {
    const res = await patch({
      socialLinks: [
        { platform: 'medal', handle: 'lord-panda' },
        { platform: 'twitch', handle: '  @LordPanda/ ' },
        { platform: 'steam', handle: '76561198000000000' },
      ],
    }).expect(200);

    // Registry display order, not the order the member submitted them.
    expect(res.body.socialLinks).toEqual([
      {
        platform: 'twitch',
        label: 'Twitch',
        // Case PRESERVED; the `@` and the trailing `/` are paste artefacts and
        // are never stored.
        handle: 'LordPanda',
        url: 'https://www.twitch.tv/LordPanda',
      },
      {
        platform: 'steam',
        label: 'Steam',
        handle: '76561198000000000',
        // The steamID64 branch — a different PATH on the same hardcoded origin.
        url: 'https://steamcommunity.com/profiles/76561198000000000',
      },
      {
        platform: 'medal',
        label: 'Medal.tv',
        handle: 'lord-panda',
        url: 'https://medal.tv/u/lord-panda',
      },
    ]);

    const stored = await links.find({ where: { memberId: ownerId } });
    expect(stored.map((l) => l.handle).sort()).toEqual([
      '76561198000000000',
      'LordPanda',
      'lord-panda',
    ]);
  });

  it('replaces the whole set, so a member can take an account back down', async () => {
    await patch({ socialLinks: [{ platform: 'x', handle: 'panda' }] }).expect(200);

    const stored = await links.find({ where: { memberId: ownerId } });
    expect(stored).toHaveLength(1);
    expect(stored[0].platform).toBe('x');

    await patch({ socialLinks: [] }).expect(200);
    expect(await links.count({ where: { memberId: ownerId } })).toBe(0);
  });

  it('rejects a handle its platform refuses, naming the platform, writing nothing', async () => {
    await patch({ socialLinks: [{ platform: 'twitch', handle: 'panda' }] }).expect(200);

    // 'ab' is under Twitch's 4-character floor.
    const res = await patch({
      socialLinks: [
        { platform: 'twitch', handle: 'ab' },
        { platform: 'medal', handle: 'valid-handle' },
      ],
    }).expect(400);
    expect(res.body.message).toContain('Twitch');

    // The valid half of the payload must not have landed, and the previously
    // published set must be untouched — a rejected PATCH is not a partial one.
    const stored = await links.find({ where: { memberId: ownerId } });
    expect(stored).toHaveLength(1);
    expect(stored[0].handle).toBe('panda');
  });

  it('rejects two accounts on one platform rather than guessing which is "the" one', async () => {
    const res = await patch({
      socialLinks: [
        { platform: 'twitch', handle: 'pandaone' },
        { platform: 'twitch', handle: 'pandatwo' },
      ],
    }).expect(400);

    expect(res.body.message).toContain('Twitch');
  });

  it('rejects a platform outside the registry at the pipe, before the service sees it', async () => {
    await patch({ socialLinks: [{ platform: 'myspace', handle: 'panda' }] }).expect(400);
    // Discord is deliberately NOT a member-editable social link: it is the
    // signed-in identity, not a self-published handle.
    await patch({ socialLinks: [{ platform: 'discord', handle: 'panda' }] }).expect(400);
  });

  it('cannot be pointed at a host we do not control, whatever the member types', async () => {
    for (const handle of [
      '//evil.example.com',
      'https://evil.example.com',
      'javascript:alert(1)',
      'a/../../evil.example.com',
      'a?next=https://evil.example.com',
      'a#@evil.example.com',
    ]) {
      await patch({ socialLinks: [{ platform: 'twitch', handle }] }).expect(400);
    }
  });

  it('serves bio and links to the crawler shell, with rel="nofollow ugc"', async () => {
    await patch({
      bio: 'Holds the line at Vaubecourt.',
      socialLinks: [{ platform: 'twitch', handle: 'LordPanda' }],
    }).expect(200);

    const res = await request(app.getHttpServer()).get('/api/seo/u/@panda').expect(200);

    expect(res.text).toContain('Holds the line at Vaubecourt.');
    expect(res.text).toContain('Elsewhere');
    expect(res.text).toContain('href="https://www.twitch.tv/LordPanda"');
    expect(res.text).toContain('rel="nofollow ugc"');
  });
});
