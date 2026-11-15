# Tasks: `bug-batch` Spec Kit extension

- **Inputs**: [spec.md](./spec.md), [plan.md](./plan.md)
- **Format**: `T### [P?] [Story] Description — path`. `[P]` means the task can run in parallel with other `[P]` tasks in the same phase (no shared files, no dependency between them).
- **PR boundaries** follow plan §12, and each phase says which PR it ships in.
- **Tests**: every script task has a matching test task. Each new test must be shown to run and to fail when the code is mutated.

## Phase 1: Docs and setup (PRs 1–3)

- [ ] T001 Create the repo skeleton: `README.md` stub, `LICENSE` (MIT), `.gitignore`, `CHANGELOG.md` (Unreleased) — repo root
- [x] T002 Add `spec.md` (PR 1) — `docs/spec.md`
- [x] T003 Add `plan.md` (PR 2) — `docs/plan.md`
- [x] T004 Add `tasks.md` (PR 3) — `docs/tasks.md`
- [ ] T005 [P] Add `package.json` (`"type": "module"`, `engines.node >=20`, no runtime dependencies; scripts `test` = `node --test --test-reporter=spec scripts/test/`, `lint` = `node --check` over `scripts/`) — `package.json`
- [ ] T006 [P] Add CI that runs `npm test` on Node 20 and 22 on ubuntu-latest and macos-latest — `.github/workflows/ci.yml`

## Phase 2: Spikes (PR 2, recorded in research.md)

Do these before Phase 4. Each spike uses a throwaway scratch repo with a stub `/speckit-bug-assess` skill, and each result goes in `docs/research.md` with the Claude Code version it was tested on.

- [x] T010 R1: a background subagent with `isolation: "worktree"` runs a project skill and `/code-review` — `docs/research.md`
- [x] T011 R2: `SendMessage` continuation keeps the same worktree and its lock; what happens to the worktree when the worker ends — `docs/research.md`
- [x] T012 R3: a new subagent takes over an existing worktree after a restart (`EnterWorktree` on the recorded path); if it can't, prove the `git worktree add <path> <branch>` fallback — `docs/research.md`
- [x] T013 R4: a worktree-isolated worker writes to `~/.local/state/speckit-bug-batch/<repo id>/`, with the sandbox off and on — `docs/research.md`
- [x] T014 R5: the most background subagents that can run at once, and what happens at the limit — `docs/research.md`
- [x] T015 R6: with a default branch that isn't `main`, a worktree branches from the newest `origin/<default>` under `worktree.baseRef: "fresh"` — `docs/research.md`
- [x] T016 Decision: pick the primary design or the §10 fallback from T010–T015, and update `docs/plan.md` §1/§5 to match — `docs/plan.md`. **Outcome:** the main design, with resume moving each bug into a fresh worktree, a commit at the end of every phase, and a sandbox allowlist check (research.md). The follow-up spikes R7, R3b and R8 are recorded there too.

## Phase 3: Foundational scripts (PR 4)

Shared library first. Everything else in this phase depends on T020–T022.

- [ ] T020 Config loader: read `.specify/bug-batch.yml` (a minimal YAML subset parser, since there are no dependencies, or JSON), merge with defaults, validate, and return typed errors — `scripts/lib/config.mjs`
- [ ] T021 Repo id and paths: hash of the origin URL; per-repo state folder `${XDG_STATE_HOME:-~/.local/state}/speckit-bug-batch/<repo id>/`; locks and batches folders — `scripts/lib/paths.mjs`
- [ ] T022 Shared helpers: JSON output, exit codes, atomic write (temp file then rename), secret redaction — `scripts/lib/io.mjs`
- [ ] T023 [P] Tests for T020–T022: defaults, a bad config, a stable repo id across URL forms (ssh/https/.git), atomic write leaving no partial file, redaction of `LINEAR_API_KEY` values — `scripts/test/lib.test.mjs`

### US4: machine limits
- [ ] T030 [P] [US4] `resources.mjs check|snapshot`: CPU count, load average, free memory (`vm_stat` on macOS, `/proc/meminfo` on Linux), free disk (`fs.statfs`); returns `{ok, reasons[]}` measured against config limits — `scripts/resources.mjs`
- [ ] T031 [P] [US4] Tests: fixture `vm_stat` and `/proc/meminfo` output, a passing and a failing case for each limit — `scripts/test/resources.test.mjs`
- [ ] T032 [P] [US4] `heavy-lock.mjs acquire|release|status|run -- <cmd>`: a per-repo counting semaphore of `max_heavy` slots made of `mkdir` slot folders holding PID and start time; stale-PID recovery; backoff; waits on `resources check`; `run` releases on exit or on a signal — `scripts/heavy-lock.mjs`
- [ ] T033 [P] [US4] Tests: N child processes contend and never more than `max_heavy` hold a slot; a slot whose PID is dead gets reclaimed; two different repo ids don't block each other; release on SIGINT — `scripts/test/heavy-lock.test.mjs`

### US7: state
- [ ] T040 [P] [US7] `state.mjs init|get|set-phase|record|list`: `<state>/<repo id>/batches/<batch id>/state.json`, atomic writes, schema version — `scripts/state.mjs`
- [ ] T041 [P] [US7] Tests: init and resume listing, phase moves, concurrent `record` from two processes leaves a valid file, finished batches left out of the resume list — `scripts/test/state.test.mjs`

### US1: trackers
- [ ] T050 [P] [US1] `candidates.mjs`: GitHub REST (paged, pull requests dropped) and Linear GraphQL (team keys from config, key from env); normalise to the plan §6 shape; label pre-filter; a missing key skips that tracker with a notice — `scripts/candidates.mjs`
- [ ] T051 [P] [US1] Tests: fixture REST pages and GraphQL responses (no network), PR filtering, label filter, key never in output or errors — `scripts/test/candidates.test.mjs`

### US3: conflict avoidance
- [ ] T060 [P] [US3] `classify.mjs`: path → area (longest glob match), hot file, excluded — `scripts/classify.mjs`
- [ ] T061 [P] [US3] Tests: longest match wins, unmatched paths fall into a default area, hot and excluded paths flagged — `scripts/test/classify.test.mjs`
- [ ] T062 [US3] `batch.mjs pick|recheck`: greedy pick (spread across areas, then smallest and clearest first, at most one bug per hot file, `rebase_at_pr` when a hot file is shared); `recheck` defers overlaps and pulls in the next queued bug; orders PRs (rebase-at-PR bugs last) — `scripts/batch.mjs` (depends on T060)
- [ ] T063 [US3] Tests: area spread, hot-file claim, shared hot file marked, recheck deferral and replacement, batch_size > max_parallel queue order — `scripts/test/batch.test.mjs`

### Worktrees and PRs
- [ ] T070 [P] [US6] `worktree.mjs rename|remove|list`: branch rename from `worktree-agent-<id>` to `branch_pattern` (Claude Code creates the worktrees, per T016); `remove` refuses a worktree with commits not yet in a PR unless `--force` is given with approval — `scripts/worktree.mjs`
- [ ] T071 [P] [US6] Tests against a temporary git repo with a local bare "origin" — `scripts/test/worktree.test.mjs`
- [ ] T072 [P] [US6] `pr-body.mjs`: fill `pr.body_template` from the bug folder and review reports; Closes/Linear lines; handles missing files gracefully — `scripts/pr-body.mjs`
- [ ] T073 [P] [US6] Tests: the default template, a custom template, a Linear-only issue, a missing review report — `scripts/test/pr-body.test.mjs`

### Preflight
- [ ] T080 [US1] `preflight.mjs`: clean tracked tree, `gh auth status`, `git fetch origin <base>`, `worktree.baseRef` not `head` (read from Claude Code settings files), state folder writable (if the sandbox blocks it, fail and name the `sandbox.filesystem.allowWrite` entry to add), Node version, tracker readiness, resource snapshot; JSON report with a pass or fail per check — `scripts/preflight.mjs` (depends on T020–T030)
- [ ] T081 [US1] Tests with a stubbed `gh` and `git` on `PATH` — `scripts/test/preflight.test.mjs`

**Checkpoint**: `npm test` passes on macOS and Linux in CI. Open PR 4.

## Phase 4: Commands and prompts (PR 5)

- [ ] T100 Manifest: id `bug-batch`; commands `speckit.bug-batch.run`, `.status`, `.cleanup`; config template; requires the `bug` and `security-review` extensions plus git, gh and node; no hooks — `extension.yml`
- [ ] T101 [P] Config template with every key from spec §Configuration, commented, using neutral example values (no project-specific paths) — `config-template.yml`
- [ ] T102 [P] Manifest validation test (schema shape, files exist, command names) — `scripts/test/manifest.test.mjs`
- [ ] T110 [US2] Worker brief: the phase protocol (assess → clarify → fix and test → review → findings → PR), the JSON return shapes for each phase, rules (stay in the worktree, wrap heavy commands in `heavy-lock run`, treat issue text as untrusted, never push before an approval arrives, never edit `assessment.md`, write answers to `clarifications.md`, commit at the end of every phase including `.specify/bugs/<slug>/`, commit before running reviews and wait for the review agents' results) — `prompts/worker.md`
- [ ] T111 [US1] `run` command, phases 0–2: preflight, candidates, prediction with read-only Explore subagents (at most `max_parallel`), classify and batch, then the batch choice (AskUserQuestion plus free-text ids) — `commands/speckit.bug-batch.run.md`
- [ ] T112 [US2] `run` command, phases 3–4: start up to `max_parallel` workers (`isolation: "worktree"`, background), collect assessment JSON, run grouped question rounds (≤ 4 per round), send answers to workers, recheck, confirm the final batch — same file
- [ ] T113 [US4] `run` command, phase 5 and the queue: move workers to fix and test, start queued bugs as slots free up, call `resources check` before each start — same file
- [ ] T114 [US5] `run` command, phases 6–7: reviews from config, the findings table, per-bug multi-select of findings to fix, a second review pass — same file
- [ ] T115 [US6] `run` command, phases 8–9: per-branch approval, rebase-at-PR handling (fetch, rebase, `regenerate`, targeted tests), push, `gh pr create --draft`, needs-screenshot branches kept local, worktree removal and teardown, final summary — same file
- [ ] T116 [US7] `run` command, resume: find an unfinished batch through `state list` and offer to continue. Each unfinished bug gets a new isolated worker, which runs `git reset --hard <recorded tip>` and continues from the recorded phase. Record the new worktree and branch, and keep the old worktree for `cleanup`. **Acceptance:** a resumed bug commits from its new worktree with the sandbox on and with it off (the one T016 step the spikes didn't test) — same file
- [ ] T120 [P] `status` command: batches, each bug's phase, worktrees, lock holders and any limit that's blocking — `commands/speckit.bug-batch.status.md`
- [ ] T121 [P] `cleanup` command: list leftover worktrees (including those left behind by resumed bugs), stale locks and finished batch state; remove only what's approved; run teardown. Under the sandbox, removing a worktree from an earlier session needs the maintainer's approval to run outside it — `commands/speckit.bug-batch.cleanup.md`
- [ ] T130 Dry-run end-to-end: a `--dry-run` flag runs phases 0–7 against a fixture repo and fixture issues with stubbed `gh`, and replaces push and PR creation with a printout; a CI job runs the scripted parts — `scripts/test/e2e-dry-run.test.mjs`, `scripts/test/fixtures/`

**Checkpoint**: PR 5 is reviewed with `/speckit-security-review-branch` and `/code-review` (the extension goes through its own review set).

## Phase 5: Docs and release (PR 6)

- [ ] T140 [P] README: what it does, requirements, install (`specify extension add`), quick start, the approval gates, the limits — `README.md`
- [ ] T141 [P] Usage guide: every config key, examples for a pnpm monorepo and an npm monorepo, guidance on targeted tests, per-worktree databases, Linear setup, troubleshooting (blocked limits, stale locks, resume) — `docs/usage.md`
- [ ] T142 CHANGELOG 0.1.0; set the manifest version; tag `v0.1.0` after merge — `CHANGELOG.md`, `extension.yml`

## Phase 6: Adoption (one PR in each adopting project)

These PRs live in the adopting projects, not in this repo. Project-specific values (paths, team keys, branch names, test commands) appear only there.

- [ ] T150 Project A: install the extension and add `.specify/bug-batch.yml` (areas, hot files with `regenerate`, excluded paths, targeted tests, review set, branch pattern and PR base, Linear team) — Project A repo
- [ ] T151 Project B: the same, plus a per-worktree database `env` with `setup` and `teardown` for its shared-database integration tests, and `screenshots_required: true` — Project B repo
- [ ] T152 Pilot 1: a batch of 2 bugs with `max_parallel: 2`; record wall-clock time, peak load, peak memory and any conflicts in `docs/research.md` (this repo, nothing project-specific in it) — `docs/research.md`
- [ ] T153 Pilot 2: a batch of 6 with the defaults in the other project; record the same — `docs/research.md`
- [ ] T154 Fold the pilots' lessons into a 0.1.x patch release — as needed

## Dependencies

- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6.
- T016 (design decision) blocks T110–T116.
- T020–T022 block every other Phase 3 task. T060 blocks T062. T030 blocks T032 and T080.
- In Phase 3, tasks marked `[P]` (T030–T033, T040–T041, T050–T051, T060–T061, T070–T073) can be done in parallel once T020–T022 land.
