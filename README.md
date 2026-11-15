# speckit-bug-batch

A [Spec Kit](https://github.com/github/spec-kit) extension that takes a batch of low-risk bugs from issue to draft pull request, running them in parallel git worktrees with Claude Code.

It runs the project's existing bug workflow (`/speckit-bug-assess` → `/speckit-bug-fix` → `/speckit-bug-test`) for each bug. Bugs are batched by code area so their pull requests don't conflict, and each repository gets its own machine limits. The extension asks all the clarifying questions at once, runs the project's reviews, lets the maintainer choose which findings to fix, and opens a draft pull request only after the maintainer approves it.

**Status:** pre-release. Nothing is installable yet. See [`docs/spec.md`](docs/spec.md), [`docs/plan.md`](docs/plan.md) and [`docs/tasks.md`](docs/tasks.md).

## License

[MIT](LICENSE)
