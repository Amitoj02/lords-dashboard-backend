import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { RolePermission } from '../src/authz/entities/role-permission.entity';
import { MemberRole } from '../src/common/enums';
import { RegimentEvent } from '../src/events/entities/event.entity';
import { GalleryItem } from '../src/gallery/entities/gallery-item.entity';
import { Member } from '../src/members/entities/member.entity';
import { Notification } from '../src/notifications/entities/notification.entity';

/**
 * End-to-end coverage of the POST-MVP feature modules against a real MySQL
 * schema: events (RSVP + public redaction + reveal gating + audit), gallery
 * (submit → moderate → public visibility + like idempotency), notifications
 * (per-member unread state), audit read (detail + CSV export + capability gate),
 * and settings (permission-matrix floor guard + a live matrix edit changing a
 * CapabilitiesGuard decision). Discord is faked so the sign-in flow runs offline.
 * Every row the spec creates is cleaned up in afterAll so it is safe to re-run.
 */
const APPLICANT_DISCORD_ID = '900900900900900902';

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

describe('Post-MVP feature modules (e2e)', () => {
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
    username: 'e2e_postmvp_applicant',
    global_name: 'PostMVP Applicant',
    discriminator: '0',
    avatar: null,
    email: 'postmvp@example.com',
  };

  let ownerToken: string;
  let applicantToken: string;

  // Rows created during the run, torn down in afterAll.
  let eventId: string | undefined;
  let galleryId: string | undefined;
  let notificationId: string | undefined;

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
    await cleanupApplicant();

    ownerToken = (await signIn(ownerProfile)).token;
    applicantToken = (await signIn(applicantProfile)).token;
  });

  afterAll(async () => {
    // Revert the live permission grant so the seeded matrix is unchanged.
    await dataSource
      .getRepository(RolePermission)
      .update(
        { role: MemberRole.Applicant, capability: 'view_members_directory' },
        { granted: false },
      );
    if (eventId) await dataSource.getRepository(RegimentEvent).delete(eventId);
    if (galleryId) await dataSource.getRepository(GalleryItem).delete(galleryId);
    if (notificationId) await dataSource.getRepository(Notification).delete(notificationId);
    await cleanupApplicant();
    await app.close();
  });

  async function cleanupApplicant(): Promise<void> {
    const identity = await dataSource
      .getRepository(DiscordIdentity)
      .findOne({ where: { discordUserId: APPLICANT_DISCORD_ID } });
    if (identity) {
      await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
      await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
    }
  }

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
  const server = () => app.getHttpServer();

  // ── Settings + permission matrix (T-0019) ──────────────────────────────────
  describe('settings + permission matrix', () => {
    it('exposes the settings panel and the authorization matrix to the owner', async () => {
      const settings = await request(server())
        .get('/api/settings')
        .set(bearer(ownerToken))
        .expect(200);
      expect(settings.body).toHaveProperty('publicEvents');
      expect(settings.body).toHaveProperty('galleryMaxImageSizeMb');

      const matrix = await request(server())
        .get('/api/settings/permissions')
        .set(bearer(ownerToken))
        .expect(200);
      expect(matrix.body.matrix.Owner.manage_settings).toBe(true);
    });

    it('rejects a matrix edit that would strip the Owner of a core capability (floor guard)', async () => {
      await request(server())
        .patch('/api/settings/permissions')
        .set(bearer(ownerToken))
        .send({
          changes: [{ role: 'Owner', capability: 'manage_settings', granted: false }],
        })
        .expect(403);
    });

    it('a live matrix edit immediately changes a CapabilitiesGuard decision', async () => {
      // Baseline: an identity-only applicant cannot read the roster.
      await request(server()).get('/api/members').set(bearer(applicantToken)).expect(403);

      // Owner grants the Applicant role the directory capability.
      await request(server())
        .patch('/api/settings/permissions')
        .set(bearer(ownerToken))
        .send({
          changes: [{ role: 'Applicant', capability: 'view_members_directory', granted: true }],
        })
        .expect(200);

      // The SAME applicant token now passes the guard (cache invalidated live).
      await request(server()).get('/api/members').set(bearer(applicantToken)).expect(200);
    });
  });

  // ── Events (T-0015) ────────────────────────────────────────────────────────
  describe('events: create, public redaction, RSVP + reveal gating, audit', () => {
    const PASSWORD = 'holdfast-e2e-secret';

    it('creates a published event without leaking the server password', async () => {
      const created = await request(server())
        .post('/api/events')
        .set(bearer(ownerToken))
        .send({
          title: 'E2E Line Battle',
          startsAt: '2099-01-01T20:00:00.000Z',
          serverName: 'HF | E2E Server',
          serverRegion: 'EU',
          serverPassword: PASSWORD,
          platforms: ['steam'],
          tags: ['e2e'],
          isDraft: false,
        })
        .expect(201);
      eventId = created.body.id as string;
      expect(created.body.serverName).toBe('HF | E2E Server'); // member view
      expect(created.body).not.toHaveProperty('serverPassword'); // never projected
    });

    it('redacts server binding + password on the public feed', async () => {
      const list = await request(server()).get('/api/events').expect(200); // @Public
      const mine = list.body.data.find((e: { id: string }) => e.id === eventId);
      expect(mine).toBeDefined();
      expect(mine.serverPassword).toBeUndefined();
      expect(mine.serverName).toBeUndefined();
    });

    it('gates password reveal on an RSVP, then returns the decrypted password + audits it', async () => {
      // No RSVP yet → reveal is forbidden.
      await request(server())
        .post(`/api/events/${eventId}/reveal-password`)
        .set(bearer(ownerToken))
        .expect(403);

      await request(server())
        .post(`/api/events/${eventId}/rsvp`)
        .set(bearer(ownerToken))
        .send({ status: 'interested' })
        .expect(200);

      const revealed = await request(server())
        .post(`/api/events/${eventId}/reveal-password`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(revealed.body.serverPassword).toBe(PASSWORD);

      const audit = await request(server())
        .get('/api/audit?action=event.password.reveal&limit=5')
        .set(bearer(ownerToken))
        .expect(200);
      expect(audit.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Gallery (T-0016) ───────────────────────────────────────────────────────
  describe('gallery: submit → moderate → public visibility + like idempotency', () => {
    it('a submission enters moderation and is not publicly visible until approved', async () => {
      const submitted = await request(server())
        .post('/api/gallery')
        .set(bearer(ownerToken))
        .send({
          title: 'E2E Screenshot',
          type: 'image',
          files: [{ fileName: 'shot.png', mediaType: 'image', sizeBytes: '2048' }],
        })
        .expect(201);
      galleryId = submitted.body.id as string;
      expect(submitted.body.status).toBe('pending');

      const queue = await request(server())
        .get('/api/gallery/moderation/queue')
        .set(bearer(ownerToken))
        .expect(200);
      expect(queue.body.data.some((g: { id: string }) => g.id === galleryId)).toBe(true);

      const publicBefore = await request(server()).get('/api/gallery').expect(200);
      expect(publicBefore.body.data.some((g: { id: string }) => g.id === galleryId)).toBe(false);
    });

    it('approval makes it public; likes are idempotent', async () => {
      await request(server())
        .post(`/api/gallery/${galleryId}/approve`)
        .set(bearer(ownerToken))
        .expect(200);

      const publicAfter = await request(server()).get('/api/gallery').expect(200);
      expect(publicAfter.body.data.some((g: { id: string }) => g.id === galleryId)).toBe(true);

      const first = await request(server())
        .post(`/api/gallery/${galleryId}/like`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(first.body).toEqual({ likesCount: 1, liked: true });

      const second = await request(server())
        .post(`/api/gallery/${galleryId}/like`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(second.body.likesCount).toBe(1); // idempotent
    });
  });

  // ── Notifications (T-0018) ─────────────────────────────────────────────────
  describe('notifications: compose + per-member unread state', () => {
    it('composing raises the unread count and marking read clears it', async () => {
      const before = await request(server())
        .get('/api/notifications/unread-count')
        .set(bearer(ownerToken))
        .expect(200);
      const baseline = before.body.count as number;

      const created = await request(server())
        .post('/api/notifications')
        .set(bearer(ownerToken))
        .send({ title: 'E2E Dispatch', body: 'Muster at 1900.' })
        .expect(201);
      notificationId = created.body.id as string;

      const afterCompose = await request(server())
        .get('/api/notifications/unread-count')
        .set(bearer(ownerToken))
        .expect(200);
      expect(afterCompose.body.count).toBe(baseline + 1);

      await request(server())
        .post(`/api/notifications/${notificationId}/read`)
        .set(bearer(ownerToken))
        .expect(200);

      const afterRead = await request(server())
        .get('/api/notifications/unread-count')
        .set(bearer(ownerToken))
        .expect(200);
      expect(afterRead.body.count).toBe(baseline);
    });
  });

  // ── Audit read (T-0017) ────────────────────────────────────────────────────
  describe('audit read: detail + CSV export are capability-gated', () => {
    it('serves entry detail and a CSV export to an authorized reader', async () => {
      const list = await request(server())
        .get('/api/audit?limit=1')
        .set(bearer(ownerToken))
        .expect(200);
      const entryId = list.body.data[0].id as string;

      const detail = await request(server())
        .get(`/api/audit/${entryId}`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(detail.body.id).toBe(entryId);

      const csv = await request(server())
        .get('/api/audit/export')
        .set(bearer(ownerToken))
        .expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.split('\n')[0]).toContain('occurredAt,action,severity');
    });

    it('denies the audit ledger + export to a caller without view_audit_log', async () => {
      await request(server()).get('/api/audit').set(bearer(applicantToken)).expect(403);
      await request(server()).get('/api/audit/export').set(bearer(applicantToken)).expect(403);
    });
  });
});
