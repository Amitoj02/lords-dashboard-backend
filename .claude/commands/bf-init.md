---
description: Reverse-engineer this codebase into Blueframe state
---

Scan this codebase. Reverse-engineer the current feature set into `.blueframe/state.json`:

- Record clearly-completed, shipped work as tasks with status `deployed`, and
  work that exists but looks unverified as `review`.
- Record obvious gaps / TODOs as `planned` tasks.
- Record uncertainties as tasks in status `questionnaire`, each with concrete
  `questions` for the human.
- Give every task a stable `id` (`T-####`, never colliding), a `size`
  (XS/S/M/L/XL) with the matching `sizeWeight` (XS=1,S=2,M=3,L=5,XL=8), an
  `area` (in a monorepo: the package name, e.g. `packages/web` → `web`), and
  the primary `paths` it touches.
- If the repo has migrations or ORM models, generate `.blueframe/schema.mmd`
  as a Mermaid ERD of the data model.

Finally set `lastSyncedCommit` to the current `git rev-parse HEAD` and
`lastSyncedAt` to now. Report a short summary of what you created.

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
