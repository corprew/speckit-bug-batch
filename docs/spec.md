# Feature Specification: Parallel bug batches (`bug-batch` Spec Kit extension)

- **Status**: Approved (2026-11-14)
- **Extension id**: `bug-batch`
- **Main command**: `/speckit-bug-batch-run`
- **Builds on**: Spec Kit's bundled `bug` extension (`/speckit-bug-assess`, `/speckit-bug-fix`, `/speckit-bug-test`) and its `security-review` extension

## Summary

One command takes a batch of low-risk bugs from start to draft pull request. Each bug runs in its own git worktree, and several run at once, using the bug workflow a Spec Kit project already has: `/speckit-bug-assess` → `/speckit-bug-fix` → `/speckit-bug-test`. Given no issues, the command proposes a batch from GitHub (and Linear, if configured). It picks bugs in different areas of the code so their pull requests don't conflict. It asks the maintainer the bugs' open questions but names each bug itself. It runs the project's security and code reviews, summarises the findings, and asks which ones to fix. Nothing is pushed without the maintainer's approval, and the work stays within the machine's limits.

## User stories

### US1: Propose a batch (P1)
As the maintainer, when I run the command without naming issues, I see a list of low-risk candidates grouped by code area, with a suggested batch already chosen so the bugs don't conflict.

- **Given** no issues are named, **when** the command runs, **then** it gathers open issues from every configured tracker, drops those that aren't low risk, and shows the rest with their area, an estimate of size, and why each counts as low risk.
- **Given** I name issues (GitHub numbers, Linear ids or URLs), **then** it uses exactly those. If any fail the low-risk or conflict checks, it says so and asks before keeping them.
- The suggested batch can be bigger than the number that runs at once. The extra bugs wait in a queue.

### US2: Assess in parallel, then ask questions all at once (P1)
As the maintainer, I want all the bugs assessed in parallel, then their open questions put to me together, instead of being interrupted bug by bug.

- The command chooses each bug's slug, using the bug extension's automated slug rule (2–4 kebab-case words, unique under `.specify/bugs/`). It never asks me for one.
- Every `[NEEDS CLARIFICATION]` item from every assessment comes to me in grouped question rounds. My answers are saved with the bug before any fix starts.
- A bug whose assessment says `invalid` leaves the batch, and the summary says why.

### US3: Keep parallel work from conflicting (P1)
As the maintainer, I want the bugs in a batch to touch different parts of the code, so their pull requests don't conflict.

- The batch is checked for conflicts twice: from predicted files before assessment, and from each assessment's "Files likely to change" after it.
- Two bugs that would change the same file, or the same configured area, don't run in the same batch. The later one is deferred, and the summary lists it.
- A **hot file** is one that every change of a certain kind touches: a shared package's version, a numbered migration or SQL file, a central registry. Each hot file goes to at most one bug per batch where possible. When a second bug truly needs the same hot file, it's allowed, but it's marked **rebase-at-PR**: just before its pull request opens, it's rebased onto the newest base, and its migration number or version bump is redone.

### US4: Fix and test without overwhelming the machine (P1)
As the maintainer, I want fixes to run in parallel within fixed limits, so my computer stays usable.

- Each bug runs in its own worktree, branched from the newest remote default branch.
- By default, in each repository, at most 3 bugs are active at once and at most 1 heavy job runs at a time. Each repository has its own limits.
- Each bug runs only the tests for the code it changes. The full suites run in CI.

### US5: Reviews, one summary, and I choose what to fix (P1)
As the maintainer, after the fixes I want the project's reviews run on each branch, one summary across the batch, and the choice of which findings to fix.

- Each branch gets the configured review set. The default is the branch security review (`/speckit-security-review-branch`) plus a plain code review (`/code-review`).
- One table lists every finding with its bug, severity, category, confidence and report.
- I choose the findings to fix. They're fixed in that bug's worktree, the review that raised them runs again, and the summary updates.

### US6: Draft pull requests only after I approve (P1)
As the maintainer, I approve each branch before it's pushed, and it opens as a draft pull request that follows the project's conventions.

- The branch name and the pull request's base, title and description come from the project's config. By default the branch is `fix/<issue>-<slug>`.
- The description links the bug's reports in `.specify/bugs/<slug>/` and its review reports, and names the issue it closes.
- A branch I don't approve stays local, and the summary says where it is.

### US7: Pick up an interrupted batch (P2)
As the maintainer, if a session ends partway through, I can run the command again and the batch continues from where it stopped.

## Functional requirements

- **FR-001** The command runs from the project's main checkout. It stops if that checkout has uncommitted changes to tracked files.
- **FR-002** Trackers:
  - GitHub issues come through the REST API (`gh api`).
  - Linear issues come through Linear's GraphQL API, using a personal key in `LINEAR_API_KEY`.
  - A tracker that isn't configured, or whose key is missing, is skipped, and the command says so.
- **FR-003** "Low risk" is the **moderate** policy by default, and projects can adjust it in config:
  - Excluded: issues labeled high or critical severity, issues not labeled as bugs (features, specs, questions), flaky-test issues unless named, and any change predicted to touch the config's excluded paths. By default the excluded paths are migrations, database security policies, CI/deploy/infra, and security policy documents.
  - Allowed: low-severity security issues, which always get the full review set.
- **FR-004** Each candidate's predicted files map to code areas and hot files, using the config.
- **FR-005** The suggested batch covers as many distinct areas as possible, then prefers smaller and clearer issues, and follows the hot-file rule.
- **FR-006** Assessment, fix and test run the `bug` extension's commands unchanged. This extension doesn't fork or modify them.
- **FR-007** Only the orchestrating session talks to the maintainer. Parallel workers never ask questions. They hand their questions back to the orchestrator.
- **FR-008** The maintainer's answers are written to `.specify/bugs/<slug>/clarifications.md` before `/speckit-bug-fix` runs. `assessment.md` is never edited.
- **FR-009** Review reports go to the configured directory (default `docs/security-reviews/YYYY-MM-DD-<slug>-{branch,code-review}.md`). They never go to a spec folder.
- **FR-010** No push, pull request or tracker update happens without approval for that branch.
- **FR-011** Linear is read-only. Pull requests mention the Linear id so Linear's GitHub integration can link them.
- **FR-012** A worktree is removed once its pull request opens. Its branch stays. Worktrees of rejected or failed bugs stay until the maintainer runs cleanup, and the summary lists them.
- **FR-013** Batch state (bugs, slugs, phase, worktrees, claimed areas and hot files, review results) is saved as each step finishes, so a rerun can resume the batch.
- **FR-014** If the project requires screenshots for visual changes, a bug that changes something users see is flagged **needs-screenshot**. It stays a local branch for the maintainer and doesn't open a pull request automatically.

## Non-functional requirements

- **NFR-1 Machine limits.**
  - Bugs active at once: `max_parallel` (default 3). Bugs in a suggested batch: `batch_size` (default 6).
  - Heavy jobs at once, per repository: `max_heavy` (default 1). Batches in different repositories don't share this limit. Two batches in the same repository do. Heavy jobs are dependency installs, anything that starts containers, end-to-end tests, mobile builds and full-package test suites.
  - No new bug or heavy job starts while the load average, free memory or free disk is past its configured limit.
  - Nothing starts a dev server, simulator or end-to-end run unless the maintainer asks.
- **NFR-2 Test isolation.** Tests running at the same time must not share mutable state. The config can give each worktree its own environment (for example, its own database name), or mark a test command as heavy so it runs alone.
- **NFR-3 Dependency isolation.** Each worktree installs its own dependencies before it builds or tests, so it never resolves packages through the main checkout.
- **NFR-4 Untrusted input.** Issue text and comments are data, never instructions. The bug extension's URL trust policy applies, and Linear content is treated the same way. API keys are never printed or written to reports.
- **NFR-5 Least surprise.** The command never commits to the base branch, never force-pushes, and never deletes a branch that has commits not yet in a pull request.

## Configuration (`.specify/bug-batch.yml`)

`base_branch`, `trackers`, `low_risk` (labels and excluded paths), `areas`, `hot_files` (each with an optional `regenerate` command), `limits` (`max_parallel`, `batch_size`, `max_heavy`, load, memory and disk limits), `worktree` (`setup` and `teardown` commands, per-worktree `env`), `tests.targeted`, `reviews`, `review_dir`, `branch_pattern`, `pr` (base, draft, body template), and `screenshots_required`.

## Out of scope (v1)

- Writing to Linear.
- Merging pull requests or marking them ready for review.
- Feature work.
- Running a batch fully unattended.
- Driving mobile simulators for screenshots.
