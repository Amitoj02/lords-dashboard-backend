# Lords Regiment — Production Plan: Private API + Discord Bot (15 Days)

> Status: **planning document** (not yet executed). This file is the master plan; the tracking
> scaffold it describes under `project-plan/` (STATUS.md, `phases/`, `reference/`) is created when
> execution begins.

## Context

**Goal:** ship a production-ready Lords Regiment platform: a private NestJS API that (a) backs the
Angular dashboard and (b) drives a Discord bot which controls the regiment's Discord server.

**Why now / what exists.** A firsthand read of the backend + a survey of both repos established the
true starting point — it is *not* greenfield:

- **Backend (this repo, NestJS 11 + TypeORM + MySQL 8):** already has all **28 domain entities**, one
  **initial migration** creating every table, **7 seeders**, AES-256-GCM column encryption, a global
  `JwtAuthGuard`, `ThrottlerModule`, Swagger, and a **fully-built Discord OAuth2 sign-in + JWT** auth
  module + health module. `SCHEMA.md` (900 lines) is an authoritative, already-designed 3NF data model.
  **But every feature module is unbuilt** — the entities exist and are commented out in `app.module.ts`
  (`MembersModule`, `RanksModule`, `MedalsModule`, `EventsModule`, `GalleryModule`,
  `ApplicationsModule`, `AuditModule`, `SettingsModule`). There is **no Discord bot** — the original
  design deliberately modelled only its *reported status* (`discord_connections`, `bot_operations`);
  there is no `discord.js`, no bot token, no gateway.
- **Frontend (`lords-regiment-dashboard`, Angular 19):** 21 designed screens, most built, but **100%
  stubbed** — every service returns `of(stubData)`, no `HttpClient`, no `environment.ts`, no auth
  interceptor. Each service carries a `// TODO: replace with HttpClient` marker naming its `/api/...`
  base path, so the API contract is already pinned by the frontend.
- **Design/UI audit** surfaced real gaps (member admin-action modal, several Settings panes, an
  announcement composer, an auth-callback route).

**Because the schema and API contract are already designed, this plan is mostly *build + wire + test*,
not *design-from-scratch*.** The genuinely new surface is the Discord bot and the frontend integration.

**Confirmed decisions:**
1. **Scope:** full-stack to production — backend feature modules + Discord bot + wire the Angular
   frontend to the real API + build the missing admin UI + deployment.
2. **Task tracking:** markdown files committed to **this backend repo** (single source of truth), in a
   `project-plan/` folder Claude reads/checks-off/commits each session — no external state, no MCP
   round-trips.
3. **Bot runtime:** in-process — a `DiscordModule` hosts a `discord.js` gateway client in the **same
   NestJS process**; API endpoints call bot services directly.
4. **Bot v1 capabilities:** core sync (role sync, application-decision DMs, event reminders,
   announcements) **+ member-onboarding automation** (welcome message, auto-assign join role, optional
   reaction-roles) **+ slash commands** (`/roster`, `/event`, `/apply`, `/whoami`). *In-Discord
   moderation (kick/ban/timeout) is deferred to a later milestone.*

---

## Deliverable A — the tracking system (created first, in this repo)

Everything lives in **`project-plan/`** so status is in one repo and trivially Claude-readable. When
execution begins, this plan is expanded into:

```
project-plan/
├── PLAN.md                   # this document
├── README.md                 # how to use this folder + the build/testing loop
├── STATUS.md                 # ⭐ master dashboard — the ONE file Claude reads/updates each session
├── ROADMAP.md                # the 15-day phase overview + day calendar
├── phases/
│   ├── phase-01-foundations.md
│   ├── phase-02-members-ranks-medals.md
│   ├── phase-03-applications.md
│   ├── phase-04-events.md
│   ├── phase-05-gallery.md
│   ├── phase-06-audit-notifications-settings.md
│   ├── phase-07-bot-foundation.md
│   ├── phase-08-bot-core-sync.md
│   ├── phase-09-bot-onboarding-slash.md
│   ├── phase-10-frontend-integration.md
│   ├── phase-11-missing-admin-ui.md
│   └── phase-12-hardening-deploy.md
└── reference/
    ├── API-ENDPOINTS.md      # full endpoint catalog grouped by feature (below)
    ├── DATABASE.md           # pointer to SCHEMA.md + the NEW tables/columns the bot needs
    ├── BOT-SPEC.md           # bot architecture, gateway events, slash commands, sync engine
    ├── UI-GAPS.md            # missing frontend UI list (below)
    └── QUESTIONNAIRE.md      # business-logic questions (below)
```

**STATUS.md format** (kept dead-simple so Claude updates it reliably each session):

```md
# Build Status — updated <date> by Claude

Current focus: Phase 3 — Applications

| Phase | Title                         | State        | Tasks   |
|-------|-------------------------------|--------------|---------|
| 01    | Foundations & test loop       | ✅ done      | 8/8     |
| 02    | Members / Ranks / Medals      | 🔄 in-prog   | 5/9     |
| 03    | Applications                  | ⬜ blocked   | 0/6     |
| ...   | ...                           | ...          | ...     |

Legend: ✅ done · 🔄 in-progress · ⬜ not-started · ⛔ blocked (needs answer, see QUESTIONNAIRE.md)
```

**Each `phases/phase-NN.md`** uses one template: `Goal` · `Depends on` · `Tasks` (a `- [ ]` checklist)
· `Endpoints delivered` · `DB changes` · `Definition of Done` (tests green + verified) · `Verification
steps`. Claude checks boxes as it goes and flips the phase state in STATUS.md.

**Backend `CLAUDE.md` (new, added at execution start):** points every session at `project-plan/STATUS.md`
first, and encodes the non-negotiable conventions so Claude doesn't relearn them: capability checks come
from `role_permissions` (never `role ∈ {…}`); every mutation writes an `audit_log_entries` row; Discord
snowflakes are `varchar(20)` strings; tokens/passwords are encryption-transformer columns; schema
changes go through a migration (`synchronize` stays off); mixed-case enum values mirror the frontend
exactly.

---

## Deliverable B — the 15-day phased build plan

Day calendar (phases overlap where a phase spans two days; each phase gates the next only where noted):

| Day | Phase | Milestone |
|----|--------|-----------|
| 1 | 01 Foundations | Green CI + Docker + capability guard + audit service; app boots, `/auth/me` works |
| 2–3 | 02 Members/Ranks/Medals | Roster + rank ladder + medal cabinet + member admin actions live |
| 4 | 03 Applications | Public apply intake + approve→promote-to-member |
| 5–6 | 04 Events | Events CRUD + RSVP + attendees + audited password reveal |
| 7 | 05 Gallery | Submit + moderation + likes |
| 8 | 06 Audit/Notifications/Settings | Audit ledger + dispatches + settings/permissions + GDPR |
| 9–10 | 07 Bot foundation | `discord.js` in-process, bot online, onboarding bind + permission check |
| 11–12 | 08 Bot core sync | Role-sync engine, decision DMs, reminders, announcements, bot-control API |
| 12–13 | 09 Bot onboarding + slash | Welcome/join-role automation + `/roster /event /apply /whoami` |
| 13–14 | 10 Frontend integration | Every stub service swapped for real HTTP; login handoff works |
| 14 | 11 Missing admin UI | Member action modal, Settings panes, announcement composer |
| 15 | 12 Hardening & deploy | Full E2E, security review, production Docker deploy, launch checklist |

### Phase 01 — Foundations & test loop (Day 1)
Goal: a repeatable build/test loop and the shared plumbing every module reuses, so later phases are
pure feature work.
- Install deps; verify `npm run db:setup` (create → migrate → seed) and `start:dev` boot; `/auth/me`
  returns the seeded owner.
- Build the **capability authorization** layer: a `CapabilitiesGuard` + `@RequireCapability()` reading
  the seeded `role_permissions` matrix (stricter than the coarse `isAdmin`; see SCHEMA §3.2).
- Build the shared **AuditService** + an interceptor/helper so every mutating endpoint writes an
  `audit_log_entries` row (actor, action from `audit_actions`, before/after, `discord_sync_status`).
- Shared list plumbing: pagination DTOs (already present), a base serializer that strips encrypted
  fields, consistent error shapes.
- **CI**: add `.github/workflows/ci.yml` (lint + unit + e2e against a MySQL service container + build).
- **Docker**: `Dockerfile` + `docker-compose.yml` (api + MySQL 8) for local + prod parity.
- **SessionStart hook** (`.claude/`): install + `db:setup` on a test schema + lint + unit tests, so
  every web session boots green (uses the `session-start-hook` skill).
- Create the `project-plan/` tracking folder + backend `CLAUDE.md`.
- **DoD:** CI green; `docker compose up` serves `/api/health` and `/api/docs`.

### Phase 02 — Members, Ranks & Medals (Days 2–3)
Goal: the roster and the rank/medal catalog, plus the member admin-action surface the API must back.
- `MembersModule`: `GET /members` (filter rank/role/status/search + pagination), `GET /members/:id`,
  `PATCH /members/:id` (self/admin), and admin actions — change rank, change role, award/remove medal
  (`member_medals`), suspend (`suspended_until`), ban (`banned_at`), unban, `GET
  /members/:id/service-record`, `GET /members/:id/command-info` (admin: last sign-in/IP/audit).
- `RanksModule`: CRUD + reorder (`precedence`) + link-to-Discord fields (sync itself lands in Phase 08).
- `MedalsModule`: CRUD + link-to-Discord fields.
- `GET /regiment/stats` (landing counters) + `GET /regiment` (public profile).
- Derived values (`holders_count`, `chevrons`, `events_attended`, `attendance_percent`) computed
  server-side, never trusted from client.
- **DoD:** unit + e2e for each action; every mutation produces an audit row; capability-gated.

### Phase 03 — Applications (Day 4)
Goal: recruitment intake → decision → roster promotion.
- `ApplicationsModule`: **public** `POST /applications` intake (the apply form currently has no service
  call), `GET /applications` (tabs pending/approved/declined + reapply), `GET /applications/:id`,
  `POST /:id/approve|decline|hold` with `moderator_note` + `discord_dm_message`.
- **Approve promotes to a member**: create a `members` row, link `discord_identity`, set default rank +
  `role = Member`, set `applications.promoted_member_id`, write service-record + audit. Reapplication
  detection from prior apps by the same `discord_user_id`.
- Respect `open_recruitment=false` (reject intake) and `discord_in_server` / `mutual_events_count`.
- **DoD:** e2e for the full apply→approve→member-appears-on-roster path.

### Phase 04 — Events (Days 5–6)
Goal: event lifecycle, RSVP, attendance, and the sensitive server-password flow.
- `EventsModule`: CRUD (+ draft/archive), child writes for `event_platforms/tags/notify_offsets`,
  `POST /:id/rsvp` (`event_rsvps`), attendee check-in (`event_attendees`).
- `POST /:id/reveal-password`: gated on RSVP ∈ {interested,tentative} + `reveal_event_passwords`
  capability; decrypts `server_password`; **writes an audit row** (`event.password.reveal`).
- Public vs member serialization (password/attendees hidden when unauth or `public_events=false`).
- Scheduled job advancing `status` (upcoming→ongoing→previous) — server-owned, never client-trusted.
- **DoD:** e2e covering RSVP counts, reveal gating + audit, and public redaction.

### Phase 05 — Gallery (Day 7)
Goal: media submission + moderation + engagement.
- `GalleryModule`: `POST /gallery` submit (files/link, forces `pending`), `GET /gallery` (public =
  approved only; filter type/tag), `POST /:id/approve|decline` (moderation, `auto_approve_trusted`
  honored), `POST /:id/like` toggle (`gallery_likes`), tagged members, soft-delete.
- Store file **URLs/refs only** (no object storage in v1); enforce `regiment_settings` size/type limits.
- **DoD:** e2e for submit→moderate→public-visibility and like idempotency.

### Phase 06 — Audit, Notifications & Settings (Day 8)
Goal: the read-only ledger, member dispatches, and all regiment configuration + GDPR.
- `AuditModule`: `GET /audit` (filter severity/actor/action/date + search + pagination), `GET
  /audit/:id` (before/after drawer), `GET /audit/export` (CSV). Append-only, no write API.
- `NotificationsModule` (Field Dispatches): `GET /notifications`, `POST /notifications` (compose —
  admin), `POST /:id/read`, `GET /notifications/unread-count` (`notification_reads`).
- `SettingsModule`: `GET/PATCH /settings` (profile, visibility toggles, gallery/event defaults,
  Holdfast server, backups/retention), `GET/PATCH /settings/permissions` (edit the `role_permissions`
  matrix), and hazardous ops: `POST /settings/transfer-ownership`, `/transfer-discord`, `/dissolve`.
- **GDPR**: `POST /members/me/deletion-request` (deferred, Discord-reauth-gated per
  `account_deletion_requests`), confirm endpoint, `GET /members/me/export` (data download).
- **DoD:** e2e for permission-matrix edits taking effect on the guard, and the deferred-deletion flow.

### Phase 07 — Discord bot foundation (Days 9–10)
Goal: a real bot online in-process, and the onboarding binding it needs.
- Add `discord.js`; add env `DISCORD_BOT_TOKEN` + `DISCORD_APPLICATION_ID` (extend
  `configuration.ts::DiscordConfig`, `.env.example`, and the Joi schema).
- `DiscordModule` hosting a gateway `Client` (intents: Guilds, GuildMembers[privileged], GuildMessages)
  via `OnModuleInit` login + graceful `OnModuleDestroy` destroy; a `DiscordGateway` provider exposing
  primitives (assign/remove role, list roles, send DM, send channel message, fetch member).
- **New migration** for config + reliable sync (not in current schema):
  - `discord_bot_settings` (1:1 regiment): `announcements_channel_id`, `reminders_channel_id`,
    `applications_channel_id`, `welcome_channel_id`, `join_role_id`, `welcome_message`, feature toggles
    (`sync_enabled`, `reminders_enabled`, `welcome_enabled`, `slash_enabled`), `sync_batch_per_minute`.
  - `discord_sync_jobs` (outbox): queued role-sync operations with `status/attempts/last_error` for
    batched (~25/min), retried, auditable syncs.
  - *(optional, gated on questionnaire)* `discord_reaction_roles`.
- The **real bot now writes** `discord_connections` (heartbeat/status/role-position/permissions) +
  `bot_operations` — the tables the old design left waiting.
- Onboarding: `POST /discord/bind` (server id + invite), `GET /discord/verify-connection` (bot present
  + permission/role-position check — backs the wizard's live check), `GET /discord/bot-status`.
- **DoD:** bot connects to a test guild; status + heartbeat persist; wizard check passes.

### Phase 08 — Bot core sync + control API (Days 11–12)
Goal: the bot actually mirrors the dashboard onto Discord, and the API controls the bot.
- **Role-sync engine**: an outbox worker draining `discord_sync_jobs` in batches (~25/min), retrying,
  recording success/failure to `bot_operations` + `audit_log_entries.discord_sync_status`. Enqueue jobs
  on rank change, role change, medal award/remove, and rank/medal→Discord-role (re)linking.
- **Application-decision DMs** (`discord_dm_message` on approve/decline; assign Applicant/member role).
- **Event reminders**: scheduler reads `event_notify_offsets` → posts to `reminders_channel_id`.
- **Announcement broadcast**: composing a notification optionally posts to `announcements_channel_id`.
- **Bot-control API** (the private surface the frontend drives): `GET /discord/connection`, `POST
  /discord/resync` (full sync), `POST /discord/reinvite`, `POST /discord/operations/:id/resolve`,
  `GET/PATCH /discord/settings`, `POST /discord/announce`.
- **DoD:** e2e (mock the gateway) proving a rank change enqueues → drains → audits with sync status;
  failures surface as resolvable `bot_operations`.

### Phase 09 — Bot onboarding automation + slash commands (Days 12–13)
Goal: the two extra v1 capabilities.
- **Onboarding automation**: on `GuildMemberAdd` → send welcome (DM/channel per settings) + auto-assign
  `join_role_id`; optional reaction-roles (if confirmed).
- **Slash commands** registered on boot (guild-scoped for instant availability): `/roster`, `/event`,
  `/apply`, `/whoami` — resolve against the same services, ephemeral responses.
- **DoD:** join a test guild → welcome + role fire; each slash command returns correct data.

### Phase 10 — Frontend integration (Days 13–14)
Goal: swap every stub for the real API — the CLAUDE.md `of(stub)` → `this.http.get` pattern, repo-wide.
- Add `HttpClientModule`/`provideHttpClient`, `environment.ts` (API base URL), a JWT auth interceptor
  (cookie + bearer), and the **`/auth/callback` route** that captures the OAuth handoff and hydrates
  `AuthService.currentUser` from `GET /auth/me`.
- Rewrite `MembersService`, `EventsService`, `ApplicationsService` (+ add public `submit`),
  `GalleryService`, `AuditService`, `AuthService` (real login/logout), plus new clients for settings,
  ranks, medals, notifications, regiment stats, and the Discord control endpoints.
- Handle identity-only sessions (`isMember:false` → route to `/apply`), loading/error states, and CORS.
- **DoD:** Playwright smoke — sign in (mocked Discord) → dashboard renders real data; an admin action
  round-trips to the API and back.

### Phase 11 — Missing admin UI (Day 14)
Goal: close the design-vs-built gaps that the API now makes buildable (see `reference/UI-GAPS.md`).
- **AdminActionModal (designed screen 11, unbuilt):** change rank/role, award/remove medal,
  suspend/ban — wired from Roster row `…` menu + Profile. *Highest-value gap.*
- **Settings panes (dead stubs today):** Discord connection (channel routing + join role + rebind),
  Quartermaster-bot config (wire the existing `/admin/bot` BotStatus screen in + feature toggles),
  Operations panes (gallery limits, event defaults, Holdfast server, backups).
- **Announcement / Dispatch composer** (missing entirely) → `POST /notifications` + optional Discord
  cross-post.
- Invite-Mercenary flow (roster button currently dead).
- **DoD:** each new screen round-trips to its endpoint; capability-gated in the UI too.

### Phase 12 — Hardening, E2E & deploy (Day 15)
Goal: production launch.
- Full cross-stack E2E; run the `/security-review` skill (helmet, CORS allowlist, rate limits, secrets,
  token/password encryption verified, no secrets in logs, privileged-intent scoping).
- Production Docker build + deploy (target from questionnaire), managed/self-hosted MySQL, TLS/domain,
  secrets, Discord **production app** config (redirect URLs, bot token, enable GUILD_MEMBERS privileged
  intent, invite with correct permissions + role position).
- Seed/demo data, smoke test, and a launch checklist checked into `project-plan/`.
- **DoD:** production URL live; real Discord sign-in works; a role change on the dashboard appears in
  Discord.

---

## Deliverable C — endpoint catalog (grouped by feature)

Goes verbatim into `reference/API-ENDPOINTS.md`. All under `/api`. Auth column: **P**=public,
**M**=member (JWT), **C:x**=requires capability `x` from `role_permissions`.

**Auth & identity** (built): `GET /auth/discord` P · `GET /auth/discord/callback` P · `GET /auth/me` M
· `POST /auth/logout` M.

**Members / Roster:** `GET /members` C:view_members_directory · `GET /members/:id` M · `PATCH
/members/:id` M(self)/C:edit_ranks_medals · `POST /members/:id/rank` C:edit_ranks_medals · `POST
/members/:id/role` C:manage_roles · `POST /members/:id/medals` + `DELETE /members/:id/medals/:medalId`
C:edit_ranks_medals · `POST /members/:id/suspend|ban|unban` C:manage_roles · `GET
/members/:id/service-record` M · `GET /members/:id/command-info` C:view_audit_log · GDPR: `POST
/members/me/deletion-request`, `GET /members/me/export`, `POST /members/me/deletion-request/confirm`.

**Ranks:** `GET /ranks` M · `POST /ranks` · `PATCH /ranks/:id` · `DELETE /ranks/:id` · `POST
/ranks/reorder` · `POST /ranks/:id/link-discord` — all C:edit_ranks_medals.

**Medals:** `GET /medals` M · `POST/PATCH/DELETE /medals[/:id]` · `POST /medals/:id/link-discord` —
C:edit_ranks_medals.

**Events:** `GET /events` P(if `public_events`) · `GET /events/:id` P/M · `POST /events`, `PATCH
/events/:id`, `DELETE /events/:id` C:manage_events · `POST /events/:id/rsvp` C:rsvp_to_events · `POST
/events/:id/reveal-password` C:reveal_event_passwords · `POST /events/:id/attendees` C:manage_events.

**Gallery:** `GET /gallery` P(approved)/M · `GET /gallery/:id` P/M · `POST /gallery`
C:submit_to_gallery · `POST /gallery/:id/approve|decline` C:moderate_gallery · `POST /gallery/:id/like`
M · `DELETE /gallery/:id` (author/C:moderate_gallery).

**Applications:** `POST /applications` P (intake) · `GET /applications` + `GET /applications/:id`
C:manage_applications · `POST /applications/:id/approve|decline|hold` C:manage_applications.

**Audit:** `GET /audit` + `GET /audit/:id` + `GET /audit/export` C:view_audit_log.

**Notifications (dispatches):** `GET /notifications` M · `GET /notifications/unread-count` M · `POST
/notifications/:id/read` M · `POST /notifications` C:manage_events (compose/announce).

**Settings:** `GET /settings` M · `PATCH /settings` C:manage_settings · `GET /settings/permissions` M ·
`PATCH /settings/permissions` C:manage_roles · `POST /settings/transfer-ownership` C:transfer_ownership
· `POST /settings/transfer-discord` + `POST /settings/dissolve` C:manage_settings.

**Regiment:** `GET /regiment` P · `GET /regiment/stats` P(if `public_stats`) · onboarding `GET/PATCH
/onboarding/state`, `POST /onboarding/complete`.

**Discord bot control (new private surface):** `GET /discord/connection` C:manage_settings · `GET
/discord/bot-status` + `GET /discord/verify-connection` (onboarding) · `POST /discord/bind` · `POST
/discord/resync` · `POST /discord/reinvite` · `POST /discord/operations/:id/resolve` · `GET/PATCH
/discord/settings` · `POST /discord/announce` — C:manage_settings.

---

## Deliverable D — database tables

**The 28 tables are already fully specified in `SCHEMA.md`** (columns, enums, FKs, indexes) and already
exist as entities + the initial migration. `reference/DATABASE.md` will just index them by feature and
point to `SCHEMA.md` as the source of truth — no re-derivation. Feature grouping:

- **Tenant/config:** `regiments`, `regiment_settings`, `accent_tones`
- **Identity/people:** `discord_identities`, `members`, `ranks`, `medals`, `member_medals`,
  `role_permissions`, `service_record_entries`, `account_deletion_requests`
- **Events:** `events`, `event_rsvps`, `event_attendees`, `event_platforms`, `event_tags`,
  `event_notify_offsets`
- **Gallery:** `gallery_items`, `gallery_files`, `gallery_tagged_members`, `gallery_likes`
- **Applications:** `applications`
- **Audit/notifications:** `audit_log_entries`, `audit_actions`, `notifications`, `notification_reads`
- **Discord status (reused, now bot-written):** `discord_connections`, `bot_operations`

**NEW tables/columns this plan adds (one migration in Phase 07)** — the only schema work, because the
real bot needs config + reliable sync the status-only design never had:
- **`discord_bot_settings`** (1:1 regiment): channel IDs (announcements/reminders/applications/welcome),
  `join_role_id`, `welcome_message`, feature toggles, `sync_batch_per_minute`.
- **`discord_sync_jobs`** (outbox): `id`, `regiment_id`, `job_type`, `member_id?`, `discord_role_id?`,
  `operation` (add/remove), `status` (pending/running/done/failed), `attempts`, `last_error`,
  `run_after`, timestamps — powers batched, retried, audited role sync.
- **`discord_reaction_roles`** *(optional — only if reaction-roles confirmed in the questionnaire).*
- **Env additions:** `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID` (config + `.env.example` + Joi).

---

## Deliverable E — missing / new UI (goes into `reference/UI-GAPS.md`)

Built content side is solid; these are the real gaps the full-stack scope must close:
1. **Member AdminActionModal (screen 11)** — *designed but never built.* Change rank/role, award/remove
   medal, suspend, ban. The single biggest hole. → Phase 11.
2. **Settings → Discord connection pane** — *undesigned + unbuilt.* Channel routing, join role, rebind/
   disconnect. → Phase 11.
3. **Settings → Quartermaster bot pane** — the `bot` nav item renders nothing; the built `/admin/bot`
   BotStatus screen is orphaned. Wire it in + add feature toggles. → Phase 11.
4. **Announcement / Dispatch composer** — *missing entirely* (members can view dispatches, admins can't
   author them). → Phase 11.
5. **Settings → Operations panes** (gallery limits, event defaults, Holdfast server, backups) — dead
   nav stubs. → Phase 11.
6. **`/auth/callback` route** — required for real OAuth handoff; doesn't exist. → Phase 10.
7. Invite-Mercenary flow (dead roster button). → Phase 11.
8. Compliance flows: transfer-Discord-server / transfer-ownership (buttons without flows). → Phase 11.
9. Mobile — responsive strategy is acceptable; no dedicated components needed.

---

## Deliverable F — business-logic questionnaire (`reference/QUESTIONNAIRE.md`)

Non-blocking, but answers sharpen several phases. Seeded from `SCHEMA.md §7` + the design audit + the
new bot scope:

**Domain model**
1. **Rank ladder mismatch:** the admin ladder (General…Recruit, incl. "Private, First Class") differs
   from member data / roster filter (which use "Lieutenant"). What is the canonical ladder to seed?
2. Can a medal be **awarded more than once** to the same member? (Currently `UNIQUE(member_id,
   medal_id)` forbids it.)
3. Final **gallery limits** (design says 12 MB image / 80 MB video / 10 per submission; another pass
   said 50 MB / 20) and **audit retention months** (default 12).

**Discord / bot**
4. **Channel routing:** which channels receive announcements, event reminders, application
   notifications, and welcomes? (Configurable in Settings; need initial IDs. `#drill-hall` is currently
   hard-coded in the design.)
5. **Join role:** which Discord role does the bot auto-assign on join — Applicant, a "Guest", or none?
6. **Slash commands:** confirm the set (`/roster /event /apply /whoami`), guild-scoped (instant) vs
   global, and that responses should be ephemeral.
7. **Reaction-roles:** in scope for v1, or defer? (Drives the optional `discord_reaction_roles` table.)
8. **App-side ban ↔ Discord:** in-Discord moderation is deferred — but should an app-side ban/suspend
   still **remove the member's synced Discord roles** (a sync action, not a moderation action)?
9. **Announcements:** does composing a dispatch **always** cross-post to Discord, or is it a per-dispatch
   toggle?
10. **Bot permissions/intents:** confirm the production bot will have GUILD_MEMBERS privileged intent
    enabled and sit high enough in the role hierarchy to manage the mapped roles.

**Product/flows**
11. **Open recruitment off:** reject new applications with what message/behavior?
12. **Auto-approve "trusted" gallery members:** how is "trusted" defined?
13. **Invite Mercenary:** what should this flow do (generate a Discord invite, pre-create an Applicant,
    email)?
14. **Landing stats / Officers' Mess:** real computed data or curated values?

**Ops / deploy**
15. **Hosting target:** VPS + Docker Compose, or managed (Railway / Render / Fly)? **MySQL** managed or
    self-hosted? Domain + TLS provider?
16. **Data migration:** greenfield seed only, or is there existing regiment/roster data to import?

---

## Testing loop (the "proper testing loop")

- **Per phase, per module:** Jest **unit** tests (services, guards, sync engine) + Supertest **e2e**
  against a disposable MySQL test schema — the repo already ships this harness (`test/auth.e2e-spec.ts`
  drives the full OAuth flow with Discord mocked). The bot is tested with the **gateway mocked** so sync
  logic is deterministic and offline.
- **Definition of Done gate:** a phase box is only checked when its tests are green — enforced by CI.
- **CI (Phase 01):** GitHub Actions runs lint → unit → e2e (MySQL service container) → build on every
  push to the branch.
- **SessionStart hook:** every Claude web session auto-installs, migrates a test DB, and runs lint +
  unit tests, so work always starts from a known-green baseline.
- **Frontend:** existing Angular unit tests + a Playwright smoke (Phase 10) for sign-in and one admin
  round-trip; Chromium is pre-installed in this environment.
- **End-to-end at the seams:** Phase 12 runs a cross-stack pass (dashboard action → API → bot → Discord)
  before deploy.

## Verification (how we'll know each layer works)
- **API:** `npm run test` + `npm run test:e2e` green; Swagger at `/api/docs` exercises every endpoint;
  `curl`/e2e confirms capability gating and audit rows.
- **Bot:** against a private test guild — a rank change on the dashboard produces the role change in
  Discord and a `bot_operations` + audit row; a join fires welcome + join-role; each slash command
  returns correct data.
- **Frontend:** Playwright sign-in → real dashboard data; admin action round-trips.
- **Production:** post-deploy smoke — real Discord sign-in, one role sync visible in the live server.

## Risks / watch-items
- **Privileged GUILD_MEMBERS intent** must be enabled in the Discord Dev Portal or joins/member-list
  break — flagged in the questionnaire and Phase 12 checklist.
- **Bot role hierarchy:** the bot role must sit above every role it manages, or syncs fail (surfaced as
  resolvable `bot_operations`, exactly as the BotStatus screen anticipates).
- **Rank/medal data reconciliation** (Q1) should be settled before Phase 02 seeds the ladder.
- **In-process bot + web process** share a lifecycle; graceful shutdown + reconnect handling matter for
  production stability (Phase 07/12).
