# Research: bug-batch spikes

- **Plan**: [plan.md](./plan.md) §10
- **Tasks**: T010–T016
- **Status**: Protocol ready; results pending

The design relies on six Claude Code behaviours. They're checked in a throwaway scratch repo, never in a real project:

1. `bash docs/spikes/setup.sh` builds `/tmp/bb-spike/work`, with default branch `develop`, a local bare origin and a stub skill.
2. `cd /tmp/bb-spike/work && claude`, then paste [`spikes/spike-prompt.md`](./spikes/spike-prompt.md).
3. That session writes `/tmp/bb-spike/results.md`. The findings are summarised below, and the T016 decision is recorded at the end.

## Environment

| Item | Value |
|---|---|
| Claude Code | _pending_ |
| OS | _pending_ |
| git / Node | _pending_ |
| Sandbox | _pending_ |

## Results

| Spike | Question | Result | Notes |
|---|---|---|---|
| R1 | Can a background worker with `isolation: "worktree"` run project skills and `/code-review`? | _pending_ | |
| R2 | Does `SendMessage` continuation keep the same worktree, lock and context? | _pending_ | |
| R3 | Can a new subagent take over an existing worktree, or does the `git worktree add` fallback work? | _pending_ | |
| R4 | Can a worktree-isolated worker write the per-repo state folder outside the repo (sandbox off and on)? | _pending_ | |
| R5 | How many background subagents actually run at once? | _pending_ | |
| R6 | With a default branch other than `main`, does a worktree start from the newest `origin/<default>`? | _pending_ | |

## T016 decision

_Pending._ This records whether the batch runs on the main design (long-lived worktree workers moved along with `SendMessage`) or on the fallback (script-created worktrees, with a new worker for each phase), and what changes in `plan.md` follow from it.
