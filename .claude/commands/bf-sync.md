---
description: Reconcile new commits into Blueframe state
---

Read the `lastSyncedCommit` from `.blueframe/state.json`, then run
`git log <lastSyncedCommit>..HEAD` (if it is empty, review recent history).

Reconcile every commit into the state file:
- Advance task `status` values to match what the commits actually did.
- Add `regressionRisk` entries (status `open`) for shared/core code that
  was touched.
- Re-check every OPEN `regressionRisk` across ALL tasks against the new
  commits: if a commit addressed or retired the risk (the fix landed, a
  regression test now pins it, or the risky code was removed), set its
  `status` to `resolved` with `resolvedAt`, `resolvedBy` (the fixing task
  id, or `"sync"` when no task applies), and a short `note` citing the
  evidence (commit sha, test, or file). If the commits give no such
  evidence, leave it `open` — never delete a risk entry.
- When you add a task that fixes an open risk, link them: set the new
  task's `resolvesRisk` to the risk ref `"<taskId>#<riskIndex>"` (e.g.
  `"T-0021#0"`) so deploying it auto-resolves the risk.
- Append `skippedByClaude` items for anything deliberately deferred.
- Update `testPlan` items and add new tasks for newly discovered work.
- Append a `history` entry for each status change.
- Set `lastSyncedCommit` to the current HEAD and `lastSyncedAt` to now.

Keep diffs minimal and preserve key order. Report a summary of the
reconciliation (statuses advanced, risks added and resolved, tasks created).

### state.json schema (produce EXACTLY this shape — it is validated)

Top level: `{ "version": 1, "project": "<name>", "lastSyncedCommit": "<sha|null>",
"lastSyncedAt": "<ISO-8601|null>", "notesForNextSession": "<text>",
"connections": [], "tasks": [ <Task>, ... ] }`

Each **Task** object (every field required unless noted):
```json
{
  "id": "T-0001",
  "title": "short title",
  "summary": "1-3 sentences",
  "status": "planned",
  "type": "feature",
  "size": "M",
  "sizeWeight": 3,
  "area": "auth",
  "repo": "",
  "paths": ["src/foo.ts"],
  "dependsOn": [],
  "blocks": [],
  "questions": [{ "q": "text?", "answer": null, "askedAt": "2026-01-01T00:00:00Z" }],
  "testPlan": [{ "desc": "case", "status": "pending" }],
  "regressionRisk": [{ "desc": "shared parser touched", "status": "open", "notedAt": "2026-01-01T00:00:00Z" }],
  "skippedByClaude": [],
  "lastTouchedCommit": null,
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z",
  "history": [{ "at": "2026-01-01T00:00:00Z", "from": null, "to": "planned", "by": "claude", "note": "created" }]
}
```
Enums — `status`: planned | in_progress | questionnaire | review | test | deploy_ready | deployed | blocked | archived.
`type`: feature | bug | chore | infra | question | spike. `size`: XS | S | M | L | XL
with `sizeWeight` XS=1, S=2, M=3, L=5, XL=8. `testPlan[].status`: pending | passed | failed.
`history[].by`: claude | human | system. `questions[].answer` is null until answered.
All timestamps are ISO-8601 strings. `id` must be unique and never reused.

**Risk lifecycle:** each `regressionRisk` entry is an object
`{ "desc", "status": "open" | "resolved", "notedAt"?, "resolvedAt"?, "resolvedBy"?, "note"? }`.
Write new risks with status `open`. When resolving one, set `resolvedAt`,
`resolvedBy` (the fixing task id, or `"human"`/`"sync"`), and a short `note`
citing the evidence. Legacy bare-string entries are read as open risks —
always write the object form. A task may carry an OPTIONAL `resolvesRisk`
array of risk refs `"<taskId>#<riskIndex>"` (e.g. `"T-0021#0"`) naming the
open risks it retires; when that task reaches `deployed`, those
risks are auto-resolved. Omit `resolvesRisk` entirely when a task retires
nothing.

**Monorepo convention:** set `area` to the package/workspace dir name
(`packages/web` → `web`) so tasks group by package in the UI.
**Cross-repo dependencies:** a `dependsOn` entry may reference a task in another
workspace repo as `"<repoKey>:T-####"`; bare `T-####` ids are always local to
this repo. Leave the `repo` field as `""` — the workspace layer supplies it.

Keep existing key order; edit the file in place with minimal changes.
