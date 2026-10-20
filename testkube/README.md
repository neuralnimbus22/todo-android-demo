# Testkube files for test selection

| File | What it is |
| --- | --- |
| `workflows/android-test-selection.yaml` | Lists the changed files on a branch, runs the trace script from `main`, and saves `impact.json`, `change.diff` and `changed.txt`. No AI. |
| `tracer/trace-android.mjs` | The trace script. It builds the app's dependency graph from Kotlin and Java references, layouts, navigation graphs, menus and resources, walks it backwards from each changed file, and labels every instrumented test class. |
| `workflows/espresso-ui-selected.yaml` | Builds the app, boots an emulator in the cluster and runs only the test classes it is given. Saves the agent's decisions as `selection.json`. |
| `agent/android-test-selector.md` | The AI agent's instructions and tools, and the trigger that starts it. |
| `ci/test-selection.sh` | Runs the flow from CI in four stages: `trace`, `pick`, `run` and `report`. The CircleCI job calls one stage per step. It finds the agent's emulator run by its `evidence` tag, follows it, and saves the JUnit files, the Android test report and the agent's decisions in `test-results/`. |

## The verdicts in impact.json

| Verdict | Meaning | What the agent does |
| --- | --- | --- |
| `test_changed` | The test class itself changed. | Runs it. |
| `uses_changed_helper` | It uses a test helper that changed. | Runs it. |
| `checks_change` | It checks a view the change renders, or calls changed code directly. | Runs it. |
| `opens_reached_screen` | It opens a screen the change reaches, without checking anything the change renders. | Reads the diff. Runs it only if the change could stop that screen from opening or loading. |
| `not_reached` | Nothing it touches is on the change's path. | Skips it. |

Gradle files, the manifest, themes and shrinker rules mean run everything.

## CI

The CircleCI job in `.circleci/config.yml` installs the Testkube CLI, connects with the `TESTKUBE_API_KEY` project variable, and runs `ci/test-selection.sh` one stage per step:

| Step | What happens |
| --- | --- |
| Trace the change to the test classes | Starts `android-test-selection` for the branch, tagged with the commit, and follows it. |
| Wait for the AI agent to pick the tests | Waits for the `espresso-ui-selected` run the agent tags `evidence=<trace run>`, then prints the agent's decisions. If the agent picks nothing, it tags the trace run `selection=none` and the job passes. |
| Run the picked tests on the emulator | Follows the emulator run and fails when it fails. |
| Collect the test results | Downloads the JUnit files and the Android test report, and prints the totals and the failing tests. |

## The emulator

`espresso-ui-selected` runs in a privileged pod, because the emulator needs `/dev/kvm`. The Android SDK, the emulator, the system image and the Gradle cache are kept on the node at `/var/lib/testkube-android-cache`, so only the first run on a node downloads them.
