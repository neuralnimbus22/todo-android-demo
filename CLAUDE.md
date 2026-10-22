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
- A push to any `demo/` branch starts the CircleCI job in `.circleci/config.yml`. It starts
  `android-test-selection` in Testkube, waits for the agent's emulator run, and fails when
  that run fails. Each run costs one AI agent chat. Rerunning the CircleCI job, or pushing a
  demo branch under a new `demo/` name, starts the flow again.
- CircleCI reads `.circleci/config.yml` from the branch it builds, so a new `demo/` branch
  must start from a `main` that has it. To bring an older branch up to date, merge `main`
  into it. Do not rebase.
- `.github/workflows/test-selection.yml` runs only by hand. Keep it that way, or a push
  starts two agent chats.
- Never force push to `main`.

### CI
- The CircleCI job reads the Testkube key from the `TESTKUBE_API_KEY` project environment
  variable. Never put a key or token in this repo.
- `testkube/ci/test-selection.sh` finds the agent's run by its `evidence` tag, and treats
  `selection=none` on the trace run as "nothing to run". Those tags come from the agent
  instructions in `testkube/agent/android-test-selector.md`. Change them together.

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
