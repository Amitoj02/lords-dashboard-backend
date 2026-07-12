# Discord go-live runbook (mock → real)

The whole product runs today with **no Discord app** — both the OAuth sign-in and the
"Quartermaster" bot are mocked in-process. This is the checklist to swap in the real
Discord integration when the credentials are ready. Nothing in the code changes; it is
all environment configuration + a Developer-Portal setup.

## 1. Discord Developer Portal
1. **Application** → note the **Application (Client) ID**.
2. **OAuth2** → copy the **Client ID** + **Client Secret**; add the redirect URI:
   - dev: `http://localhost:4200/api/auth/discord/callback`
   - prod: `https://lordsofholdfast.com/api/auth/discord/callback`
   - scopes used: `identify email guilds`.
3. **Bot** → add a bot, copy the **Bot Token**. Enable the **SERVER MEMBERS INTENT**
   (privileged) — the bot needs it to see members and manage roles.
4. Invite the bot to the guild with the `bot` scope and the **Manage Roles** +
   **Kick Members** + **Send Messages** permissions.
5. In the guild, **drag the bot's role ABOVE every role it will manage** (a bot can only
   assign/remove roles below its own highest role) and note the **Guild (Server) ID**.

## 2. Environment (set these, then restart the API)
```env
# OAuth sign-in — flip off the mock
DISCORD_MOCK=false
DISCORD_CLIENT_ID=<client id>
DISCORD_CLIENT_SECRET=<client secret>
DISCORD_GUILD_ID=<guild id>

# The Quartermaster bot — flip off the mock
DISCORD_BOT_MOCK=false
DISCORD_BOT_TOKEN=<bot token>
DISCORD_APPLICATION_ID=<application id>
```
`DISCORD_MOCK`/`DISCORD_BOT_MOCK` also auto-disable when the corresponding client id /
bot token is set, but set them explicitly in prod to be safe. No code changes, no
redeploy of the image — just env + restart.

## 3. Wire the bot from the admin UI (Settings → Discord / Quartermaster)
1. **Bind** the guild (or confirm `DISCORD_GUILD_ID`), then **Verify connection** — it
   should report `connected`, the bot's role position, and the visible member count.
2. Set the **announcement channel** and the **Guest join-role** (from the role picker).
3. Turn **botEnabled = ON**. Until this is on, no sync jobs are enqueued at all.
4. Map ranks/medals to Discord roles (Ranks/Medals admin → link-discord) so role sync
   has something to assign.
5. **Resync** to enqueue a role reconciliation for every linked member; watch the
   **Operations** list drain (failures show up as resolvable operations).

## 4. ⚠️ The sensitive one: ban → Discord kick (`kickOnBan`)
Per the owner's decision (questionnaire T-0027 Q4), an app-side ban **may** also kick the
member from the Discord guild — but this is **OFF by default** and must be turned on
deliberately. The code is gated in two places (enqueue-time *and* execution-time), so:
- With `kickOnBan = false` (default), a ban **never** touches Discord.
- Turning it on is an audited Settings change; even after a kick is queued, the worker
  **re-checks** `kickOnBan` + `botEnabled` at drain time and skips the kick if either was
  turned back off.

**Re-review this flow with the regiment owner before enabling it in production.** It is
irreversible from the member's side (they get kicked from the server).

## 5. Post-go-live smoke test
- Real Discord sign-in → `/auth/me` resolves the Owner.
- Change a linked member's rank → a `role.sync` job drains and the Discord role changes.
- Compose an announcement → it posts to the configured channel.
- A test member joins the guild → welcome + Guest role fire.
- (Only if `kickOnBan` is intentionally enabled) ban a throwaway member → they are kicked;
  confirm the `member.kick` audit + bot-operation.
