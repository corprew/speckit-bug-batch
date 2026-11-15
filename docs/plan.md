# Implementation Plan: `bug-batch` Spec Kit extension

- **Spec**: [spec.md](./spec.md)
- **Status**: Approved (#2). Amended by the T016 decision ([research.md](./research.md)).
- **Runs in**: Claude Code (local CLI or desktop) inside a Spec Kit project, macOS or Linux
- **Requires**: git ≥ 2.38, `gh` (signed in), Node ≥ 22, Spec Kit with the `bug` and `security-review` extensions installed

## 1. Approach

The extension follows the structure of `speckit-review-gate`: a manifest, Markdown command prompts, a config template, and helper scripts with tests. The work divides like this:

- **Orchestrator prompt** (`commands/speckit.bug-batch.run.md`). It runs in the maintainer's main session and is the only part that talks to the maintainer. It moves the batch through its phases and decides what runs next.
- **Worker subagents.** One per bug, started with Claude Code's Agent tool using `isolation: "worktree"`. Subagents always run in the background, so there's no flag to set. Each worker stays alive for the whole life of its bug. The orchestrator moves it to the next phase with `SendMessage`, so the worker keeps its worktree and context between phases instead of starting cold. Claude Code creates the worktree (`.claude/worktrees/agent-<id>`, branch `worktree-agent-<id>`) from a freshly fetched `origin/<base>` (spikes R1, R2, R6).
- **Workers commit at the end of every phase**, including the `.specify/bugs/<slug>/` files. Three things depend on this: Claude Code removes a worktree that has no changes when its worker finishes, reviews only see committed changes, and resuming carries over only commits (spikes R1, R2, R3b).
- **Helper scripts** (Node ESM, no dependencies). These do the parts that should be predictable rather than left to model judgment: fetching trackers, mapping paths to areas, finding conflicts, checking machine load, the heavy-job lock, batch state, worktree housekeeping, and rendering PR bodies. Node rather than bash plus PowerShell, because the logic is JSON-heavy and one implementation then covers every platform.

## 2. The orchestrator's phases

| # | Phase | Who | Output | Maintainer gate |
|---|---|---|---|---|
| 0 | Preflight | `preflight.mjs` | JSON: clean tree, `gh` auth, base fetched, `worktree.baseRef` not `head`, state folder writable (with the `sandbox.filesystem.allowWrite` entry to add if the sandbox blocks it), trackers usable, Node version, resource snapshot | Stops on failure |
| 1 | Candidates | `candidates.mjs` (GitHub REST + Linear GraphQL), then label pre-filter | Normalised candidate list | — |
| 2 | Predict and batch | Read-only `Explore` subagents (at most `max_parallel` at once) predict each candidate's files; `classify.mjs` maps them to area, hot file or excluded; `batch.mjs` picks the batch | Ranked list plus suggested batch | **Choose the batch** (AskUserQuestion, with free text for issue ids) |
| 3 | Assess | Up to `max_parallel` workers start; each runs `/speckit-bug-assess` in automated slug mode and returns a JSON summary (slug, verdict, severity, files, open questions) | `assessment.md` in each worktree | — |
| 4 | Clarify and re-check | Orchestrator groups all open questions into AskUserQuestion rounds (≤ 4 per round, grouped by bug); `batch.mjs --recheck` runs against the assessed file lists | `clarifications.md` per bug (written by its worker); deferrals; rebase-at-PR marks | **Answer questions; confirm the final batch** |
| 5 | Fix and test | Each worker runs setup (dependency install, per-worktree environment), then `/speckit-bug-fix` and the targeted tests, then `/speckit-bug-test`; every heavy step goes through `heavy-lock.mjs` | `fix.md` and `test.md`; commits on the worktree branch | — |
| 6 | Reviews | Each worker commits, then runs the configured reviews against `origin/<base>...HEAD`, and waits for the review agents' results and writes reports to `review_dir`; returns findings as JSON | Review reports | — |
| 7 | Findings | Orchestrator shows one table and asks which findings to fix, per bug (AskUserQuestion multi-select: the top findings as options, plus "Other" for ids); workers fix them and rerun the review that raised them | Updated reports | **Choose findings to fix** |
| 8 | Pull requests | Per branch: summary, then approval; on approval the worker rebases if marked rebase-at-PR (running the hot file's `regenerate` command and the targeted tests again), pushes, and opens a draft PR with `gh pr create --draft --body-file` | Draft PR URLs | **Approve each branch** |
| 9 | Close out | `worktree.mjs remove` for opened PRs, plus teardown commands; final summary of PRs, deferred bugs, kept worktrees and needs-screenshot branches | — | — |

As workers finish, the orchestrator starts the bugs waiting in the queue, so up to `max_parallel` are always active and the batch can be larger than that number.

## 3. Machine limits (NFR-1, NFR-2)

- **Bugs at once.** The orchestrator never has more than `max_parallel` workers in phases 3 to 8. Before starting one, it calls `resources.mjs check`.
- **`resources.mjs`** reads:
  - CPU count and 1-minute load average (`os.cpus()`, `os.loadavg()`)
  - free memory (`vm_stat` on macOS, `/proc/meminfo` on Linux; `os.freemem()` badly undercounts on macOS)
  - free disk (`fs.statfs`)

  It returns `{ok, reasons[]}`. Defaults: load < 0.8 × cores, ≥ 4 GB free memory, ≥ 10 GB free disk.
- **The heavy-job lock** (`heavy-lock.mjs acquire|release|status|run -- <cmd>`) is a counting semaphore of `max_heavy` slots. It's built from `mkdir` lock directories in a **per-repository** state folder: `${XDG_STATE_HOME:-~/.local/state}/speckit-bug-batch/<repo id>/locks`, where the repo id is the same hash of the origin URL used for batch state (§5). Each repository has its own `max_heavy` slots. Batches in different repositories don't share them; two batches in the same repository, or several clones of it, do. Each slot records its holder's PID and start time. A slot whose PID is dead is taken back. Acquiring waits with backoff and also waits on `resources.mjs check`. That check reads the whole machine's load, memory and disk, so a batch running in another repository still holds this one back when the machine is busy, without sharing its slots. Workers wrap every heavy command in `heavy-lock.mjs run -- …`. With Claude Code's sandbox on, this folder must be listed in `sandbox.filesystem.allowWrite`, and preflight checks that it is (spikes R4, R7). The repository's `.git` isn't an alternative: it's only writable while a worktree agent runs.
- **Per-worktree environment.** The config's `worktree.env` (for example `DATABASE_URL=…/app_{slug}`) is written to a gitignored env file in the worktree, and the `setup` and `teardown` commands create and drop whatever it names. A test command can instead be marked `heavy: true` so it runs alone.
- **Targeted tests.** `tests.targeted` maps changed paths to commands (for example `apps/api/** → <filter> test -- {files}`). Full suites run only if the maintainer asks.

## 4. Conflict avoidance (US3)

- `classify.mjs` maps each path to an area (longest matching glob in `areas`), marks hot files and excluded paths, and returns JSON.
- `batch.mjs` picks the batch greedily: one bug per area, smaller and clearer issues first, hot files claimed by at most one bug. A bug that needs a hot file someone has already claimed is added only if no better candidate remains, and it's marked `rebase_at_pr`.
- **Re-check** (phase 4) runs the same logic on each assessment's "Files likely to change". A new overlap defers the later bug and puts the queue's next candidate in its place.
- **PR order** (phase 8). Bugs with no rebase-at-PR mark open first. Rebase-at-PR bugs open last, each after a fresh `git fetch origin <base>`.

## 5. State and resuming (US7, FR-013)

- State lives in `<state dir>/<repo id>/batches/<batch id>/state.json`. The repo id is a hash of the origin URL. It sits outside every working tree, so worktree isolation and gitignore rules don't affect it.
- `state.mjs` handles `init`, `get`, `set-phase`, `record` and `list`, and writes atomically (write to a temp file, then rename).
- Resuming: `run` finds an unfinished batch for the repo and offers to continue it. Each unfinished bug **moves into a fresh worktree**:
  1. The orchestrator starts a new isolated worker.
  2. The worker runs `git reset --hard <recorded branch tip>` in its new worktree and continues from the recorded phase.
  3. `state.mjs record` stores the new worktree path and branch.
  4. The old worktree is kept, with any uncommitted edits, until `cleanup` removes it with approval.

  A phase that was cut off restarts from its last commit. Workers don't take over the old worktree in place: under the sandbox, a worktree from an earlier session can't be committed to, and a second checkout of its branch needs `git worktree add -f` (spikes R3, R3b). Claude Code's worktree locks aren't used as a signal, because they hold the parent session's PID and their lifetime varies (spike R2).

## 6. Trackers (FR-002, FR-011)

- **GitHub**: `gh api repos/{o}/{r}/issues?state=open&per_page=100` (paged; pull requests filtered out). REST only.
- **Linear**: a single GraphQL query to `https://api.linear.app/graphql` for open issues in the configured team keys, with labels, priority and estimate. The key comes from `LINEAR_API_KEY` and is sent only in the `Authorization` header. It's never logged, and it's redacted from every error message.
- Both are normalised to `{source, id, number?, url, title, body, labels[], severity?, priority?}`. Issue bodies are passed to subagents inside an "untrusted issue text" fence.

## 7. Reviews and reports (US5, FR-009)

- By default each worker runs `/speckit-security-review-branch <branch> origin/<base>` and `/code-review`. The config can add more (for example an architecture review or a design check).
- Reports go to `review_dir/YYYY-MM-DD-<slug>-branch.md` and `…-code-review.md`.
- Findings come back as `{id, bug, review, severity, category, confidence, file, line, summary, report}`.

## 8. Pull requests (US6)

- **Branch**: `branch_pattern` (default `fix/{issue}-{slug}`). The worker renames its worktree branch (`worktree-agent-<id>`) with `git branch -m` before pushing.
- **Body**: `pr-body.mjs` fills `pr.body_template` from the bug folder (summary from `fix.md`, test results from `test.md`, links to the review reports, the issue that closes, and a Linear id if there is one). The default template has Summary / Tests / Reviews / Closes sections.
- **Push**: `git push -u origin <branch>`, never with `--force`. Then `gh pr create --draft --base <pr.base>`.

## 9. Repository layout

```
extension.yml
config-template.yml            -> installed as .specify/bug-batch.yml
commands/
  speckit.bug-batch.run.md     orchestrator (phases 0–9, resume)
  speckit.bug-batch.status.md  batches, phases, worktrees, locks
  speckit.bug-batch.cleanup.md remove leftover worktrees and stale locks (with approval)
prompts/
  worker.md                    the worker brief: phase protocol, return-JSON shapes, rules
scripts/
  preflight.mjs candidates.mjs classify.mjs batch.mjs resources.mjs
  heavy-lock.mjs state.mjs worktree.mjs pr-body.mjs lib/
  test/                        node --test suites + fixtures
docs/usage.md  README.md  CHANGELOG.md  LICENSE
```

## 10. Spikes to settle first

These are Claude Code behaviours the design depends on. Each spike is a throwaway check in a scratch repo, and its result is recorded in `research.md`.

- **R1.** Can a background subagent started with `isolation: "worktree"` run project skills (`/speckit-bug-assess` and the rest), and `/code-review`?
- **R2.** Does continuing a worker with `SendMessage` keep it in the same worktree, with its lock held? What happens to its worktree when the worker ends?
- **R3.** After a session restart, can a new subagent take over an existing worktree, for example with `EnterWorktree` on the recorded path? If not, resuming falls back to restarting the bug's current phase in a new worktree, carrying its commits across with `git worktree add <path> <branch>`.
- **R4.** Can a worktree-isolated worker write the per-repository state and lock folder outside the repository? Check with the sandbox both off and on.
- **R5.** How many background subagents can run at once, and what happens when the limit is hit?
- **R6.** Does the worktree's branch start from the newest `origin/<default>` (`worktree.baseRef: "fresh"`) when the default branch isn't `main`?

If R1 or R2 fails, the fallback is: the orchestrator creates worktrees itself with `worktree.mjs add`, and gives each phase to a new worker told to work only in that path. File isolation is then enforced by the prompt rather than by Claude Code.

**Outcome (T016):** R1, R2, R5 and R6 passed, and follow-up spikes R7, R3b and R8 were added. The main design stands, so the fallback isn't needed. R3 and R3b changed how resuming works (§5), and R4 and R7 added the sandbox allowlist check (§2, §3). Details are in [research.md](./research.md).

## 11. Testing

- **Unit** (`node --test --test-reporter=spec`): classify (globs, longest match, hot and excluded paths); batch (area spread, hot-file claims, rebase-at-PR, re-check deferral); resources (fixture `vm_stat` and `/proc/meminfo` output, threshold logic); heavy-lock (concurrent acquire from several child processes, stale-PID recovery, `max_heavy` > 1); state (atomic writes, resume listing); pr-body (template rendering, Linear id, missing reports); candidates (fixture REST and GraphQL responses, label filter, key redaction).
- **Manifest**: validated against the Spec Kit extension schema, the same way review-gate's test does it.
- **End to end**: a `--dry-run` flag runs phases 0–7 against a fixture git repository with fixture issues, and replaces push and PR creation with a printout. CI runs it with a stubbed `gh` on `PATH`.
- **Pilot**: install in one real project, run a batch of 2 bugs with `max_parallel: 2`, then a batch of 6 with the defaults, and record wall-clock time, peak load and peak memory in `research.md`.

## 12. Delivery (one PR each)

1. `docs`: spec.md (this PR series begins here)
2. `docs`: plan.md, plus research.md with the spike results
3. `docs`: tasks.md
4. `feat`: the scripts and their tests (no commands yet), split into four PRs for review:
   - 4a: the shared library (config, paths, io)
   - 4b: resources, heavy-lock and state
   - 4c: candidates, classify and batch
   - 4d: worktree, pr-body and preflight
5. `feat`: manifest, config template, worker prompt and the `run` / `status` / `cleanup` commands, plus the dry-run test
6. `docs`: README, usage and CHANGELOG; tag v0.1.0
7. In each adopting project, a PR that installs the extension and adds its `.specify/bug-batch.yml`

## 13. Risks

| Risk | Mitigation |
|---|---|
| A Claude Code update changes worktree behaviour (auto-removal, fetching, sandbox rules) | research.md records the version tested. Preflight checks what it can. The fallback in §10 still exists if worktree workers stop working. |
| Under the sandbox, heavy jobs can't reach the network or Docker (installs, container-backed tests) | Untested. The pilot (T152) checks it. Until then, usage docs say heavy jobs may need the sandbox off. |
| Two repositories' batches collide on a shared host resource, such as a database port | The heavy-job lock is per repository by design. Usage docs recommend a per-worktree database, or running batches in one repository at a time. |
| Area prediction misses a file, so two PRs conflict anyway | The re-check in phase 4 uses each assessment's file list. A conflict found at PR time is reported, and that PR is rebased rather than force-pushed. |
| The load limit is too strict and nothing starts | All limits are in config. `status` shows which limit is blocking. |
| A long-lived worker's context fills up | The worker returns compact JSON. The reports live on disk. A worker can be replaced the same way resume does it (§5), from its last phase commit. |
| Issue text tries to instruct a worker | It's fenced as untrusted data. Workers can't push or open PRs until the orchestrator passes on an approval. |
