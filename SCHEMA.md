# Lords Dashboard — Database Schema

MySQL 8 (the Docker Compose `db` service), database **`lords_dashboard`**, charset `utf8mb4` / collation
`utf8mb4_unicode_ci`. ORM: **TypeORM 0.3** with the `SnakeNamingStrategy` (entity properties are
camelCase in code, columns/tables are `snake_case` in MySQL). Schema is owned exclusively by
**migrations** — `synchronize` is permanently off.

This document is the normalized (3NF) data model derived from the Angular frontend
(`lords-regiment-dashboard`): its `core/models`, `core/services`, every feature component, and the
`design-reference/` wireframes (the canonical UI/UX source). It is the single source of truth for the
TypeORM entities and the initial migration.

---

## 1. Design principles

1. **Normalize to 3NF.** Every value the UI stored as a name-string or an array is promoted to a FK or
   a junction table. No repeating groups, no multi-valued columns.
2. **Lookup tables over hardcoded enums where the UI offers CRUD.** Ranks and Medals are
   admin-editable (create / edit / delete / reorder / Discord-sync) → real tables, not enums. Truly
   fixed value-sets (role, status, platform, ribbon colour, statuses) stay as MySQL `ENUM`s.
3. **Single-tenant now, multi-tenant-ready.** Onboarding creates a regiment and the Discord guild it
   is bound to is rebindable, so every domain row carries `regiment_id`. v1 seeds exactly one
   regiment.
4. **Derived values are never trusted from the client.** `holders`, `events_attended`,
   `attendance_percent`, `rsvp_counts`, `likes`, `file_count` are computed in the service layer (or via
   views); the schema stores the source rows, not the aggregate.
5. **Sensitive data is encrypted at rest.** Discord OAuth tokens and event server passwords use an
   AES-256-GCM column transformer (`ENCRYPTION_KEY`). They are never returned in normal responses.
6. **Soft-delete for anything reversible / GDPR-relevant.** `members`, `events`, `gallery_items`,
   `regiments` use `deleted_at`. Audit rows are **retained** and anonymised, never purged.
7. **Discord snowflakes are strings.** `discord_user_id`, `discord_server_id`, `discord_role_id` are
   `varchar(20)` — never integers (64-bit precision loss).
8. **Audit is generic + append-only.** One polymorphic table records every mutation as a side effect;
   no update/delete API.

### Conventions

| Aspect | Rule |
| --- | --- |
| Primary keys | `char(12)` **short-id** (base62, app-generated) for user-facing entities (T-0082, see § Identifier scheme); `varchar(36)` uuid for the retained-opaque set (`discord_identities`, `discord_sync_jobs`); `bigint` auto-increment for `audit_log_entries` (UI shows numeric ids); composite PKs for pure join tables. |
| Timestamps | `created_at`, `updated_at` on every entity; `deleted_at` where soft-deleted. **All date columns are `datetime(6)`, not `timestamp`** — avoids the MySQL `timestamp` 2038 cap (future event dates) and implicit tz conversion. Values are stored UTC by application convention. |
| Indexes | Every FK column is indexed. For composite-PK junctions the **trailing** column gets its own explicit index (the PK only covers the leading column) so reverse lookups ("my RSVPs", "my likes") stay fast. |
| ON DELETE | Junction/child rows `CASCADE` with their parent. References into the append-only `audit_log_entries` and `regiments.owner_member_id` use `SET NULL` so history/ownership survive a member purge. See each table. |
| Money/secret | encrypted `text` via transformer. |
| Strings | snowflakes `varchar(20)`; tags `varchar(40)`; URLs `varchar(512)`; IANA tz `varchar(40)`. |
| FK naming | `<entity>_id`. Junctions named `<owner>_<related>` (e.g. `event_attendees`). |

### Identifier scheme (short-id) — T-0081 decision

Entity primary keys and their foreign keys are **12-character base62** short ids
(`[0-9A-Za-z]`, ~71 bits of entropy), generated in-app by `generateShortId()`
(Node `crypto.randomInt`, no external dependency) and minted on insert by a global
TypeORM subscriber (`ShortIdSubscriber`) keyed on the `char(12)` `id` column. Column
type is `char(12)`. Birthday-collision risk at regiment scale is negligible; the
DB PRIMARY KEY constraint is the backstop (no inline collision check). Validation
uses `@IsShortId()` / `ParseShortIdPipe` in place of `@IsUUID()` / `ParseUUIDPipe`.

**Retained-opaque set (kept `varchar(36)` uuid / long random — NOT short-id):**

| Value | Where | Why |
| --- | --- | --- |
| `discord_identities.id` (+ inbound FKs `members.discord_identity_id`, `applications.discord_identity_id`) | auth | The JWT `sub` / stateless-session anchor; never appears in a URL. |
| `discord_sync_jobs.id` | discord outbox | Opaque idempotency/outbox key. |
| `account_deletion_requests.confirm_token` (`varchar(64)`) | members | GDPR self-deletion token — must stay unguessable. |
| Storage object keys (`uuid.ext`) | storage | Namespace-validated by a uuid-tail regex; guessability matters. |
| OAuth `state`, session tokens, AES-GCM ciphertext | auth/crypto | Not entity ids; unchanged. |
| Discord snowflakes (`varchar(20)`) | discord | External ids, not ours. |

---

## 2. Enumerations (MySQL `ENUM`)

| Enum | Values | Used by |
| --- | --- | --- |
| `member_role` | `Owner`, `Admin`, `Moderator`, `Member`, `Mercenary`, `Applicant` | `members.role`, `role_permissions.role` |
| `member_status` | `Active`, `Inactive`, `Pending` | `members.status` (suspended/banned are timestamps, not statuses) |
| `platform` | `steam`, `xbox`, `ps` | `members.platform`, `applications.platform`, `event_platforms.platform` |
| `medal_ribbon` | `blue`, `red`, `gold`, `green`, `tricolor` | `medals.ribbon` |
| `event_status` | `upcoming`, `ongoing`, `previous` | `events.status` |
| `rsvp_status` | `interested`, `tentative`, `declined`, `neutral` | `event_rsvps.status` |
| `gallery_type` | `image`, `video`, `link` | `gallery_items.type` |
| `gallery_status` | `pending`, `approved`, `declined` | `gallery_items.status` |
| `gallery_media_type` | `image`, `video` | `gallery_files.media_type` |
| `application_status` | `pending`, `approved`, `declined`, `held` | `applications.status` |
| `applicant_type` | `Applicant`, `Mercenary` | `applications.applicant_type` |
| `how_found` | `discord`, `friend`, `youtube`, `reddit`, `ingame`, `other` | `applications.how_found` |
| `audit_severity` | `info`, `warn`, `err` | `audit_log_entries.severity` |
| `audit_actor_type` | `member`, `bot`, `system` | `audit_log_entries.actor_type` |
| `discord_sync_status` | `pending`, `synced`, `failed`, `not_applicable` | `audit_log_entries.discord_sync_status` |
| `bot_connection_status` | `idle`, `checking`, `connected`, `error` | `discord_connections.connection_status` |
| `notification_tone` | `info`, `warn`, `ok` | `notifications.tone` |
| `account_deletion_status` | `pending_discord_confirmation`, `confirmed`, `executed`, `cancelled` | `account_deletion_requests.status` |

Open/extensible sets stored as `varchar` (not `ENUM`) so values can be added without a migration:
`audit_log_entries.action` (catalogued in `audit_actions`), `role_permissions.capability`,
`events.recurrence_rule`.

---

## 3. Tables

### 3.1 Tenant & configuration

#### `regiments`
The tenant root. One row in v1.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `name` | varchar(120) NOT NULL | `regimentName`, min 3 |
| `short_tag` | varchar(6) NOT NULL | rendered `[TAG]` |
| `mission_statement` | varchar(400) NULL | shown on landing |
| `accent_tone` | varchar(20) NOT NULL DEFAULT `'brass'` | FK → `accent_tones.key` |
| `crest_url` | varchar(512) NULL | |
| `banner_url` | varchar(512) NULL | |
| `established_year` | smallint NULL | landing |
| `discord_invite_url` | varchar(255) NULL | permanent `discord.gg` invite |
| `discord_server_id` | varchar(20) NULL | snowflake |
| `discord_server_name` | varchar(120) NULL | |
| `setup_step` | tinyint NOT NULL DEFAULT 1 | onboarding wizard resume (1–5) |
| `setup_complete` | boolean NOT NULL DEFAULT false | |
| `owner_member_id` | char(36) NULL | FK → `members.id`; set at provisioning. No API path reassigns it since T-0170 retired ownership transfer |
| `created_at` / `updated_at` | timestamp | |
| `dissolved_at` | timestamp NULL | soft-delete (dissolution) |

Indexes: `UNIQUE(short_tag)`, `UNIQUE(discord_server_id)`.
Relationships: 1—1 `regiment_settings`, 1—1 `discord_connections`; 1—* everything else.

#### `regiment_settings`
1—1 with `regiments` (PK = FK). The four wireframe config groups as typed columns.

| Column | Type | Notes |
| --- | --- | --- |
| `regiment_id` | char(36) PK | FK → `regiments.id` |
| `public_roster` / `public_gallery` / `public_events` / `public_stats` | boolean DEFAULT true | visibility toggles |
| `open_recruitment` | boolean DEFAULT true | **false ⇒ reject new applications** |
| `show_officers_mess_on_landing` | boolean DEFAULT true | gates landing officers list |
| `allow_mercenaries` | boolean DEFAULT true | |
| `auto_approve_trusted_members` | boolean DEFAULT false | |
| `gallery_max_image_size_mb` | int DEFAULT 12 | |
| `gallery_max_video_size_mb` | int DEFAULT 80 | |
| `gallery_max_items_per_submission` | int DEFAULT 10 | |
| `gallery_allowed_image_types` | json | e.g. `["jpg","png","webp"]` |
| `gallery_allowed_video_types` | json | e.g. `["mp4","webm","mov"]` |
| `event_default_timezone` | varchar(40) DEFAULT `'UTC'` | |
| `event_default_start_time` | varchar(5) NULL | `HH:mm` |
| `event_default_notify_before` | json | minutes array, e.g. `[60,15]` |
| `audit_retention_months` | int DEFAULT 12 | drives anonymisation job |
| `hero_banner_url` | varchar(512) NULL | landing hero background (T-0146) |
| `login_banner_url` | varchar(512) NULL | sign-in page background |
| `charter_quote` / `charter_quote_attribution` | varchar(500) / varchar(120) NULL | landing pull-quote |
| `login_quote` / `login_quote_attribution` | varchar(500) / varchar(120) NULL | sign-in pull-quote |
| `hero_overlay_density` / `login_overlay_density` | tinyint unsigned NULL | scrim opacity, 0—100 |
| `created_at` / `updated_at` | timestamp | |

> **The presentation columns are nullable with NO default on purpose.** NULL means "unset — render
> the shipped copy", and the SPA owns those defaults. That is what keeps a never-configured install,
> and an install whose API call fails, from rendering a blank hero. They are written only through
> `PATCH /api/settings/presentation`, which is gated on `manage_regiment_details` rather than
> `manage_settings`. Banner columns hold the RESOLVED public URL; the request DTO carries a storage
> `…Key` that `StorageService.resolveKeyToPublicUrl` validates against its namespace first.

> Conflicts noted across UI passes (gallery limits 50MB/20 vs 12MB/80MB/10) are resolved to the
> design-reference values above and are runtime-configurable, so either can be set without a migration.

#### `regiment_documents`
The admin-authored legal documents published on the public site (T-0149): terms of service, privacy
policy, community guidelines.

| Column | Type | Notes |
| --- | --- | --- |
| `regiment_id` | char(12) PK | FK → `regiments.id` ON DELETE CASCADE |
| `slug` | varchar(32) PK | `terms` \| `privacy` \| `guidelines` — also the public route segment |
| `body` | mediumtext NULL | **Markdown**, never HTML. NULL ⇒ never edited |
| `updated_by_member_id` | char(12) NULL | FK → `members.id` ON DELETE **SET NULL** |
| `updated_at` | datetime(6) | |

> Deliberately its own table rather than three columns on `regiment_settings`: these are long TEXT
> bodies and `regiment_settings` is the single row every settings read joins. It also gives each
> document its own edit attribution, which a shared row could not.
>
> **A missing row is normal, not an error** — it means "never edited", and the SPA renders its shipped
> fallback copy. Production is legally required to serve a privacy policy, so an absent or blank
> document must still render a real page. There is deliberately **no seeder**: a tier-2 seeder would
> never run against the already-provisioned production database, and a tier-1 one would fight the
> fallback contract.
>
> `body` is Markdown rendered client-side through a strict, escape-first renderer, so an admin account
> cannot inject executable markup into an unauthenticated page. Reads are anonymous
> (`GET /api/regiment/documents`); writes need `manage_regiment_details` and are audited — the audit
> row records the slug and the body *length*, not the bodies, so the ledger is not flooded.
>
> The `ON DELETE SET NULL` on the author is intentional: a departed author must not take the
> regiment's privacy policy with them.

#### `accent_tones` (lookup)
| Column | Type | Notes |
| --- | --- | --- |
| `key` | varchar(20) PK | `brass`, `crimson`, `royal`, `forest`, `pewter`, `oxblood` |
| `label` | varchar(40) NOT NULL | "Antique Brass" |
| `hex` | char(7) NOT NULL | `#bf9447` |
| `sort_order` | tinyint NOT NULL | |

---

### 3.2 Identity & people

#### `discord_identities`
**The OAuth user record.** The stable Discord identity behind a member; created/updated on every
sign-in. This is what "sign in with Discord creates a proper user record" produces (together with
`members`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid — **this row is the canonical "user account" record created on sign-in** |
| `discord_user_id` | varchar(20) NOT NULL | **snowflake — unique stable key** for callback lookup + reapplication detection |
| `discord_tag` | varchar(64) NULL | `@handle` (new username system) |
| `discord_username` | varchar(64) NULL | legacy `name#discriminator` (may differ from tag) |
| `global_name` | varchar(64) NULL | Discord display name |
| `email` | varchar(255) NULL | only if `email` scope granted |
| `avatar_url` | varchar(512) NULL | from `identify` |
| `access_token` | text NULL | **AES-256-GCM encrypted** |
| `refresh_token` | text NULL | **AES-256-GCM encrypted** |
| `token_expires_at` | timestamp NULL | |
| `scopes` | varchar(255) NULL | granted scopes, space-separated |
| `guild_member` | boolean DEFAULT false | cached "is in the regiment guild" check |
| `guild_checked_at` | datetime(6) NULL | when that check was last **confirmed** by the bot (T-0167) |
| `last_sign_in_at` | timestamp NULL | |
| `last_sign_in_ip` | varchar(45) NULL | masked for display (admin Command Information) |
| `created_at` / `updated_at` | timestamp | |

Indexes: `UNIQUE(discord_user_id)`. Relationship: **1—0..1 `members`** — an identity may exist with no
member yet (someone who signed in but hasn't joined the roster). The member row is created at
application time, **not** on every sign-in, so the roster never fills with idle Applicants.

> **The guild pair is read together, and `NULL` is the load-bearing value (T-0167/T-0168).**
> `guild_checked_at IS NULL` means *never confirmed*, which is not the same as *confirmed absent* —
> only a completed bot lookup or a live `GuildMemberAdd`/`GuildMemberRemove` event writes the pair.
> Every degraded case (no `DISCORD_GUILD_ID`, bot disconnected, lookup timeout, circuit breaker open)
> leaves both columns alone, and a never-confirmed identity resolves **fail-open**: `guildMember` is
> reported `true` with `degraded: true` on `GET /api/auth/guild-status`. That matters because every
> row in the live database is never-confirmed on the day this ships — the opposite reading would gate
> the entire regiment out of its own dashboard. Enforcement is additionally behind
> `discord_bot_settings.guild_gate_enabled` (boolean, **default false**), and anyone holding
> `manage_settings` is exempt from the gate unconditionally, so a bot or invite misconfiguration can
> never lock the regiment out of the settings panel that would fix it.

#### `members`
The authoritative person record. Replaces the frontend's denormalized `rank`/`chevrons`/`medals[]`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL | FK → `regiments.id` |
| `discord_identity_id` | char(36) NULL UNIQUE | FK → `discord_identities.id` |
| `rank_id` | char(36) NOT NULL | FK → `ranks.id` (**replaces free-string rank**; chevrons derive from rank) |
| `name` | varchar(120) NOT NULL | display/full name |
| `in_game_name` | varchar(120) NULL | min 2 |
| `role` | enum `member_role` NOT NULL DEFAULT `'Applicant'` | authorization |
| `status` | enum `member_status` NOT NULL DEFAULT `'Pending'` | |
| `platform` | enum `platform` NULL | |
| `timezone` | varchar(40) NULL | IANA tz |
| `discord_linked` | boolean NOT NULL DEFAULT false | |
| `public_profile` | boolean NOT NULL DEFAULT true | self-service visibility |
| `avatar_url` | varchar(512) NULL | |
| `banner_url` | varchar(512) NULL | |
| `standing` | varchar(40) NULL | e.g. "Good Order" |
| `joined_at` | timestamp NULL | enlistment date |
| `last_seen_at` | timestamp NULL | drives 30-day auto-inactive job |
| `suspended_until` | timestamp NULL | disciplinary state |
| `banned_at` | timestamp NULL | disciplinary state |
| `created_at` / `updated_at` | timestamp | |
| `deleted_at` | timestamp NULL | soft-delete (GDPR) |

Indexes: `INDEX(regiment_id)`, `INDEX(rank_id)`, `INDEX(role)`, `INDEX(status)`,
`UNIQUE(discord_identity_id)`.
Derived (not columns): `events_attended_count`, `attendance_percent`, `chevrons` (← rank).
Relationships: *—1 `ranks`, *—1 `regiments`, **0..1—1 `discord_identities`** (a member optionally maps
to one OAuth identity), *—* `medals` via `member_medals`, 1—* `event_rsvps` / `gallery_items` (author)
/ `service_record_entries`. Applications attach to the **identity** (1—*), not the member; the approved
one points back via `applications.promoted_member_id`.

#### `ranks` (lookup table, per regiment)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid (model had no id — surrogate added) |
| `regiment_id` | char(36) NOT NULL | FK |
| `name` | varchar(60) NOT NULL | e.g. "Colonel", "Private, First Class" |
| `chevrons` | tinyint NOT NULL DEFAULT 0 | 0–5 insignia |
| `precedence` | int NOT NULL | drag-reorder; 1 = highest |
| `discord_role_name` | varchar(80) NULL | e.g. `@Colonel` |
| `discord_role_id` | varchar(20) NULL | snowflake |
| `linked` | boolean NOT NULL DEFAULT false | synced to Discord (Applicant intentionally not) |
| `created_at` / `updated_at` | timestamp | |

Indexes: `UNIQUE(regiment_id, name)`, `UNIQUE(regiment_id, precedence)`.
Derived: `holders_count` ← `COUNT(members.rank_id)`, `is_protected` ← the row's own `name`.

**One row is load-bearing.** Approving an application resolves the entry rank
(`Recruit`) *by name*, not by id, so that string is a dependency and not a label:
the API refuses a rename or a delete on it with 403 for every caller, the Owner
included. Everything else about the row — precedence, insignia, Discord role — stays
editable, and every other rank stays fully renameable and deletable. The protection
is derived in code (`src/ranks/protected-ranks.ts`) from the same constant the
enlistment path imports rather than stored as a column, so the set of protected
ranks cannot drift from the set of ranks the server actually depends on. Nothing
reserves the *name*: a database that lost the row before this rule existed can
recreate it, and an approval attempted meanwhile fails with a 409 naming the rank
to restore.

#### `medals` (catalog table, per regiment)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid (model keyed by letter — surrogate added) |
| `regiment_id` | char(36) NOT NULL | FK |
| `title` | varchar(120) NOT NULL | |
| `glyph` | varchar(4) NOT NULL | single char / `★` (the UI "letter") |
| `ribbon` | enum `medal_ribbon` NOT NULL | the only true enum here |
| `description` | varchar(400) NULL | doubles as award criteria |
| `precedence` | int NOT NULL DEFAULT 0 | display order (editor field, not in model) |
| `discord_role_name` | varchar(80) NULL | |
| `discord_role_id` | varchar(20) NULL | snowflake |
| `linked` | boolean NOT NULL DEFAULT false | |
| `created_at` / `updated_at` | timestamp | |

Indexes: `INDEX(regiment_id)`, `UNIQUE(regiment_id, title)`.
Derived: `holders_count` ← `COUNT(member_medals)`.

#### `member_medals` (junction, M—N with per-award metadata)
Replaces `member.medals: MedalRibbon[]` (which lost medal identity).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `member_id` | char(36) NOT NULL | FK → `members.id` |
| `medal_id` | char(36) NOT NULL | FK → `medals.id` |
| `detail` | varchar(255) NULL | per-award citation (distinct from `medals.description`) |
| `awarded_at` | timestamp NOT NULL | |
| `awarded_by_member_id` | char(36) NULL | FK → `members.id` |

Indexes: `UNIQUE(member_id, medal_id)`.

#### `role_permissions` (authorization matrix — source of truth)
Capability × role booleans, per regiment. **Drives `RolesGuard`/capability checks.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL | FK |
| `role` | enum `member_role` NOT NULL | |
| `capability` | varchar(60) NOT NULL | open set (see below) |
| `granted` | boolean NOT NULL DEFAULT false | |

Indexes: `UNIQUE(regiment_id, role, capability)`.

> Roles are a **fixed `member_role` enum** (no custom roles in scope). The matrix lets the *grants* be
> edited per regiment; it does not add new roles. If custom roles are ever needed, promote `role` to a
> `roles` lookup table and FK both `members.role` and this table — a deliberate future migration.
Capabilities & **default grants** (Owner column is locked = always granted):

| Capability | Owner | Admin | Moderator | Member | Mercenary | Applicant |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Manage settings | ✔ | | | | | |
| Manage roles & permissions | ✔ | | | | | |
| View audit log | ✔ | ✔ | | | | |
| Edit ranks & medals (Award medals / Change rank) | ✔ | ✔ | | | | |
| Manage applications | ✔ | ✔ | ✔ | | | |
| Create / manage events | ✔ | ✔ | ✔ | | | |
| Moderate gallery | ✔ | ✔ | ✔ | | | |
| Reveal event passwords | ✔ | ✔ | ✔ | ✔ | ✔ | |
| Submit to gallery | ✔ | ✔ | ✔ | ✔ | ✔ | |
| RSVP to events | ✔ | ✔ | ✔ | ✔ | ✔ | |
| View members directory | ✔ | ✔ | ✔ | ✔ | ✔ | |
| Apply to join | | | | | | ✔ |
| Manage regiment details | ✔ | ✔ | | | | |

> ⚠️ Stricter than the coarse `isAdmin` tier: **View audit log** and **Edit ranks & medals** are
> Owner+Admin **only** (Moderator excluded); **Manage settings** is Owner only. Enforce from this table,
> not from `role ∈ {Owner,Admin,Moderator}`.

> ⚠️ **Edit ranks & medals reaches the whole roster** (T-0211). Unlike **Manage roles**, it is not
> narrowed by the target's standing: whoever holds it may set the rank and award or remove the medals of
> _any_ member — a peer, a senior, the regiment owner — and is refused only on their own record. Granting
> it to Moderator in the settings matrix therefore hands over the regiment's whole service record, not
> just the junior half of it. It confers no authority: no role, suspension or ban moves with it.

> **Manage regiment details** (`manage_regiment_details`, T-0145) is a *publishing* right, not an
> ownership right: it governs the landing/sign-in presentation and the three legal documents — the copy
> the whole internet sees — and deliberately grants nothing else. It is separate from **Manage settings**
> so the person who writes the copy does not also receive the permission matrix or the Discord binding.
> Adding a capability needs no migration: `capability` is `varchar(60)`, and
> `seedRolePermissions` is tier 1 but insert-only per row, so the new default grants back-fill onto a
> live database while every admin edit survives untouched.
>
> **Removing one DOES need a migration.** The seeder is insert-only in both directions — it never
> deletes — so dropping a member from the `Capability` enum leaves its `role_permissions` rows behind on
> an already-provisioned database as invisible, un-editable dead grants. The retirement must ship a data
> purge (`DELETE FROM role_permissions WHERE capability = '…'`); see
> `1784900000000-RetireTransferOwnership.ts`, which retired `transfer_ownership` in T-0170 together with
> `POST /settings/transfer-ownership` and `POST /settings/transfer-discord`. `POST /discord/bind` is now
> the sole guild binder, and `POST /settings/dissolve` is gated on the Owner **role** rather than a
> capability, because every capability is delegable from this matrix and dissolution must not be.

#### `service_record_entries`
Member promotion/award/service timeline (hardcoded in profile today).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `member_id` | char(36) NOT NULL | FK |
| `regiment_id` | char(36) NOT NULL | FK |
| `occurred_at` | timestamp NOT NULL | |
| `type` | varchar(40) NOT NULL | `enlistment` / `promotion` / `award` / `deployment` |
| `event` | varchar(160) NOT NULL | short label |
| `note` | text NULL | |
| `created_at` | timestamp | |

#### `account_deletion_requests`
GDPR deferred deletion (requires out-of-band Discord acknowledgement — **not** an immediate hard delete).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `member_id` | char(36) NOT NULL | FK |
| `confirm_token` | varchar(64) NOT NULL | for the Discord callback confirm endpoint |
| `acknowledge_permanent` | boolean NOT NULL | gating consent (required true) |
| `acknowledge_data_downloaded` | boolean NOT NULL | gating consent (required true) |
| `discord_reauthenticated_at` | timestamp NULL | required Discord re-auth |
| `status` | enum `account_deletion_status` NOT NULL DEFAULT `'pending_discord_confirmation'` | |
| `requested_at` | timestamp NOT NULL | |
| `confirmed_at` | timestamp NULL | |
| `executed_at` | timestamp NULL | |

Indexes: `UNIQUE(confirm_token)`, `INDEX(member_id)`.
Erasure scope on execute: purge profile/rank/medal/application/gallery/RSVP rows; **retain** audit
(anonymise after `audit_retention_months`).

---

### 3.3 Events

#### `events`
Collapses the stub's split `date` + `HH:mm` + tz into UTC datetimes; multi-valued attributes → junctions.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL | FK |
| `created_by_member_id` | char(36) NULL | FK → `members.id` |
| `title` | varchar(160) NOT NULL | |
| `description` | text NULL | the "orders" / briefing |
| `banner_url` | varchar(512) NULL | supports animated GIF |
| `starts_at` | datetime NOT NULL | UTC |
| `ends_at` | datetime NULL | UTC |
| `timezone` | varchar(40) NOT NULL DEFAULT `'UTC'` | display tz |
| `is_recurring` | boolean NOT NULL DEFAULT false | resolves model(string) vs form(boolean) conflict |
| `recurrence_rule` | varchar(120) NULL | `None`/`Weekly`/`Monthly` or RRULE |
| `announce_role_id` | varchar(20) NULL | Discord role pinged **once**, when the announcement is posted (T-0205). Cloned onto every generated recurrence occurrence, so each occurrence pings once |
| `server_name` | varchar(120) NULL | |
| `server_password` | text NULL | **AES-256-GCM encrypted; never in public/unauth responses; reveal is audited** |
| `server_region` | varchar(40) NULL | |
| `status` | enum `event_status` NOT NULL DEFAULT `'upcoming'` | authoritative server-maintained state (the domain has an audited `EVENT_COMPLETED` transition and curated `outcome`); a scheduled job advances it — never client-trusted |
| `expected_attendance` | int NULL | |
| `attendance_goal` | int NULL | "30 muskets" |
| `outcome` | varchar(160) NULL | past-event result/score |
| `twitch_url` | varchar(255) NULL | |
| `started_at` | datetime NULL | live-event marker |
| `in_line_count` | int NULL | live attendance |
| `is_draft` | boolean NOT NULL DEFAULT false | |
| `is_archived` | boolean NOT NULL DEFAULT false | |
| `created_at` / `updated_at` | timestamp | |
| `deleted_at` | timestamp NULL | soft-delete |

Indexes: `INDEX(regiment_id, status)`, `INDEX(starts_at)`.
Derived: `rsvp_counts` ← `GROUP BY event_rsvps.status`.

#### `event_rsvps` (junction)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `event_id` | char(36) NOT NULL | FK |
| `member_id` | char(36) NOT NULL | FK |
| `status` | enum `rsvp_status` NOT NULL | "No reply" = absence of row |
| `reminder_offset_minutes` | int NULL | per-member reminder |
| `responded_at` | timestamp NULL | |
| `updated_at` | timestamp | |

Indexes: `UNIQUE(event_id, member_id)`. Password reveal is gated on
`status ∈ {interested,tentative}`.

#### `event_attendees` (junction — attendance, distinct from RSVP intent)
| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | char(36) | FK, part of composite PK |
| `member_id` | char(36) | FK, part of composite PK |
| `checked_in_at` | timestamp NULL | |

PK: `(event_id, member_id)`.

#### `event_platforms` (junction)
| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | char(36) | FK |
| `platform` | enum `platform` | |

PK: `(event_id, platform)`.

#### `event_tags` (junction)
| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | char(36) | FK |
| `tag` | varchar(40) | free-form, e.g. `line-battle` |

PK: `(event_id, tag)`.

#### `event_notify_offsets` (junction)
Normalizes `notifyBefore` codes/labels to integer **minutes**, multi-offset.

| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | char(36) | FK |
| `minutes` | int | e.g. 15, 30, 60, 1440 |
| `sent_at` | datetime(6) NULL | when the reminder sweep claimed this offset — `NULL` means still due (T-0174) |

PK: `(event_id, minutes)`.

> `sent_at` is what makes reminders **at-most-once across a restart**. The sweep claims a row with a
> conditional `UPDATE … WHERE sent_at IS NULL` and only enqueues when exactly one row was affected,
> so two ticks — or two processes — can never both fire the same reminder. It is also stamped on
> offsets the sweep deliberately *retires* without sending (an offset whose event has already
> started, or the redundant ones when several come due at once after an outage), so a long downtime
> produces one honest "starts soon" rather than a burst of stale reminders. An author re-saving the
> same lead times mid-event carries `sent_at` across the wipe-and-rewrite rather than resurrecting a
> spent offset.

#### `event_announcements` (1—1 with `events`, PK = FK)
Where an event's Discord announcement actually **landed** (T-0205). Written by the outbox worker
after the post succeeds, so a row's *presence* is the answer to "has this been announced?".

| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | char(12) PK | FK → `events.id`, `ON DELETE CASCADE` |
| `channel_id` | varchar(20) NOT NULL | the channel **at post time** — an admin may re-point the setting later, but the message does not move |
| `message_id` | varchar(20) NOT NULL | the announcement itself: the anchor for every re-render and for the thread |
| `thread_id` | varchar(20) NULL | the pre-event thread, once opened. Also the once-only guard on the ping |
| `closed_at` | datetime(6) NULL | when the RSVP buttons were disabled because the event ended |
| `created_at` | datetime(6) NOT NULL | |

> This is **delivery state, not event state**, which is why it is a table and not four nullable
> columns on `events`: it exists only once a message has really been posted, it is written by the
> bot rather than by an author, and an event created while the bot was off has none of it.
>
> The announcement is the RSVP surface. Its embed carries three sections — **Attending / Tentative /
> Declined** — rendered from `event_rsvps`, and three buttons that write back to the same table. A
> press is authorised through `SessionContextService` + the `rsvp_to_events` capability, exactly as
> the HTTP route is, so a banned member cannot RSVP by pressing a button. Buttons stay **live** until
> the event ends; `closed_at` is what stops the retirement sweep revisiting an announcement forever.

---

### 3.4 Gallery

#### `gallery_items`
`submittedBy` (name string in stubs) normalized to `author_member_id`; `likes`/`file_count` derived;
`taggedMembers`/`likes` → junctions; multi-file → child table.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL | FK |
| `author_member_id` | char(36) NOT NULL | FK → `members.id` (was a name string) |
| `event_id` | char(36) NULL | FK → `events.id` (linked event) |
| `moderated_by_member_id` | char(36) NULL | FK → `members.id` |
| `title` | varchar(160) NOT NULL | |
| `caption` | varchar(512) NULL | |
| `type` | enum `gallery_type` NOT NULL | |
| `link_url` | varchar(512) NULL | for `link` type |
| `thumbnail_url` | varchar(512) NULL | |
| `status` | enum `gallery_status` NOT NULL DEFAULT `'pending'` | public shows `approved` only |
| `decline_reason` | varchar(255) NULL | mod-only |
| `is_draft` | boolean NOT NULL DEFAULT false | |
| `submitted_at` | timestamp NOT NULL | |
| `approved_at` | timestamp NULL | |
| `created_at` / `updated_at` | timestamp | |
| `deleted_at` | timestamp NULL | soft-delete |

Indexes: `INDEX(regiment_id, status)`, `INDEX(author_member_id)`, `INDEX(event_id)`.
Derived: `likes` ← `COUNT(gallery_likes)`, `file_count` ← `COUNT(gallery_files)`.

#### `gallery_files` (child, 1—*)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `gallery_item_id` | char(36) NOT NULL | FK |
| `file_name` | varchar(255) NOT NULL | |
| `url` | varchar(512) NULL | media URL (no S3 — store URL/ref only) |
| `media_type` | enum `gallery_media_type` NOT NULL | |
| `size_bytes` | bigint NULL | |
| `width` / `height` | int NULL | |
| `duration_seconds` | int NULL | video |
| `caption` | varchar(255) NULL | |
| `thumbnail_color` | char(7) NULL | placeholder colour |

#### `gallery_tagged_members` (junction)
| Column | Type |
| --- | --- |
| `gallery_item_id` char(36) FK | PK part |
| `member_id` char(36) FK | PK part |

PK: `(gallery_item_id, member_id)`.

#### `gallery_likes` (junction — backs the `likes` count)
| Column | Type | Notes |
| --- | --- | --- |
| `gallery_item_id` | char(36) FK | PK part |
| `member_id` | char(36) FK | PK part |
| `liked_at` | timestamp | |

PK: `(gallery_item_id, member_id)`.

---

### 3.5 Applications

#### `applications`
Two independent axes: `status` and the `is_reapplication` flag. `applicantName`/`discordTag` come from
the OAuth session, not the form.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL | FK |
| `discord_identity_id` | char(36) NULL | FK → `discord_identities.id` |
| `promoted_member_id` | char(36) NULL | FK → `members.id` (set on approval) |
| `decided_by_member_id` | char(36) NULL | FK → `members.id` |
| `applicant_name` | varchar(120) NOT NULL | from Discord |
| `discord_tag` | varchar(64) NULL | from Discord |
| `in_game_name` | varchar(120) NOT NULL | min 2 |
| `platform` | enum `platform` NOT NULL | unified from loose string |
| `applicant_type` | enum `applicant_type` NOT NULL DEFAULT `'Applicant'` | |
| `timezone` | varchar(40) NULL | IANA tz |
| `why_join` | text NOT NULL | min 30, max 800 |
| `how_found` | enum `how_found` NOT NULL | stored enum value (the human label is derived in code — no stored `source` column, which would be a 3NF transitive dependency) |
| `prior_experience` | varchar(600) NULL | optional |
| `age_confirmed` | boolean NOT NULL DEFAULT false | required true (≥16 consent) |
| `age_confirmed_at` | timestamp NULL | |
| `status` | enum `application_status` NOT NULL DEFAULT `'pending'` | |
| `is_reapplication` | boolean NOT NULL DEFAULT false | derived: prior apps by same `discord_user_id` |
| `discord_in_server` | boolean NOT NULL DEFAULT false | |
| `mutual_events_count` | int NOT NULL DEFAULT 0 | |
| `moderator_note` | text NULL | private → audit |
| `discord_dm_message` | text NULL | sent on decision |
| `decline_reason` | varchar(255) NULL | |
| `is_draft` | boolean NOT NULL DEFAULT false | |
| `submitted_at` | timestamp NOT NULL | |
| `decided_at` | timestamp NULL | |
| `created_at` / `updated_at` | timestamp | |

Indexes: `INDEX(regiment_id, status)`, `INDEX(discord_identity_id)`.
Cardinality: a Discord identity may submit **many** applications over time (decline → reapply), so it
is `discord_identities 1—* applications`; each application optionally promotes to **one** member via
`promoted_member_id` (`application *—0..1 members`). There is no 1—1 member↔application relationship.

---

### 3.6 Audit & notifications

#### `audit_log_entries` (generic, polymorphic, append-only)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK auto-increment | UI shows numeric ids (#18432) |
| `regiment_id` | char(36) NOT NULL | FK |
| `request_id` | varchar(64) NULL | correlation id |
| `occurred_at` | timestamp NOT NULL | |
| `actor_member_id` | char(36) NULL | FK → `members.id` (null for bot/system) |
| `actor_type` | enum `audit_actor_type` NOT NULL | `member`/`bot`/`system` |
| `actor_label` | varchar(120) NULL | denormalized ("System", "Quartermaster") |
| `actor_ip` | varchar(45) NULL | masked |
| `action` | varchar(64) NOT NULL | open set → `audit_actions` (e.g. `application.approve`) |
| `severity` | enum `audit_severity` NOT NULL DEFAULT `'info'` | independently stored |
| `target_type` | varchar(32) NULL | polymorphic: `user`/`event`/`rank`/`medal`/`role`/`gallery`/`settings`/`application` |
| `target_id` | varchar(64) NULL | **soft reference** (target may be deleted/anonymised) |
| `target_member_id` | char(36) NULL | FK when the target is a member |
| `target_label` | varchar(120) NULL | denormalized target tag |
| `detail` | text NULL | |
| `before_value` | json NULL | generic before/after capture |
| `after_value` | json NULL | |
| `discord_sync_status` | enum `discord_sync_status` NULL | was the side-effect mirrored to Discord |
| `anonymised_at` | timestamp NULL | GDPR retention/anonymisation |

Indexes: `INDEX(regiment_id, occurred_at)`, `INDEX(action)`, `INDEX(severity)`,
`INDEX(actor_member_id)`, `INDEX(target_member_id)`. No update/delete API.

#### `audit_actions` (lookup)
| Column | Type | Notes |
| --- | --- | --- |
| `code` | varchar(64) PK | `application.approve`, `rank.change`, `event.password.reveal`, … |
| `label` | varchar(120) NOT NULL | human label |
| `default_severity` | enum `audit_severity` NOT NULL DEFAULT `'info'` | |

#### `notifications` (Field Dispatches)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL | FK |
| `title` | varchar(160) NOT NULL | |
| `body` | text NOT NULL | |
| `tone` | enum `notification_tone` NOT NULL DEFAULT `'info'` | |
| `author_label` | varchar(120) NULL | |
| `created_at` | timestamp | |

#### `notification_reads` (junction — per-member read state)
| Column | Type | Notes |
| --- | --- | --- |
| `notification_id` | char(36) FK | PK part |
| `member_id` | char(36) FK | PK part |
| `read_at` | timestamp NOT NULL | |

PK: `(notification_id, member_id)`. Unread count = notifications without a read row for the member.

---

### 3.7 Discord bot status (read-only — bot is NOT built)

#### `discord_connections` (1—1 regiment)
Persist/serve the bot's reported status shape only. The single mutation is "resolve operation".

| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `regiment_id` | char(36) NOT NULL UNIQUE | FK |
| `bot_version` | varchar(20) NULL | |
| `connection_status` | enum `bot_connection_status` NOT NULL DEFAULT `'idle'` | |
| `bot_role_position` | int NULL | must sit high (#2 of 14) to edit roles |
| `total_roles` | int NULL | |
| `roles_under_authority` | int NULL | |
| `members_visible` | int NULL | |
| `last_heartbeat_at` | timestamp NULL | |
| `last_full_sync_at` | timestamp NULL | |
| `uptime_seconds` | bigint NULL | |
| `permissions` | json NULL | granted permission checks |
| `required_permissions` | json NULL | |
| `created_at` / `updated_at` | timestamp | |

> The Discord server id/name live on `regiments` (read through the FK) — not duplicated here, to avoid
> divergence.

#### `bot_operations` (child, 1—*)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | char(36) PK | uuid |
| `discord_connection_id` | char(36) NOT NULL | FK |
| `occurred_at` | timestamp NOT NULL | |
| `operation` | varchar(255) NOT NULL | description |
| `success` | boolean NOT NULL | |
| `resolvable` | boolean NOT NULL DEFAULT false | `needsResolve`; resolve flips it |

#### `discord_sync_jobs` (transactional outbox)
App mutations enqueue a job instead of calling Discord inline, so the API never blocks on — or is
broken by — the gateway. Key columns beyond the obvious:

| Column | Type | Notes |
| --- | --- | --- |
| `job_type` | varchar(40) | a `DiscordSyncJobType`; varchar, so a new type needs no migration |
| `status` | enum | `pending` \| `processing` \| `succeeded` \| `failed` \| `cancelled` |
| `batch_id` | char(36) NULL | groups every job of ONE bulk run (T-0158) |
| `payload` | json NULL | job-kind-specific; carries `content` and/or a structured `embed` (T-0172) |

> **`event.reminder`** joined `DiscordSyncJobType` with the reminder sweep (T-0174), deliberately as
> its own type rather than reusing `announce`, so the operations ledger and the delivery matrix can
> tell "an event was created" from "an event is about to start". Because `job_type` is a varchar it
> needed no migration.
>
> **`payload` is `json`, which is why embeds needed no migration either.** A row may carry `content`,
> an `embed`, or both. Jobs already sitting in the outbox when the embed transport deployed carry
> only `content` and still deliver as plain text — the worker passes no embed argument at all for
> those, so the call is byte-identical to the pre-T-0172 one.

> **`batch_id`** ties together a bulk Discord role re-link: the cursor job, each of its re-enqueued
> successors, and every per-member job it expands into. Progress and cancel (T-0160) are computed by
> grouping on it rather than from in-memory state, so both survive an API restart. Index
> `(regiment_id, batch_id, status)` exists specifically for that endpoint, which every open admin tab
> polls — without it each poll would scan the whole outbox.
>
> **`cancelled` is distinct from `failed` on purpose:** an operator-stopped run is not an error and
> must not burn retries or be reported as a failure. Work already applied before the cancel is NOT
> rolled back; the run is reported as *partial*.
>
> A re-link expands in bounded, resumable pages rather than one large insert, so memory stays flat,
> a killed process resumes from its cursor, and there is a cancel point between pages. The drain loop
> reserves part of each tick for non-bulk job types so a 600-member fan-out cannot starve
> time-sensitive work (welcome DMs, decision DMs, announcements) queued behind it.

---

## 4. Entity-relationship summary

```
regiments ─1:1─ regiment_settings
regiments ─1:1─ discord_connections ─1:*─ bot_operations
regiments ─1:*─ regiment_documents        (PK (regiment_id, slug); author SET NULL)
regiments ─1:*─ {members, ranks, medals, events, gallery_items, applications,
                 audit_log_entries, notifications, service_record_entries, role_permissions}
accent_tones ─1:*─ regiments (by key)

discord_identities ─1:0..1─ members       (identity = account; member created at application time)
discord_identities ─1:*─ applications      (application *─0..1 members via promoted_member_id)
ranks ─1:*─ members
members ─*:*─ medals            (via member_medals: detail, awarded_at, awarded_by)
members ─1:*─ service_record_entries
members ─1:*─ account_deletion_requests

events ─1:*─ event_rsvps ─*:1─ members
events ─*:*─ members            (via event_attendees)
events ─1:*─ {event_platforms, event_tags, event_notify_offsets}
events ─1:0..1─ event_announcements  (delivery state: where the Discord post landed)
events ─1:*─ gallery_items (optional link)

gallery_items ─1:*─ gallery_files
gallery_items ─*:*─ members     (via gallery_tagged_members, gallery_likes)

notifications ─*:*─ members     (via notification_reads)
audit_log_entries ─*:0..1─ members (actor / target — soft polymorphic target)
```

---

## 5. The authentication / identity model (sign-in focus)

The frontend has **no real auth** — `AuthService` returns a hardcoded `STUB_USER`; `login` does
`setTimeout → navigate('/dashboard')`. The backend owns the whole Discord OAuth2 + session lifecycle.

**"A proper user record"** = a `discord_identities` row — the canonical account/identity. Sign-in
creates/updates exactly this row. It does **not** create a `members` (roster) row; that happens when
the person actually applies, so logging in out of curiosity never pollutes the roster. If a member is
already linked to the identity (existing roster member, or the seeded owner), sign-in resolves it for
the session.

### OAuth2 authorization-code flow

1. `GET /api/auth/discord` → 302 to Discord's authorize URL (scopes `identify email guilds`, `state`
   anti-CSRF cookie).
2. User authorizes; Discord redirects to `GET /api/auth/discord/callback?code&state`.
3. Backend exchanges `code` → access/refresh tokens; fetches the Discord user (`/users/@me`) and guilds
   (`/users/@me/guilds`).
4. **Upsert `discord_identities`** by `discord_user_id` — the proper user record (store encrypted
   tokens, scopes, avatar, `global_name`, `discord_tag`, `guild_member` = guild list contains
   `DISCORD_GUILD_ID`, `last_sign_in_at/ip`). New identity → insert; returning → update.
5. **Resolve the linked member, if any:** if the identity already has a `members` row (existing roster
   member or seeded owner), load it and bump `last_seen_at`. Otherwise the session is identity-only —
   the frontend routes such users to `/apply`. No member row is created here.
6. Issue a **JWT** `{ sub: identity.id, mid: member?.id ?? null, did: discord_user_id, role, rid:
   regiment_id }`; redirect to `FRONTEND_AUTH_SUCCESS_REDIRECT` with a short-lived handoff (or set an
   httpOnly cookie).

### Endpoints (this phase)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/auth/discord` | public | Begin OAuth — redirect to Discord |
| GET | `/api/auth/discord/callback` | public | Handle code, upsert identity+member, issue JWT |
| GET | `/api/auth/me` | member | Return `CurrentUser` projection |
| POST | `/api/auth/logout` | member | Invalidate session (clear cookie) |

`CurrentUser` projection (exact frontend shape): `{ id, name, rank, role, discordTag, discordLinked,
avatarUrl }`. When the identity has no linked member, `/auth/me` returns the identity-derived subset
(`name` = Discord global name, `role` = `Applicant`, `rank` = `null`) plus `isMember: false` so the
client can route to `/apply`.

### Authorization

- `JwtAuthGuard` registered globally; `@Public()` opts routes out.
- `RolesGuard` + `@Roles(...)` for coarse checks; capability checks consult `role_permissions`
  (stricter — see §3.2). The matrix is **seeded** now; the capability guard is wired as feature
  endpoints arrive.
- **Target-scoped rule** for the member admin actions (`src/members/member-hierarchy.ts`). A
  capability knows the caller's role and nothing about who they are pointing at, so every action on
  another member passes a second, per-target guard. Two tiers:
  - _Moderation_ — role, suspend, unsuspend, ban, unban: never yourself, never the
    `regiments.owner_member_id` pointer, and only against a **strictly lower** role, so peers cannot
    moderate each other. The role a caller may _grant_ is capped at their own tier (`canGrantRole`).
  - _Rank & medals_ — rank, medal award/remove, derive-from-discord: never yourself, and no other
    restriction (T-0211). A decoration is a record, not authority.
  - The same predicate produces the `permittedActions` block on `MemberDto`, so the client is never
    offered an action the endpoint would refuse. A single target's block can mix `true` and `false`
    across the two tiers.

### Future REST surface (confirmed by frontend service TODOs — built after sign-in)

`/api/members` (GET, GET/:id, PATCH/:id) · `/api/ranks` · `/api/medals` · `/api/events` (GET, POST,
PATCH/:id, GET/:id with conditional `server_password`, `/:id/rsvp`, `/:id/reveal-password`) ·
`/api/gallery` (GET, POST, `/:id/approve|decline`, `/:id/like`) · `/api/applications` (GET, POST,
`/:id/approve|decline|hold`) · `/api/audit` (GET `?severity=`) · `/api/settings` · `/api/regiment/stats`.

---

## 6. Migrations & seeders

- **Migrations** (`src/database/migrations`): one initial migration creates the entire schema above
  (`npm run migration:run`). Generated from the entities, reviewed for FK order and index correctness.
- **Seeders** (`src/database/seeds`, idempotent upserts):
  1. `accent_tones` — the 6 tones with hex.
  2. `regiment` (single tenant) + `regiment_settings` defaults.
  3. `ranks` — default ladder (Colonel … Recruit, Applicant) with precedence/chevrons.
  4. `medals` — a small default catalog.
  5. `role_permissions` — the full capability matrix from §3.2.
  6. `audit_actions` — the known action codes.
  7. A **dev owner** member + Discord identity fixture so admin flows and `/auth/me` are testable
     without a live Discord login.

---

## 7. Open items flagged for product confirmation (not blocking)

- Gallery limits and audit-retention months conflict across UI passes — defaults chosen above, all
  runtime-configurable.
- `allow_mercenaries`, `auto_approve_trusted_members`, custom roles, Officers' Mess, landing hero
  stats, and a "season" concept exist only in wireframes — modeled/derivable but UIs are not all built.
- Suspended/Banned are modeled as timestamps (`suspended_until`, `banned_at`), not `member_status`
  values.
- Whether a medal can be awarded twice (currently `UNIQUE(member_id, medal_id)`).
