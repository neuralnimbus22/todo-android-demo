# CLAUDE.md — todo-android-demo

A copy of the Android Architecture Blueprints to-do app (`views` branch), used to demo
per-change test selection with Testkube on a mobile app. `README.md` explains the flow.
`testkube/README.md` explains the Testkube files.

## Rules

### Demo branches
- `demo/detail-and-stats-polish` and `demo/refresh-layout-fix` are permanent demo branches.
  Never merge them, never delete them, never rebase them without a reason.
- `demo/refresh-layout-fix` contains a deliberate regression. Its two failing
  pull-to-refresh tests are the point of that branch. Do not fix it.
- A push to any `demo/` branch starts `android-test-selection` in Testkube through
  `.github/workflows/test-selection.yml`, and each run costs one AI agent chat.
  Pushing a demo branch under a new `demo/` name is the way to start the flow again.
- Never force push to `main`.

### Test selection
- `testkube/tracer/trace-android.mjs` is read from `main` by the `android-test-selection`
  workflow. A change to it on a branch has no effect until it is on `main`.
- The YAML in `testkube/workflows/` mirrors what is deployed in Testkube. Change both
  together.
- The agent and trigger settings in `testkube/agent/android-test-selector.md` mirror
  the ones in the Testkube dashboard. Change both together.

### Content
- No customer names, ticket ids or internal identifiers anywhere in this repo,
  including commit messages and branch names.
- Keep the original Apache 2.0 license and notices. List changes from the original
  in `README.md`.
