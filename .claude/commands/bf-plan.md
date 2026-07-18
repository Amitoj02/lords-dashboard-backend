---
description: Break a goal into planned Blueframe tasks (no code)
argument-hint: "<goal>"
---

Break the following goal into tasks in `.blueframe/state.json`, all with status `planned`:

$ARGUMENTS

For each task set a `title`, a 1-3 sentence `summary`, a `size` with the
matching `sizeWeight`, its PM hierarchy — `area` (module), `feature` (the
durable capability, REUSED across every task on it) and `subfeature` when
the task is one control within a feature — likely `paths`, `dependsOn`
relationships (cross-repo: `"<repoKey>:T-####"`), and a concrete `testPlan`.
Allocate fresh non-colliding `T-####` ids. When several tasks build or
refine the same capability, give them the SAME `area`+`feature` so the Orbit
PM lens shows one feature node — not one node per task.

If a planned task exists to fix an open `regressionRisk` on another task,
link them: set the new task's `resolvesRisk` to the risk ref
`"<taskId>#<riskIndex>"` (e.g. `"T-0021#0"`) so deploying it auto-resolves
the risk.

**Do not write any code.** Only update the state file. Report the plan you
created as a short list.

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
  "area": "dashboard",
  "feature": "events",
  "subfeature": "view-archived",
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
`skippedByClaude`, `paths`, `dependsOn` and `blocks` are arrays of PLAIN
STRINGS (one short sentence each) — NEVER objects. Writing an object into
`skippedByClaude` makes the whole file fail validation and the repo shows as
broken.

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

**Project-Manager hierarchy (`area` → `feature` → `subfeature`):** the Orbit
Project-Manager lens renders ONE node per *feature*, not one per task — many
work-tasks roll up into the same feature. Tag related tasks with a shared,
durable, product-facing hierarchy so they collapse together instead of
littering the map:
- `area` = the top-level **module / bounded context** (the planet): a broad
  product domain like `dashboard`, `discord-bot`, `auth`, `platform`. Aim for
  ~3–8 modules across the whole repo — NEVER one repo-wide `area`. In a
  monorepo the package name (`packages/web` → `web`) is a fine module.
- `feature` = the durable **capability** under that module (a moon): `events`,
  `gallery`, `applications`. Reuse the SAME `feature` string on every task
  that builds, fixes or extends it, so they become one feature node.
- `subfeature` = a specific **control / slice** within that feature (a
  sub-moon): `view-archived`, `rsvp`. Optional — omit when the task IS the
  whole feature.
Name `feature`/`subfeature` as short **product nouns** (`view-archived`), NOT
as the task title (`Add "View archived" events control for moderators`). The
task keeps its descriptive `title`; these are the short, stable labels the PM
map shows. Pure infra/chore with no product feature may omit `feature` — it
still counts toward its module gauge but draws no moon.
**Cross-repo dependencies:** a `dependsOn` entry may reference a task in another
workspace repo as `"<repoKey>:T-####"`; bare `T-####` ids are always local to
this repo. Leave the `repo` field as `""` — the workspace layer supplies it.

Keep existing key order; edit the file in place with minimal changes.
