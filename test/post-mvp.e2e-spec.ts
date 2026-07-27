import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DiscordOAuthService } from '../src/auth/discord-oauth.service';
import { DiscordIdentity } from '../src/auth/entities/discord-identity.entity';
import { Application } from '../src/applications/entities/application.entity';
import { RolePermission } from '../src/authz/entities/role-permission.entity';
import { MemberRole } from '../src/common/enums';
import { RegimentEvent } from '../src/events/entities/event.entity';
import { GalleryItem } from '../src/gallery/entities/gallery-item.entity';
import { Member } from '../src/members/entities/member.entity';
import { RegimentDocument } from '../src/regiments/entities/regiment-document.entity';
import { PROTECTED_RANK_NAMES } from '../src/ranks/protected-ranks';

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
    scope: 'identify email',
  }),
  fetchUser: jest.fn().mockImplementation(() => Promise.resolve(currentProfile)),
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
    // Revert every live permission grant this spec makes, so the seeded matrix
    // is unchanged and the suite stays re-runnable.
    for (const capability of ['view_members_directory', 'manage_regiment_details']) {
      await dataSource
        .getRepository(RolePermission)
        .update({ role: MemberRole.Applicant, capability }, { granted: false });
    }
    if (eventId) await dataSource.getRepository(RegimentEvent).delete(eventId);
    if (galleryId) await dataSource.getRepository(GalleryItem).delete(galleryId);
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
    // Token + isMember are in the URL fragment now (LDA-H4), not the query string.
    const frag = new URLSearchParams(redirect.hash.replace(/^#/, ''));
    return {
      token: frag.get('token') as string,
      isMember: frag.get('isMember') === 'true',
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

    // ── T-0178: the settings capability gating, pinned ───────────────────────
    // The bug report ("settings reachable without manage_settings") turned out
    // to be frontend-only — every /settings route already carries
    // @RequireCapability. These cases exist so a future refactor that drops one
    // fails here instead of silently exposing the control panel.
    it('T-0178: 403s a caller without manage_settings on every control-panel route', async () => {
      await request(server()).get('/api/settings').set(bearer(applicantToken)).expect(403);
      await request(server())
        .patch('/api/settings')
        .set(bearer(applicantToken))
        .send({ publicGallery: false })
        .expect(403);
      await request(server())
        .get('/api/settings/permissions')
        .set(bearer(applicantToken))
        .expect(403);
      await request(server())
        .patch('/api/settings/permissions')
        .set(bearer(applicantToken))
        .send({ changes: [{ role: 'Applicant', capability: 'manage_settings', granted: true }] })
        .expect(403);
      // The one route that is not obviously a settings write: completing setup
      // flips first-run routing for the whole regiment.
      await request(server())
        .post('/api/settings/complete-setup')
        .set(bearer(applicantToken))
        .expect(403);
    });

    it('T-0178: 403s a caller without manage_settings on the Discord bot settings', async () => {
      // Same control panel, different module: the bot configuration carries the
      // ban-role and channel wiring, so it must not fall outside the
      // manage_settings perimeter just because it lives under /api/discord.
      await request(server()).get('/api/discord/settings').set(bearer(applicantToken)).expect(403);
      await request(server())
        .patch('/api/discord/settings')
        .set(bearer(applicantToken))
        .send({ botEnabled: false })
        .expect(403);
    });

    it('T-0178: manage_regiment_details grants presentation + legal ONLY, never settings', async () => {
      // The whole point of the T-0145 split: publishing rights are delegable
      // without handing over the control panel. Grant the Applicant role just
      // the publishing capability and prove the boundary holds in both
      // directions. Reverted at the end of the case, and again in afterAll.
      const permissions = dataSource.getRepository(RolePermission);
      await request(server())
        .patch('/api/settings/permissions')
        .set(bearer(ownerToken))
        .send({
          changes: [{ role: 'Applicant', capability: 'manage_regiment_details', granted: true }],
        })
        .expect(200);

      try {
        // Granted: read + write presentation, read + write legal documents.
        await request(server())
          .get('/api/settings/presentation')
          .set(bearer(applicantToken))
          .expect(200);
        await request(server())
          .patch('/api/settings/presentation')
          .set(bearer(applicantToken))
          .send({ loginQuote: 'Delegated copy.' })
          .expect(200);
        await request(server())
          .get('/api/settings/documents')
          .set(bearer(applicantToken))
          .expect(200);
        await request(server())
          .put('/api/settings/documents/guidelines')
          .set(bearer(applicantToken))
          .send({ body: '# Delegated' })
          .expect(200);

        // NOT granted: anything behind manage_settings.
        await request(server()).get('/api/settings').set(bearer(applicantToken)).expect(403);
        await request(server())
          .patch('/api/settings')
          .set(bearer(applicantToken))
          .send({ publicGallery: false })
          .expect(403);
        await request(server())
          .get('/api/settings/permissions')
          .set(bearer(applicantToken))
          .expect(403);
      } finally {
        await request(server())
          .patch('/api/settings/permissions')
          .set(bearer(ownerToken))
          .send({
            changes: [{ role: 'Applicant', capability: 'manage_regiment_details', granted: false }],
          })
          .expect(200);
        // Belt and braces: the guard reads the row, so make sure it is off even
        // if the request above failed for an unrelated reason.
        await permissions.update(
          { role: MemberRole.Applicant, capability: 'manage_regiment_details' },
          { granted: false },
        );
      }

      // Restore the presentation/legal state the earlier cases in this file rely on.
      await request(server())
        .patch('/api/settings/presentation')
        .set(bearer(ownerToken))
        .send({ loginQuote: null })
        .expect(200);
      await request(server())
        .put('/api/settings/documents/guidelines')
        .set(bearer(ownerToken))
        .send({ body: '' })
        .expect(200);
    });

    it('T-0178/T-0170: transfer_ownership is gone from the matrix and unsettable', async () => {
      const matrix = await request(server())
        .get('/api/settings/permissions')
        .set(bearer(ownerToken))
        .expect(200);
      // The capability axis is derived from the enum, so the retirement is only
      // real if the row is actually absent here.
      expect(matrix.body.capabilities).not.toContain('transfer_ownership');
      expect(matrix.body.matrix.Owner).not.toHaveProperty('transfer_ownership');

      await request(server())
        .patch('/api/settings/permissions')
        .set(bearer(ownerToken))
        .send({ changes: [{ role: 'Owner', capability: 'transfer_ownership', granted: true }] })
        .expect(400);

      // Both retired endpoints are 404, not 403 — the routes no longer exist.
      await request(server())
        .post('/api/settings/transfer-ownership')
        .set(bearer(ownerToken))
        .send({ toMemberId: 'aaaaaaaaaaaa', confirm: true })
        .expect(404);
      await request(server())
        .post('/api/settings/transfer-discord')
        .set(bearer(ownerToken))
        .send({ discordServerId: '123456789012345678' })
        .expect(404);
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

  // ── Public presentation + legal documents (T-0145/0147/0148/0149) ──────────
  describe('regiment presentation + legal documents', () => {
    it('grants the new manage_regiment_details capability to the Owner by default', async () => {
      const matrix = await request(server())
        .get('/api/settings/permissions')
        .set(bearer(ownerToken))
        .expect(200);

      // The capability axis is derived from the enum, so a new member shows up
      // here automatically — this pins the DEFAULT GRANT, which is not derived.
      expect(matrix.body.capabilities).toContain('manage_regiment_details');
      expect(matrix.body.matrix.Owner.manage_regiment_details).toBe(true);
      expect(matrix.body.matrix.Member.manage_regiment_details).toBe(false);
    });

    it('exposes presign policy for the three new upload targets', async () => {
      const res = await request(server())
        .get('/api/storage/policy')
        .set(bearer(ownerToken))
        .expect(200);
      const byTarget = Object.fromEntries(
        res.body.targets.map((t: { target: string }) => [t.target, t]),
      );

      expect(byTarget['regiment-hero-banner'].maxImageMb).toBe(12);
      expect(byTarget['regiment-login-banner'].maxImageMb).toBe(12);
      expect(byTarget['gallery-poster'].maxImageMb).toBe(4);
      // Backgrounds take the raster set, NOT the icon set: an SVG background is
      // rendered through a CSS url(), which is not the <img> secure-static mode
      // that makes SVG safe for rank/medal icons.
      expect(byTarget['regiment-hero-banner'].acceptedMimeTypes).not.toContain('image/svg+xml');
    });

    it('round-trips the presentation fields and publishes them ANONYMOUSLY', async () => {
      await request(server())
        .patch('/api/settings/presentation')
        .set(bearer(ownerToken))
        .send({
          charterQuote: 'Hold the line.',
          charterQuoteAttribution: 'The Charter',
          heroOverlayDensity: 0,
        })
        .expect(200);

      // The landing AND sign-in pages are both logged-out surfaces, so this has
      // to be readable with no token at all.
      const profile = await request(server()).get('/api/regiment').expect(200);
      expect(profile.body.presentation.charterQuote).toBe('Hold the line.');
      expect(profile.body.presentation.charterQuoteAttribution).toBe('The Charter');
      // 0 is a meaningful density; a truthiness projection would drop it to null
      // and the client would silently re-apply the stylesheet default.
      expect(profile.body.presentation.heroOverlayDensity).toBe(0);
    });

    it('rejects an out-of-range overlay density and an over-long quote', async () => {
      await request(server())
        .patch('/api/settings/presentation')
        .set(bearer(ownerToken))
        .send({ heroOverlayDensity: 101 })
        .expect(400);

      await request(server())
        .patch('/api/settings/presentation')
        .set(bearer(ownerToken))
        .send({ charterQuote: 'x'.repeat(501) })
        .expect(400);
    });

    it('rejects a banner key from another target’s namespace', async () => {
      await request(server())
        .patch('/api/settings/presentation')
        .set(bearer(ownerToken))
        .send({
          heroBannerKey: 'gallery/regiment-1/member-1/00000000-0000-0000-0000-000000000000.png',
        })
        .expect(400);
    });

    it('serves all three legal documents anonymously, unset until edited', async () => {
      // The e2e database persists across runs and earlier cases in this file
      // write documents, so clear the table first: the contract under test is
      // "never edited ⇒ null", which is only observable from a clean slate.
      await dataSource.getRepository(RegimentDocument).createQueryBuilder().delete().execute();

      const before = await request(server()).get('/api/regiment/documents').expect(200);
      expect(before.body.map((d: { slug: string }) => d.slug)).toEqual([
        'terms',
        'privacy',
        'guidelines',
      ]);
      // Never-edited is `null`, not an error and not an empty page: the client
      // renders its shipped fallback, so a live site always has a privacy policy.
      expect(before.body.every((d: { body: string | null }) => d.body === null)).toBe(true);

      await request(server())
        .put('/api/settings/documents/privacy')
        .set(bearer(ownerToken))
        .send({ body: '# Privacy\n\nWe keep your Discord id.' })
        .expect(200);

      const after = await request(server()).get('/api/regiment/documents').expect(200);
      const privacy = after.body.find((d: { slug: string }) => d.slug === 'privacy');
      expect(privacy.body).toContain('We keep your Discord id.');
      // The anonymous projection must not carry edit attribution.
      expect(privacy).not.toHaveProperty('updatedByName');
    });

    it('stores hostile markup verbatim — the renderer, not the API, is the XSS boundary', async () => {
      await request(server())
        .put('/api/settings/documents/terms')
        .set(bearer(ownerToken))
        .send({ body: '<script>alert(1)</script>' })
        .expect(200);

      // The API deliberately does NOT strip: the document is Markdown, and the
      // SPA's escape-first renderer is what makes it inert. Asserting the raw
      // round-trip here keeps that contract explicit rather than accidental.
      const docs = await request(server()).get('/api/regiment/documents').expect(200);
      const terms = docs.body.find((d: { slug: string }) => d.slug === 'terms');
      expect(terms.body).toBe('<script>alert(1)</script>');
    });

    it('clears a document back to the shipped fallback when saved blank', async () => {
      await request(server())
        .put('/api/settings/documents/guidelines')
        .set(bearer(ownerToken))
        .send({ body: '   ' })
        .expect(200);

      const docs = await request(server()).get('/api/regiment/documents').expect(200);
      const guidelines = docs.body.find((d: { slug: string }) => d.slug === 'guidelines');
      expect(guidelines.body).toBeNull();
    });

    it('rejects an unknown document slug', async () => {
      await request(server())
        .put('/api/settings/documents/refunds')
        .set(bearer(ownerToken))
        .send({ body: 'x' })
        .expect(400);
    });

    it('403s a caller without manage_regiment_details on every route (T-0178)', async () => {
      await request(server())
        .get('/api/settings/presentation')
        .set(bearer(applicantToken))
        .expect(403);
      await request(server())
        .patch('/api/settings/presentation')
        .set(bearer(applicantToken))
        .send({ charterQuote: 'nope' })
        .expect(403);
      // The admin documents READ is gated too, not just the write: it carries
      // edit attribution (who last saved each doc), which the anonymous
      // /api/regiment/documents projection deliberately withholds.
      await request(server())
        .get('/api/settings/documents')
        .set(bearer(applicantToken))
        .expect(403);
      await request(server())
        .put('/api/settings/documents/terms')
        .set(bearer(applicantToken))
        .send({ body: 'nope' })
        .expect(403);
    });
  });

  // ── Storage upload policy (T-0119) ─────────────────────────────────────────
  describe('storage policy: per-target caps + accepted types for client hints', () => {
    it('exposes each target’s size caps and accepted types to an authenticated caller', async () => {
      const res = await request(server())
        .get('/api/storage/policy')
        .set(bearer(ownerToken))
        .expect(200);

      expect(typeof res.body.maxUploadMb).toBe('number');
      expect(res.body.image.extensions).toEqual(['png', 'jpg', 'webp']);
      const byTarget = Object.fromEntries(
        res.body.targets.map((t: { target: string }) => [t.target, t]),
      );
      expect(byTarget['member-avatar'].maxImageMb).toBe(8);
      expect(byTarget['member-banner'].maxImageMb).toBe(12);
      expect(byTarget['event-banner'].maxImageMb).toBe(12);
      expect(byTarget['gallery'].maxVideoMb).toBe(80);
      // Icon targets accept PNG (T-0124) + WebP (T-0130); jpeg excluded, and SVG
      // was dropped for security (LDA-M3).
      expect(byTarget['rank-image'].acceptedExtensions).toEqual(['png', 'webp']);
      expect(byTarget['medal-image'].acceptedMimeTypes).toEqual(['image/png', 'image/webp']);
      expect(byTarget['rank-image'].acceptedMimeTypes).not.toContain('image/jpeg');
      expect(byTarget['rank-image'].acceptedMimeTypes).not.toContain('image/svg+xml');
      // Non-icon image targets keep the raster set.
      expect(byTarget['member-avatar'].acceptedExtensions).toEqual(['png', 'jpg', 'webp']);
    });

    it('rejects an unauthenticated caller', async () => {
      await request(server()).get('/api/storage/policy').expect(401);
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
        })
        .expect(201);
      eventId = created.body.id as string;
      expect(created.body.serverName).toBe('HF | E2E Server'); // member view
      expect(created.body).not.toHaveProperty('serverPassword'); // never projected
    });

    it('has no save-as-draft publish route (T-0072): POST /:id/publish is 404', async () => {
      await request(server())
        .post(`/api/events/${eventId}/publish`)
        .set(bearer(ownerToken))
        .expect(404);
    });

    it('serves the member projection to an enrolled member and redacts it for a non-enrolled caller (T-0073)', async () => {
      // Owner is an enrolled member → server binding present, password never is.
      const memberView = await request(server())
        .get(`/api/events/mine/${eventId}`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(memberView.body.serverName).toBe('HF | E2E Server');
      expect(memberView.body).not.toHaveProperty('serverPassword');

      // An authenticated but non-enrolled caller (applicant, no memberId) gets
      // the redacted projection — no server binding, no myRsvp.
      const list = await request(server())
        .get('/api/events/mine')
        .set(bearer(applicantToken))
        .expect(200);
      const redacted = list.body.data.find((e: { id: string }) => e.id === eventId);
      expect(redacted).toBeDefined();
      expect(redacted.serverName).toBeUndefined();
      expect(redacted.myRsvp).toBeUndefined();
    });

    it('redacts server binding + password on the public feed', async () => {
      const list = await request(server()).get('/api/events').expect(200); // @Public
      const mine = list.body.data.find((e: { id: string }) => e.id === eventId);
      expect(mine).toBeDefined();
      expect(mine.serverPassword).toBeUndefined();
      expect(mine.serverName).toBeUndefined();
    });

    it('gates password reveal on an RSVP, then returns the decrypted password WITHOUT auditing it', async () => {
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

      // Capture the reveal-audit count BEFORE revealing (T-0126: reveals are no
      // longer audited, so this count must not change).
      const before = await request(server())
        .get('/api/audit?action=event.password.reveal&limit=1')
        .set(bearer(ownerToken))
        .expect(200);
      const beforeTotal = before.body.meta.total;

      const revealed = await request(server())
        .post(`/api/events/${eventId}/reveal-password`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(revealed.body.serverPassword).toBe(PASSWORD);

      const after = await request(server())
        .get('/api/audit?action=event.password.reveal&limit=1')
        .set(bearer(ownerToken))
        .expect(200);
      expect(after.body.meta.total).toBe(beforeTotal);
    });

    it('exposes the RSVP roster (name, avatar, choice) to a members-directory viewer (T-0127)', async () => {
      // The owner RSVP'd 'interested' in the prior test; the roster reflects it.
      const roster = await request(server())
        .get(`/api/events/${eventId}/rsvps`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(Array.isArray(roster.body)).toBe(true);
      const entry = roster.body.find((r: { status: string }) => r.status === 'interested');
      expect(entry).toBeDefined();
      expect(entry).toHaveProperty('memberId');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('avatarUrl');
    });

    it('hides an archived event from the public detail endpoint too (not just the list)', async () => {
      // Public detail must match the public list: an archived event 404s.
      await request(server()).get(`/api/events/${eventId}`).expect(200); // visible before
      await request(server())
        .post(`/api/events/${eventId}/archive`)
        .set(bearer(ownerToken))
        .expect(200);
      await request(server()).get(`/api/events/${eventId}`).expect(404); // hidden after
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

    it('neutralizes spreadsheet formula injection in the CSV export', async () => {
      // An event title that is a formula lands in an audit row's targetLabel.
      await request(server())
        .post('/api/events')
        .set(bearer(ownerToken))
        .send({
          title: '=HYPERLINK("http://evil","x")',
          startsAt: '2099-02-02T20:00:00.000Z',
          platforms: ['steam'],
          tags: ['e2e'],
        })
        .expect(201);

      const csv = await request(server())
        .get('/api/audit/export')
        .set(bearer(ownerToken))
        .expect(200);
      // The leading '=' is defused with a single quote so a spreadsheet treats
      // the cell as text instead of evaluating it.
      expect(csv.text).toContain(`"'=HYPERLINK`);
      expect(csv.text).not.toContain(`"=HYPERLINK`);
    });
  });

  // ── Applicant self-service + blocklist (T-0054/T-0055) ──────────────────────
  describe('applicant self-service + blocklist', () => {
    const SELF_DISCORD_ID = '900900900900900903';
    const selfProfile = {
      id: SELF_DISCORD_ID,
      username: 'e2e_selfservice_applicant',
      global_name: 'Self Service',
      discriminator: '0',
      avatar: null,
      email: 'selfservice@example.com',
    };
    const validApp = {
      applicantName: 'Self Service',
      inGameName: 'SelfService1',
      currentRegiment: 'None',
      howFound: 'e2e',
      preferredClasses: 'Line Infantry',
      skillsToImprove: 'Aim',
      interestConfirmed: true,
    };
    let selfToken: string;
    let appId: string;

    // Extra identities used by the projection-split cases below. They need the
    // same teardown as SELF_DISCORD_ID: the e2e database persists across runs, so
    // a leftover application would make the second run 409 on submit.
    const USER_MSG_DISCORD_ID = '900900900900900904';
    const NO_WIPE_DISCORD_ID = '900900900900900905';
    const AVATAR_FB_DISCORD_ID = '900900900900900906';

    const cleanupIdentity = async (discordUserId: string): Promise<void> => {
      const identity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId } });
      if (identity) {
        await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
      }
    };

    const cleanupSelf = async (): Promise<void> => {
      for (const id of [
        SELF_DISCORD_ID,
        USER_MSG_DISCORD_ID,
        NO_WIPE_DISCORD_ID,
        AVATAR_FB_DISCORD_ID,
      ]) {
        await cleanupIdentity(id);
      }
    };

    beforeAll(async () => {
      await cleanupSelf();
      selfToken = (await signIn(selfProfile)).token;
    });

    afterAll(async () => {
      await cleanupSelf();
    });

    it('GET /applications/mine returns null + not blocked before applying', async () => {
      const res = await request(server())
        .get('/api/applications/mine')
        .set(bearer(selfToken))
        .expect(200);
      expect(res.body.application).toBeNull();
      expect(res.body.blocked).toBe(false);
    });

    it('an applicant cannot read the staff queue (manage_applications)', async () => {
      await request(server()).get('/api/applications').set(bearer(selfToken)).expect(403);
    });

    it('submit → GET /mine reflects the pending application', async () => {
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(selfToken))
        .send(validApp)
        .expect(201);
      appId = created.body.id as string;

      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(selfToken))
        .expect(200);
      expect(mine.body.application.status).toBe('pending');
      expect(mine.body.application.inGameName).toBe('SelfService1');
    });

    it('PATCH /mine edits the pending application', async () => {
      const patched = await request(server())
        .patch('/api/applications/mine')
        .set(bearer(selfToken))
        .send({ inGameName: 'SelfService2' })
        .expect(200);
      expect(patched.body.inGameName).toBe('SelfService2');
    });

    it('owner blocks the applicant → app is declined, frozen, and no resubmit', async () => {
      const blocked = await request(server())
        .post(`/api/applications/${appId}/block`)
        .set(bearer(ownerToken))
        .send({ reason: 'e2e block' })
        .expect(200);
      // Blocking also declines the open application so it leaves the queue.
      expect(blocked.body.status).toBe('declined');

      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(selfToken))
        .expect(200);
      expect(mine.body.blocked).toBe(true);
      expect(mine.body.application.status).toBe('declined');

      // A blocked identity is refused a new submit AND cannot edit (re-bump).
      await request(server())
        .post('/api/applications')
        .set(bearer(selfToken))
        .send(validApp)
        .expect(403);
      await request(server())
        .patch('/api/applications/mine')
        .set(bearer(selfToken))
        .send({ inGameName: 'SneakyEdit' })
        .expect(403);
    });

    it('an applicant cannot block anyone (needs manage_applications)', async () => {
      await request(server())
        .post(`/api/applications/${appId}/block`)
        .set(bearer(selfToken))
        .send({})
        .expect(403);
    });

    // ── Staff-only fields must not reach the applicant (T-0153/T-0154/T-0155) ──
    // The unit tests mock the repository, so only a real MySQL round-trip proves
    // the projection split AND that decided_by_member_id actually survives a save.
    it('the applicant projection never carries staff-only fields, on any of its three routes', async () => {
      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(selfToken))
        .expect(200);

      // The block above already declined this application WITH a reason, so if
      // the projection leaked, these would be populated right now.
      for (const field of [
        'moderatorNote',
        'declineReason',
        'decidedByName',
        'decidedByAvatarUrl',
        'decidedByMemberId',
      ]) {
        expect(mine.body.application).not.toHaveProperty(field);
      }
    });

    it('surfaces the officer’s user message — and only that — to the applicant', async () => {
      // Fresh identity: the one above is blocked and frozen.
      const profile = { ...selfProfile, id: USER_MSG_DISCORD_ID, username: 'e2e_usermsg' };
      const token = (await signIn(profile)).token;
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(token))
        .send({ ...validApp, inGameName: 'UserMsg1' })
        .expect(201);

      // The staff console posts every box on every decision, blanks included.
      await request(server())
        .post(`/api/applications/${created.body.id}/decline`)
        .set(bearer(ownerToken))
        .send({
          reason: 'internal: too few hours',
          note: 'staff eyes only',
          discordDmMessage: 'Thanks for applying — try again after 50 hours.',
        })
        .expect(200);

      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(token))
        .expect(200);

      expect(mine.body.application.userMessage).toBe(
        'Thanks for applying — try again after 50 hours.',
      );
      expect(mine.body.application).not.toHaveProperty('moderatorNote');
      expect(mine.body.application).not.toHaveProperty('declineReason');

      // Staff still see everything, and the decision is attributed.
      const staff = await request(server())
        .get(`/api/applications/${created.body.id}`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(staff.body.moderatorNote).toBe('staff eyes only');
      expect(staff.body.declineReason).toBe('internal: too few hours');
      expect(staff.body.userMessage).toBe('Thanks for applying — try again after 50 hours.');

      // The regression the unit tests cannot see: TypeORM lets a LOADED relation
      // outrank the raw FK on save, so a naive eager-load would have written
      // decided_by_member_id = NULL on every decision. Only a real save proves it.
      expect(staff.body.decidedByMemberId).not.toBeNull();
      expect(staff.body.decidedByName).toBeTruthy();
    });

    it('attributes the decision with the officer’s Discord avatar when they uploaded none (T-0186)', async () => {
      const profile = { ...selfProfile, id: AVATAR_FB_DISCORD_ID, username: 'e2e_avatarfb' };
      const token = (await signIn(profile)).token;
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(token))
        .send({ ...validApp, inGameName: 'AvatarFb1' })
        .expect(201);

      // Pin the precondition rather than inheriting it: the officer has NO
      // uploaded avatar — members.avatar_url is only ever written by an upload,
      // so this is what almost every real officer looks like — while their
      // linked Discord identity does have one.
      const officerAvatar = 'https://cdn.discordapp.com/avatars/e2e/officer.png';
      const identities = dataSource.getRepository(DiscordIdentity);
      const ownerIdentity = await identities.findOne({
        where: { discordUserId: ownerProfile.id },
      });
      const restoreAvatar = ownerIdentity!.avatarUrl;
      await identities.update({ id: ownerIdentity!.id }, { avatarUrl: officerAvatar });
      const members = dataSource.getRepository(Member);
      await members.update({ discordIdentityId: ownerIdentity!.id }, { avatarUrl: null });

      try {
        // Three reads, three different relation loads — mocks cannot tell them
        // apart, and each one is a separate way to lose the nested identity:
        // the decision response (stampDecider), the detail read (loadOrFail) and
        // the queue page (the findAll join).
        const decided = await request(server())
          .post(`/api/applications/${created.body.id}/decline`)
          .set(bearer(ownerToken))
          .send({ reason: 'e2e avatar fallback' })
          .expect(200);
        expect(decided.body.decidedByAvatarUrl).toBe(officerAvatar);

        const detail = await request(server())
          .get(`/api/applications/${created.body.id}`)
          .set(bearer(ownerToken))
          .expect(200);
        expect(detail.body.decidedByAvatarUrl).toBe(officerAvatar);

        const queue = await request(server())
          .get('/api/applications?status=declined&limit=100')
          .set(bearer(ownerToken))
          .expect(200);
        const row = (queue.body.data as { id: string; decidedByAvatarUrl: string | null }[]).find(
          (a) => a.id === created.body.id,
        );
        expect(row?.decidedByAvatarUrl).toBe(officerAvatar);
      } finally {
        await identities.update({ id: ownerIdentity!.id }, { avatarUrl: restoreAvatar });
      }
    });

    it('a second decision with blank boxes does not wipe the stored text', async () => {
      const profile = { ...selfProfile, id: NO_WIPE_DISCORD_ID, username: 'e2e_nowipe' };
      const token = (await signIn(profile)).token;
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(token))
        .send({ ...validApp, inGameName: 'NoWipe1' })
        .expect(201);

      await request(server())
        .post(`/api/applications/${created.body.id}/hold`)
        .set(bearer(ownerToken))
        .send({ note: 'needs a reference', discordDmMessage: 'We are checking your references.' })
        .expect(200);

      // The console re-posts every field on the next action, blanks included, and
      // @IsOptional() does not strip ''. Blank must mean "not provided".
      const held = await request(server())
        .post(`/api/applications/${created.body.id}/hold`)
        .set(bearer(ownerToken))
        .send({ note: '', discordDmMessage: '' })
        .expect(200);

      expect(held.body.moderatorNote).toBe('needs a reference');
      expect(held.body.userMessage).toBe('We are checking your references.');
    });

    it('owner unblocks → applicant is no longer blocked', async () => {
      await request(server())
        .post(`/api/applications/${appId}/unblock`)
        .set(bearer(ownerToken))
        .expect(200);

      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(selfToken))
        .expect(200);
      expect(mine.body.blocked).toBe(false);
    });
  });

  // ── Mercenary track enforcement (T-0133/T-0137) ────────────────────────────
  describe('mercenary track enforcement', () => {
    const MERC_DISCORD_ID = '900900900900900904';
    const mercProfile = {
      id: MERC_DISCORD_ID,
      username: 'e2e_mercenary_applicant',
      global_name: 'Merc Candidate',
      discriminator: '0',
      avatar: null,
      email: 'mercenary@example.com',
    };
    const validApp = {
      applicantName: 'Merc Candidate',
      inGameName: 'MercCandidate1',
      currentRegiment: 'None',
      howFound: 'e2e',
      preferredClasses: 'Line Infantry',
      skillsToImprove: 'Aim',
      interestConfirmed: true,
    };
    let mercToken: string;
    let appId: string;

    const cleanupMerc = async (): Promise<void> => {
      const identity = await dataSource
        .getRepository(DiscordIdentity)
        .findOne({ where: { discordUserId: MERC_DISCORD_ID } });
      if (identity) {
        await dataSource.getRepository(Application).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(Member).delete({ discordIdentityId: identity.id });
        await dataSource.getRepository(DiscordIdentity).delete({ id: identity.id });
      }
    };

    /** Flip the regiment-wide mercenary track through the real settings route. */
    const setMercenaryTrack = async (allowMercenaries: boolean): Promise<void> => {
      await request(server())
        .patch('/api/settings')
        .set(bearer(ownerToken))
        .send({ allowMercenaries })
        .expect(200);
    };

    beforeAll(async () => {
      await cleanupMerc();
      mercToken = (await signIn(mercProfile)).token;
      await setMercenaryTrack(false);
    });

    afterAll(async () => {
      // Restore the seeded default so the suite stays re-runnable.
      await setMercenaryTrack(true);
      await cleanupMerc();
    });

    it('the public regiment profile advertises the closed track (T-0137)', async () => {
      // The apply form is anonymous and cannot read /api/settings, so the toggle
      // rides on the public profile — otherwise it would offer a track the API refuses.
      const res = await request(server()).get('/api/regiment').expect(200);
      expect(res.body.allowMercenaries).toBe(false);
    });

    it('refuses a Mercenary submission while the track is closed (T-0133)', async () => {
      await request(server())
        .post('/api/applications')
        .set(bearer(mercToken))
        .send({ ...validApp, applicantType: 'Mercenary' })
        .expect(403);
    });

    it('still accepts a Member submission while the track is closed (T-0133)', async () => {
      const created = await request(server())
        .post('/api/applications')
        .set(bearer(mercToken))
        .send(validApp)
        .expect(201);
      appId = created.body.id as string;
      expect(created.body.applicantType).toBe('Member');
    });

    it('refuses a post-submit flip onto the closed track (T-0133)', async () => {
      await request(server())
        .patch('/api/applications/mine')
        .set(bearer(mercToken))
        .send({ applicantType: 'Mercenary' })
        .expect(403);

      // An ordinary edit is untouched by the guard.
      const patched = await request(server())
        .patch('/api/applications/mine')
        .set(bearer(mercToken))
        .send({ inGameName: 'MercCandidate2' })
        .expect(200);
      expect(patched.body.inGameName).toBe('MercCandidate2');
      expect(patched.body.applicantType).toBe('Member');
    });

    it('refuses to approve onto a track closed after submission (T-0133)', async () => {
      // Reopen the track, let the applicant legitimately switch onto it…
      await setMercenaryTrack(true);
      const flipped = await request(server())
        .patch('/api/applications/mine')
        .set(bearer(mercToken))
        .send({ applicantType: 'Mercenary' })
        .expect(200);
      expect(flipped.body.applicantType).toBe('Mercenary');

      // …then close it again before the officer decides.
      await setMercenaryTrack(false);
      await request(server())
        .post(`/api/applications/${appId}/approve`)
        .set(bearer(ownerToken))
        .expect(403);

      // No enlistment happened: the application is still pending.
      const mine = await request(server())
        .get('/api/applications/mine')
        .set(bearer(mercToken))
        .expect(200);
      expect(mine.body.application.status).toBe('pending');
    });
  });

  // ── Protected ranks (T-0190) ───────────────────────────────────────────────
  /**
   * The entry rank is resolved BY NAME during approval, so its name is a
   * dependency, not a label. Mocked repositories cannot prove this: the rule has
   * to hold against the real ladder, the real UNIQUE indexes and the real 403
   * mapping, and the negative half — that every OTHER rank is still fully
   * editable — is exactly what a blunter implementation breaks.
   */
  describe('protected ranks', () => {
    type ApiRank = {
      id: string;
      name: string;
      precedence: number;
      discordRoleName: string | null;
      isProtected: boolean;
    };

    const ladder = async (): Promise<ApiRank[]> => {
      const res = await request(server()).get('/api/ranks').set(bearer(ownerToken)).expect(200);
      return res.body as ApiRank[];
    };
    const recruit = async (): Promise<ApiRank> => {
      const found = (await ladder()).find((r) => r.name === 'Recruit');
      if (!found) throw new Error('the seeded ladder has no Recruit rank');
      return found;
    };

    it('flags exactly the server-resolved ranks as protected, and no others', async () => {
      const rows = await ladder();
      const protectedSet = new Set<string>(PROTECTED_RANK_NAMES);

      // Every protected name is actually ON the seeded ladder — a name in the
      // constant with no row behind it is a broken enlistment flow, not a
      // harmless typo.
      for (const name of protectedSet) {
        expect(rows.map((r) => r.name)).toContain(name);
      }
      expect(rows.filter((r) => protectedSet.has(r.name)).map((r) => r.isProtected)).not.toContain(
        false,
      );
      expect(rows.filter((r) => !protectedSet.has(r.name)).map((r) => r.isProtected)).not.toContain(
        true,
      );
    });

    it('refuses a rename with 403 and leaves the row untouched', async () => {
      const before = await recruit();

      await request(server())
        .patch(`/api/ranks/${before.id}`)
        .set(bearer(ownerToken))
        .send({ name: 'Rookie' })
        .expect(403);

      // Re-read rather than trusting the response: the point is that nothing was
      // written, and only the ladder can say that.
      const after = await recruit();
      expect(after.name).toBe('Recruit');
      expect((await ladder()).some((r) => r.name === 'Rookie')).toBe(false);
    });

    it('refuses a casing-only rename — the lookup would still find it, so it stays frozen', async () => {
      const row = await recruit();

      await request(server())
        .patch(`/api/ranks/${row.id}`)
        .set(bearer(ownerToken))
        .send({ name: 'recruit' })
        .expect(403);
      expect((await recruit()).name).toBe('Recruit');
    });

    it('still accepts a Discord-role edit that posts the unchanged name', async () => {
      const row = await recruit();
      const original = row.discordRoleName;

      // Exactly the body the admin console sends: the whole rank, name included.
      const patched = await request(server())
        .patch(`/api/ranks/${row.id}`)
        .set(bearer(ownerToken))
        .send({ name: 'Recruit', precedence: row.precedence, discordRoleName: '@E2ERecruitRole' })
        .expect(200);
      expect(patched.body).toMatchObject({
        name: 'Recruit',
        discordRoleName: '@E2ERecruitRole',
        isProtected: true,
      });

      await request(server())
        .patch(`/api/ranks/${row.id}`)
        .set(bearer(ownerToken))
        .send({ discordRoleName: original })
        .expect(200);
      expect((await recruit()).discordRoleName).toBe(original);
    });

    it('refuses a delete with 403, and the rank survives', async () => {
      const row = await recruit();

      await request(server()).delete(`/api/ranks/${row.id}`).set(bearer(ownerToken)).expect(403);

      expect((await ladder()).some((r) => r.id === row.id)).toBe(true);
    });

    it('leaves an ordinary rank fully renameable and deletable', async () => {
      // The control case. Without it, a guard that froze the whole ladder would
      // pass every assertion above.
      const created = await request(server())
        .post('/api/ranks')
        .set(bearer(ownerToken))
        .send({ name: 'E2E Ensign' })
        .expect(201);
      expect(created.body.isProtected).toBe(false);

      await request(server())
        .patch(`/api/ranks/${created.body.id}`)
        .set(bearer(ownerToken))
        .send({ name: 'E2E Ensign Renamed' })
        .expect(200);

      await request(server())
        .delete(`/api/ranks/${created.body.id}`)
        .set(bearer(ownerToken))
        .expect(204);

      expect((await ladder()).some((r) => r.id === created.body.id)).toBe(false);
    });
  });
});
