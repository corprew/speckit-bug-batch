# Research: bug-batch spikes

- **Plan**: [plan.md](./plan.md) §10
- **Tasks**: T010–T016
- **Status**: Done (2026-11-14). The T016 decision is at the end.

The design relies on several Claude Code behaviours. They were checked in a throwaway scratch repo, never in a real project:

1. `bash docs/spikes/setup.sh` builds `/tmp/bb-spike/work`, with default branch `develop`, a local bare origin and a stub skill (`stub-assess`, standing in for `/speckit-bug-assess`).
2. **Run 1** (R1–R6): one session, pasting [`spikes/spike-prompt.md`](./spikes/spike-prompt.md). Before it started, one extra commit was pushed to the bare origin from a second clone, so the scratch repo's `origin/develop` ref was stale. That lets R6 tell "branched from local refs" apart from "branched from the origin's newest tip".
3. **Run 2** (R7, R3b, R8): two sessions with a full restart between them, pasting [`spikes/followup-prompt.md`](./spikes/followup-prompt.md). The sandbox was on throughout, with `sandbox.filesystem.allowWrite` set to the state folder.

## Environment

| Item | Value |
|---|---|
| Claude Code | 2.1.325 |
| OS | macOS (Darwin 27.2, Apple silicon) |
| git / Node | 2.54.0 / 22.22.2 |
| Sandbox | Run 1: off for R1, R2, R3's first attempt and R4's first run, then on (macOS Seatbelt). Run 2: on throughout. |
| `worktree.baseRef` | Not set in any settings file |

## Results

| Spike | Question | Result |
|---|---|---|
| R1 | Can a worker with `isolation: "worktree"` run project skills and `/code-review`? | **PASS** (sandbox off) |
| R2 | Does `SendMessage` continuation keep the same worktree and context? | **PASS** |
| R3 | Can a new subagent take over an existing worktree in the same session? | **PARTIAL**: `EnterWorktree` fails; the fallback needs `-f` |
| R3b | Can a new worker continue in a worktree after a full session restart? | **FAIL** with the sandbox on: it can edit but can't commit |
| R4 | Can a worktree worker write the per-repo state folder outside the repo? | Sandbox off: **PASS**. Sandbox on, no allowlist: **FAIL** |
| R5 | How many background subagents actually run at once? | **PASS**: 6 of 6 at once |
| R6 | With a default branch other than `main`, does a worktree start from the newest `origin/<default>`? | **PASS** |
| R7 | Can a sandboxed worktree worker run a skill, commit, and write an allowlisted state folder? | **PASS** |
| R8 | What does a new isolated worker do to a worktree left by an earlier one? | Leaves it alone and gets a fresh one |

### R1: worker skills: PASS

- The skill ran inside the worker's worktree and wrote its file there, not in the main checkout.
- The worker sees project skills plus every user and plugin skill, including `code-review`, which it could invoke.
- **The code review runs as its own background agent**, and its result arrives later as a notification. It reviews only committed or tracked changes, so untracked files are invisible to it. The first review raced the worker's commit and saw an empty diff. **Workers must commit before reviewing.**
- The Agent tool has no `run_in_background` parameter in this version. Subagents always run in the background and notify the parent when they finish.

### R2: SendMessage continuation: PASS

- After `SendMessage`, the worker reported the same `pwd` and branch. It recalled values from its first turn before running anything, so its context carried over.
- **Worktrees are kept or removed based on changes.** A worktree with commits or changes outlives its worker. A worktree with no changes is removed automatically when its worker finishes, and its branch goes with it (R4, R5 and R8 all saw this).
- **Worktree locks are not reliable.** A running worker's worktree is `git worktree lock`ed with `claude agent agent-<id> (pid <P> …)`, where `<P>` is the **parent session's** PID, not the worker's. In run 1 the lock was still there after the worker ended. In run 2 it was released as soon as the worker finished. The design must not depend on lock state.

### R3: taking over a worktree in the same session: PARTIAL

- `EnterWorktree` from a non-isolated subagent fails: *"Cannot enter worktree: the current working directory … is the repository root, not an isolated worktree."* It only switches between worktrees for a session that is already inside one.
- The plan's fallback, `git worktree add <path> <branch>`, fails while the original worktree still has the branch checked out (*"already used by worktree"*). It only works with `-f`, which leaves two checkouts of one branch that can drift apart. The design rules this out.
- With the sandbox on, a non-isolated worker given a path outside the session's own worktrees couldn't write there.

### R3b: continuing after a restart: FAIL (sandbox on)

- The worktree survived `/exit` and a new session: there was no exit prompt, the commit was the same, and there was no lock.
- A new non-isolated worker told to work in it could read and edit files. But `git add` failed: *"Unable to create '…/.git/worktrees/<name>/index.lock': Operation not permitted"*. Under the sandbox, `.git/worktrees/` is writable only for worktrees created **in the current session**, so a worktree from a previous session can't be committed to.

### R4: state folder outside the repo

- Sandbox off: a worktree worker created and removed `~/.local/state/speckit-bug-batch/…/locks/slot-0` with no problem.
- Sandbox on, no allowlist: *"Operation not permitted"*. The worker then tried to retry outside the sandbox, and the auto-mode permission classifier blocked it. In run 1 the same classifier allowed a different retry outside the sandbox, so its behaviour can't be relied on either way.

### R5: concurrency: PASS

Six worktree workers started in one message all ran at once: every start time was within 1 second, and all 45-second windows overlapped. There was no queueing or refusal. The default `max_parallel: 3` is well inside what Claude Code allows. This ran with the sandbox on.

### R6: base branch: PASS

- The worker's worktree started at the origin's newest tip, not at the stale local `develop` or `origin/develop` ref.
- Creating the worktree ran `git fetch origin develop` by itself (the reflog shows the fetch), and branched from the updated `origin/develop`. Local `develop` was left alone.
- This is the default behaviour when `worktree.baseRef` isn't set.
- Worktrees are named `.claude/worktrees/agent-<id>`, on branch `worktree-agent-<id>`.

### R7: sandboxed worker doing real work: PASS

With the sandbox on and `sandbox.filesystem.allowWrite: ["~/.local/state/speckit-bug-batch"]`, a worktree worker:

- ran the skill and committed on its branch;
- created and removed a slot folder in the allowlisted state folder;
- could write `$TMPDIR`;
- could write `git rev-parse --git-common-dir`. That's only because Claude Code adds the whole `.git` to the sandbox's write list **while a worktree agent runs**, and removes it afterwards. Outside such a run, `.git` isn't writable, so it's no place for locks or state.

### R8: an old worktree when a new worker starts

A new isolated worker got a fresh worktree from the newest origin tip. It didn't touch, unlock, reuse or remove the worktree left by the earlier session.

## Not tested

- Network access and the Docker socket under the sandbox: dependency installs, `gh`, `git push`, and tests that start containers.
- Whether an `allowWrite` entry can open up `.git/worktrees/` for worktrees from earlier sessions.
- Moving a bug's work into a fresh worktree with `git reset --hard <recorded tip>`. The T016 decision depends on this; it's an acceptance test for T116.

## What this means for adopting projects

- **A default branch other than `main` works.** Worktrees branch from the newest `origin/<default>`, and Claude Code fetches it when it creates the worktree.
- **Commit early.** A worktree with nothing in it vanishes when its worker finishes. A review can't see uncommitted files. And resuming after a restart only carries over commits.
- **Sandbox mode is supported, with one setting.** The state folder must be in `sandbox.filesystem.allowWrite`. Projects whose heavy jobs need the network or Docker (installs, container-backed test suites) may still need the sandbox off for those jobs until that's tested in a pilot.
- **Resources shared across repositories aren't covered.** The heavy-job lock is per repository. If two projects' test databases both use the same host port, batches running in both at once can collide. A project like that should give each worktree its own database, or keep those tests heavy and run batches in one repository at a time.

## T016 decision

**Use the main design, with three changes.**

1. **Workers are Claude Code worktree workers moved along with `SendMessage`.** R1, R2, R5, R6 and R7 confirm it works with the sandbox off and with it on. Isolation is enforced by Claude Code, not by a prompt.
2. **Resuming moves each bug into a fresh worktree.** A worktree from an earlier session can't be committed to under the sandbox (R3b), and taking over a worktree in place needs `-f` (R3). So on resume, the orchestrator starts a new isolated worker for each unfinished bug. That worker runs `git reset --hard <recorded branch tip>` and continues from the recorded phase. The state file records the new worktree and branch. The old worktree stays until `/speckit-bug-batch-cleanup`, with approval, removes it. To make this safe, **workers commit at the end of every phase**, including the `.specify/bugs/<slug>/` files. The same rule covers R1's commit-before-review.
3. **Sandbox mode is supported through an allowlist plus a preflight check.** State and locks stay in `${XDG_STATE_HOME:-~/.local/state}/speckit-bug-batch/<repo id>/`. Preflight detects sandbox mode and checks that the folder is writable. If it isn't, preflight stops and names the `sandbox.filesystem.allowWrite` entry to add.

The §10 fallback (script-created worktrees with a new worker per phase) isn't needed. `worktree.mjs` stays for branch renames, listing and cleanup, but no longer creates worktrees. The changes are in `plan.md` §1, §2, §3, §5, §10 and §13, and in `tasks.md` T016, T070, T080, T110, T116 and T121.
