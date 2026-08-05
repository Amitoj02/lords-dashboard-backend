import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { AccountDeletionStatus, MemberRole, MemberStatus } from '../src/common/enums';
import { AccountDeletionRequest } from '../src/members/entities/account-deletion-request.entity';
import { Member } from '../src/members/entities/member.entity';
import { MemberSocialLink } from '../src/members/entities/member-social-link.entity';
import { Rank } from '../src/ranks/entities/rank.entity';
import { Regiment } from '../src/regiments/entities/regiment.entity';

/**
 * E2E for T-0113: the full self-service account-deletion state machine
 * (request → confirm → execute) actually deletes the member, plus the cancel
 * off-ramp. Runs against a throwaway member so the seeded roster is untouched;
 * the JWT is minted directly (the flow only needs a valid identity `sub`).
 */
const fakeDiscord = {
  buildAuthorizeUrl: (state: string) => `https://discord.com/oauth2/authorize?state=${state}`,
  exchangeCode: jest.fn(),
  fetchUser: jest.fn(),
  buildAvatarUrl: () => null,
};

const DISCORD_ID_A = '900900900900900801';
const DISCORD_ID_B = '900900900900900802';

describe('Account deletion (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwt: JwtService;
  let regimentId: string;
  let rankId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  // Track created rows so cleanup works even after the identity is hard-deleted
  // (which leaves a de-linked soft-deleted member unreachable via discordUserId).
  const createdMemberIds: string[] = [];
  const createdIdentityIds: string[] = [];

  async function createMember(discordUserId: string): Promise<{ member: Member; token: string }> {
    const identity = await dataSource.getRepository(DiscordIdentity).save(
      dataSource.getRepository(DiscordIdentity).create({
        discordUserId,
        discordTag: `@del_${discordUserId}`,
        discordUsername: `del_${discordUserId}`,
        email: 'delete-me@example.com',
        accessToken: 'at',
        refreshToken: 'rt',
      }),
    );
    const member = await dataSource.getRepository(Member).save(
      dataSource.getRepository(Member).create({
        regimentId,
        rankId,
        discordIdentityId: identity.id,
        inGameName: `Deletion Test ${discordUserId.slice(-3)}`,
        role: MemberRole.Member,
        status: MemberStatus.Active,
        discordLinked: true,
      }),
    );
    createdIdentityIds.push(identity.id);
    createdMemberIds.push(member.id);
    const token = await jwt.signAsync({ sub: identity.id });
    return { member, token };
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
    const rank = await dataSource.getRepository(Rank).findOne({ where: { regimentId } });
    rankId = rank!.id;

    // Clean any leftovers from a prior interrupted run.
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    const memberRepo = dataSource.getRepository(Member);
    const identityRepo = dataSource.getRepository(DiscordIdentity);
    const delRepo = dataSource.getRepository(AccountDeletionRequest);
    // Rows created this run (tracked ids survive an identity hard-delete).
    for (const memberId of createdMemberIds) {
      await delRepo.delete({ memberId });
      await memberRepo.delete({ id: memberId });
    }
    for (const identityId of createdIdentityIds) {
      await identityRepo.delete({ id: identityId });
    }
    createdMemberIds.length = 0;
    createdIdentityIds.length = 0;
    // Belt-and-suspenders for a crashed prior run: drop any leftover identities.
    for (const discordUserId of [DISCORD_ID_A, DISCORD_ID_B]) {
      const identity = await identityRepo.findOne({ where: { discordUserId } });
      if (!identity) continue;
      const members = await memberRepo.find({
        where: { discordIdentityId: identity.id },
        withDeleted: true,
      });
      for (const m of members) {
        await delRepo.delete({ memberId: m.id });
        await memberRepo.delete({ id: m.id });
      }
      await identityRepo.delete({ id: identity.id });
    }
  }

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('cancel: a member can back out of a pending/confirmed request without being deleted', async () => {
    const { member, token } = await createMember(DISCORD_ID_A);

    await request(app.getHttpServer())
      .post('/api/members/me/deletion-request')
      .set(bearer(token))
      .send({ acknowledgePermanent: true, acknowledgeDataDownloaded: true })
      .expect(201);

    const cancelled = await request(app.getHttpServer())
      .post('/api/members/me/deletion-request/cancel')
      .set(bearer(token))
      .expect(200);
    expect(cancelled.body.status).toBe(AccountDeletionStatus.Cancelled);

    // The member is still live on the roster.
    const still = await dataSource.getRepository(Member).findOne({ where: { id: member.id } });
    expect(still).toBeTruthy();
    expect(still?.inGameName).toBe(member.inGameName);
  });

  it('request → confirm → execute soft-deletes and anonymises the member', async () => {
    const { member, token } = await createMember(DISCORD_ID_B);

    // Self-published profile data (T-0216), set up so the erasure can be shown
    // to reach it. The bio is the member's own words and the social links are
    // their accounts on OTHER services — the strongest cross-site identifier on
    // the row — and both are published on a crawlable page.
    await request(app.getHttpServer())
      .patch(`/api/members/${member.id}`)
      .set(bearer(token))
      .send({ bio: 'Holds the line.', socialLinks: [{ platform: 'twitch', handle: 'LordPanda' }] })
      .expect(200);
    expect(
      await dataSource.getRepository(MemberSocialLink).count({ where: { memberId: member.id } }),
    ).toBe(1);

    const req = await request(app.getHttpServer())
      .post('/api/members/me/deletion-request')
      .set(bearer(token))
      .send({ acknowledgePermanent: true, acknowledgeDataDownloaded: true })
      .expect(201);
    const confirmToken = req.body.confirmToken as string;
    expect(confirmToken).toEqual(expect.any(String));

    const confirmed = await request(app.getHttpServer())
      .post('/api/members/me/deletion-request/confirm')
      .set(bearer(token))
      .send({ token: confirmToken })
      .expect(200);
    expect(confirmed.body.status).toBe(AccountDeletionStatus.Confirmed);

    const executed = await request(app.getHttpServer())
      .post('/api/members/me/deletion-request/execute')
      .set(bearer(token))
      .expect(200);
    expect(executed.body.status).toBe(AccountDeletionStatus.Executed);

    // No longer visible to normal reads (soft-deleted).
    const live = await dataSource.getRepository(Member).findOne({ where: { id: member.id } });
    expect(live).toBeNull();

    // The row survives with deletedAt set + PII anonymised.
    const deleted = await dataSource.getRepository(Member).findOne({
      where: { id: member.id },
      withDeleted: true,
      relations: { discordIdentity: true },
    });
    expect(deleted?.deletedAt).toBeTruthy();
    expect(deleted?.inGameName).toBe('[deleted member]');
    expect(deleted?.avatarUrl).toBeNull();
    expect(deleted?.bio).toBeNull();

    // `member_social_links` carries ON DELETE CASCADE, but the member row above
    // is SOFT-deleted, so the constraint never fires: the erasure path has to
    // remove these rows itself. Asserted against the real table rather than a
    // mocked manager, because the whole failure mode is a cascade that looks
    // like it covers this and does not.
    expect(
      await dataSource.getRepository(MemberSocialLink).count({ where: { memberId: member.id } }),
    ).toBe(0);

    // The Discord identity (where the PII lives) is hard-deleted — durable erasure
    // that a later sign-in cannot silently repopulate. The member is de-linked.
    const identity = await dataSource
      .getRepository(DiscordIdentity)
      .findOne({ where: { discordUserId: DISCORD_ID_B } });
    expect(identity).toBeNull();
    expect(deleted?.discordIdentityId).toBeNull();
  });
});
