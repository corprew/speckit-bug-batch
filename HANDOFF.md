# Handoff: continuing bug-batch in local Claude Code

This repo was started in a cloud session that couldn't start worktree-isolated subagents. The work continues in Claude Code on the maintainer's machine.

## Where things stand

- `docs/spec.md`: approved and merged (#1).
- `docs/plan.md`: approved and merged (#2).
- `docs/tasks.md`: merged (#3).
- `docs/research.md`: the spikes are done. T016 chose the main design, with resume moving each bug into a fresh worktree and a sandbox allowlist check. `plan.md` and `tasks.md` are updated to match.

## Ground rules

- **This repo is public.** Never commit details of the private projects that will adopt the extension: names, paths, issue ids, tracker team keys, branch conventions or test commands. Those values go only in each project's own `.specify/bug-batch.yml`, added by a PR in that project.
- **All changes go through PRs.** Nothing is committed straight to `main`.
- **The phases stay separate:** spec → plan → tasks → implementation. Get approval at each decision point.
- **Ask clarifying questions before acting.**
- **Commit and PR attribution:** end commit messages with a `Co-Authored-By: Claude …` line, and PR descriptions with the Claude Code footer.

## Next steps

1. ~~Run the spikes (T010–T015).~~ Done. To rerun them on a newer Claude Code: `bash docs/spikes/setup.sh`, then `spike-prompt.md` and `followup-prompt.md` in separate sessions (see `docs/research.md`).
2. ~~Record the results and the T016 decision.~~ Done (`docs/research.md`).
3. **Phase 1 setup** (T001, T005, T006): repo skeleton, `package.json`, and CI.
4. **Phase 3 scripts with tests**, following `docs/tasks.md`.

## Kickoff prompt

The maintainer has a private kickoff prompt for the local session. It carries the project-specific context, which never goes in this repo. A public-safe version:

> Read `HANDOFF.md`, then `docs/spec.md`, `docs/plan.md`, `docs/tasks.md` and `docs/research.md`. We're at step 1 of HANDOFF's next steps. Ask me any questions before you start, then help me run the spikes.
