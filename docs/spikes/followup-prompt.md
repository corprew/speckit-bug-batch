# Follow-up spike prompts (R3b, R7, R8)

These close the gaps the first run left open (see [research.md](../research.md)). They use the same scratch repo, with two sessions and a full restart between them.

Before starting:

- `/tmp/bb-spike/work/.claude/settings.local.json` has the sandbox **on** and `sandbox.filesystem.allowWrite: ["~/.local/state/speckit-bug-batch"]`.
- `git worktree list` in `/tmp/bb-spike/work` shows only the main checkout.

Steps:

1. `cd /tmp/bb-spike/work && claude`. Paste **Part 1**.
2. When it says so, quit that session completely with `/exit`. Choose **keep** if it asks about worktrees.
3. `cd /tmp/bb-spike/work && claude` again (a new session, not `--resume` or `--continue`). Paste **Part 2**.

---

## Part 1 (first session)

You're running follow-up spikes for a design experiment (speckit-bug-batch, plan §10). This repo is a throwaway scratch repo: its default branch is `develop`, and its `origin` is a local bare repo. Never push, and never open PRs. Never touch any directory except this repo, its `.claude/worktrees/`, `/tmp/bb-spike/`, and `~/.local/state/speckit-bug-batch/spike/`.

**The sandbox should be on. Never use `dangerouslyDisableSandbox`, and tell every subagent the same.** If a command is blocked, record the exact error and move on. Don't retry it another way. A retry outside the sandbox counts as FAIL.

Write results to `/tmp/bb-spike/results-2.md`. Give each spike its own section with **Result: PASS / FAIL / PARTIAL** and the evidence (exact output or error text). Start the file with `claude --version`, and include the contents of `.claude/settings.local.json` to confirm the sandbox is on.

**R7: a sandboxed worker does real work.** Start a subagent with `isolation: "worktree"`. Tell it never to disable the sandbox, and to:
- report `pwd` and `git branch --show-current`;
- invoke the `stub-assess` skill;
- `git add -A && git -c user.name=spike -c user.email=spike@example.invalid commit -m "spike: r7"`, and report the sha or the exact error;
- run `mkdir -p ~/.local/state/speckit-bug-batch/spike/locks/slot-0 && echo ok`, then remove `slot-0` (this checks that the allowlist works);
- run `d="$(git rev-parse --git-common-dir)/bug-batch-spike" && mkdir -p "$d" && echo ok && rmdir "$d"` (this checks whether the shared git dir is writable);
- run `mkdir -p "$TMPDIR/bug-batch-spike" && echo ok && rmdir "$TMPDIR/bug-batch-spike"`;
- return JSON, one field per step with output or error, then stop.

PASS = the skill ran, the commit succeeded, and the allowlisted state dir was writable, all inside the sandbox.

**R3b part 1: leave a worktree for the next session.** Start another subagent with `isolation: "worktree"`. It invokes `stub-assess`, commits as above with message `spike: r3b`, and reports its `pwd`, branch and sha. After it ends, run `git worktree list --porcelain` here and write `/tmp/bb-spike/r3b-handoff.json` containing `{path, branch, sha, locked_line, session_pid}`, where `session_pid` is the PID in the lock line. Also record R7's worktree in that file under `r7`, so cleanup can find it. Don't clean anything up.

Finally, tell the user: "Part 1 done. Quit with /exit (choose keep if asked about worktrees), then start a new session and paste Part 2." Record any exit prompt the user reports in results-2.md at the start of Part 2.

---

## Part 2 (new session, after a full restart)

You're continuing follow-up spikes in a throwaway scratch repo (same rules: never push, never open PRs, touch only this repo, its `.claude/worktrees/`, `/tmp/bb-spike/` and `~/.local/state/speckit-bug-batch/spike/`). **The sandbox should be on. Never use `dangerouslyDisableSandbox`, and tell every subagent the same.** If a command is blocked, record the exact error and don't retry it another way, except where a step below says so.

Append to `/tmp/bb-spike/results-2.md`. First ask the user whether quitting the previous session showed any prompt about worktrees, and what they chose. Record their answer.

**R3b part 2: take over a worktree after a restart.** Read `/tmp/bb-spike/r3b-handoff.json`.
1. Run `git worktree list --porcelain`. Does the worktree still exist, at the recorded sha? Is it still locked? Check whether the lock's PID is alive with `kill -0 <pid>; echo $?`.
2. If it's locked by a dead PID, run `git worktree unlock <path>`, and record whether the sandbox allowed it.
3. Start a subagent **without** isolation. Tell it to work only in `<path>`: `cd <path>`, report `pwd`, `git branch --show-current` and `git log --oneline -2`, write `r3b-resume.txt`, then `git add -A && git -c user.name=spike -c user.email=spike@example.invalid commit -m "spike: r3b resume"`. It reports the sha or the exact error, and never uses `git worktree add`.
4. Confirm from this session that the new commit is on the recorded branch, and that `git worktree list` shows no second checkout of it.

PASS = the recorded worktree survived the restart, and a new worker continued in it inside the sandbox, without `-f` or a second checkout.

**R8: what happens to an existing worktree when a new isolated worker starts.** Start one more subagent with `isolation: "worktree"` that only reports `pwd` and `git worktree list`, then stops. Record whether the R3b worktree was touched, unlocked, removed or reused.

**Cleanup.** You may disable the sandbox for cleanup only, and should say so in results-2.md. Remove every spike worktree (unlock first if needed, `git worktree remove --force`) and its branch (`git branch -D`), along with `~/.local/state/speckit-bug-batch/spike/` and `/tmp/bb-spike/r3b-handoff.json`. Show `git worktree list` and `git branch -a` afterwards, and confirm in results-2.md that cleanup is done.
