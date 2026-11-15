# Spike prompt (paste into a Claude Code session started in the scratch repo)

Start it with `cd /tmp/bb-spike/work && claude` after running `docs/spikes/setup.sh`.
Paste everything below the line.

---

You're running six spikes for a design experiment (speckit-bug-batch, plan §10). This repo is a throwaway scratch repo: its default branch is `develop`, and its `origin` is a local bare repo. Never push, never open PRs, and never touch any directory except this repo, its `.claude/worktrees/`, `/tmp/bb-spike/`, and `${XDG_STATE_HOME:-$HOME/.local/state}/speckit-bug-batch/spike/`.

Write all results to `/tmp/bb-spike/results.md`: one section per spike with **Result: PASS / FAIL / PARTIAL**, the evidence (exact command output or tool error text), and anything surprising. Start the file with the output of `claude --version`, `git --version`, `node --version` and `uname -sr`, and say whether the sandbox is on.

**R1: worker skills.** Start a background subagent (Agent tool, `isolation: "worktree"`, `run_in_background: true`, general-purpose). Tell it to:
- report `pwd`, `git rev-parse --show-toplevel`, `git branch --show-current`, and `git rev-parse HEAD origin/develop`;
- check whether its skills list includes `stub-assess`, `code-review` (any variant), and any `speckit-*` skills;
- invoke the `stub-assess` skill and report the path it wrote;
- run `/code-review` (or the closest code-review skill it has) on its own branch's diff against `origin/develop`, or report exactly why it can't;
- commit the stub file (`git -c user.name=spike -c user.email=spike@example.invalid commit`) and report the sha;
- return all of this as JSON, then stop.

PASS = the skill ran inside the worktree, and a code review was at least invocable.

**R6: base branch.** From R1's output: did the worktree's HEAD start at `origin/develop`'s tip, before its own commit? Also report whether any Claude Code settings file sets `worktree.baseRef`, and what the worktree's branch is named. PASS = it started from `origin/develop`.

**R2: continuing a worker.** Use `SendMessage` to send the R1 worker a follow-up. Ask it to report `pwd` again, confirm the stub file and its commit still exist, and run `git worktree list --porcelain` (look for a `locked` line on its worktree). Once it has ended, check from this session: does the worktree still exist, and is it still locked? PASS = the same worktree and context after `SendMessage`.

**R3: taking over a worktree.** Start a new subagent *without* isolation. Tell it to switch into R1's worktree path with `EnterWorktree` (or report that it lacks that tool), then report `pwd` and `git log --oneline -1`. If that fails, test the fallback instead: from this session, run `git worktree add /tmp/bb-spike/wt-fallback <R1's branch>` and give a new subagent that path with orders to work only there. Report which approach worked.

**R4: writing outside the repo.** Start a worktree-isolated subagent that runs `mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/speckit-bug-batch/spike/locks/slot-0" && echo ok`, then removes `slot-0`. Report the output or the exact error. If the sandbox can be turned on (`/sandbox`), repeat with it on and report both runs.

**R5: how many run at once.** Start 6 background subagents, each with `isolation: "worktree"`. Each one runs `date +%s; sleep 45; date +%s` and returns the two timestamps. From the timestamps, report how many actually ran at the same time, and any queueing, refusal or error messages.

**Cleanup.** List `git worktree list`. Remove every spike worktree and its branch (`git worktree unlock` first if one is locked; `git worktree remove --force`; `git branch -D`). Remove `${XDG_STATE_HOME:-$HOME/.local/state}/speckit-bug-batch/spike/`. Confirm in results.md that cleanup is done. Leave `/tmp/bb-spike/results.md` in place.
