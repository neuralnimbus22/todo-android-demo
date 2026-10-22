#!/usr/bin/env bash
# Runs the per-change test selection flow in Testkube from a CI job and reports its result.
# Each stage is a separate call, so each one shows as its own step in the CI log:
#
#   trace   Starts android-test-selection for the branch and follows it to the end. It
#           lists the change and traces it to the Espresso test classes that reach it.
#           No AI runs in this stage.
#   pick    Waits for the AI agent. When the trace passes, a Testkube AI Agent Trigger
#           starts android-test-selector. The agent picks the test classes, starts
#           espresso-ui-selected with only those, and tags that run evidence=<trace run>.
#           If it picks nothing, it tags the trace run selection=none instead.
#   run     Follows the emulator run to the end. Fails when the run fails.
#   report  Downloads the JUnit files, the Android test report and the agent's decisions
#           into test-results/ and prints a summary. It never fails the job on its own.
#
# Needs the testkube CLI with a context already set, jq and python3.
# Reads BRANCH and COMMIT, or CircleCI's CIRCLE_BRANCH and CIRCLE_SHA1, and
# TESTKUBE_ORG_ID and TESTKUBE_ENV_ID for the dashboard links.
set -euo pipefail

STAGE="${1:-}"
BRANCH="${BRANCH:-${CIRCLE_BRANCH:-}}"
COMMIT="${COMMIT:-${CIRCLE_SHA1:-}}"
STATE="${TESTKUBE_FLOW_DIR:-/tmp/testkube-flow}"
RESULTS="${TEST_RESULTS_DIR:-test-results}"
PICK_TIMEOUT="${PICK_TIMEOUT_SECONDS:-900}"
RUN_TIMEOUT="${RUN_TIMEOUT_SECONDS:-2700}"
POLL="${POLL_SECONDS:-10}"
UI="${TESTKUBE_UI_URL:-https://app.testkube.io}"

TRACE_WORKFLOW=android-test-selection
RUN_WORKFLOW=espresso-ui-selected

mkdir -p "$STATE"

fail() { echo "$*" >&2; exit 1; }
save() { printf '%s\n' "$2" > "$STATE/$1"; }
load() { cat "$STATE/$1" 2>/dev/null || true; }
now() { date +%s; }

execution_json() { testkube get testworkflowexecution "$1" -o json; }
status_of() { execution_json "$1" | jq -r '.result.status // "queued"'; }
url_of() {
  echo "$UI/organization/${TESTKUBE_ORG_ID:-}/environment/${TESTKUBE_ENV_ID:-}/dashboard/test-workflows/$1/execution/$2"
}

# The agent's decisions as a table, picked classes first.
print_decisions() {
  jq -r '"The agent picked \(.tests // "an unknown number of tests") on \(.branch // "this branch"):"' "$1"
  jq -r '(.classes // []) | sort_by(.decision != "run") | .[]
         | [(.decision // "?"), (.class // "?"), ((.tests // "") | tostring), (.why // "")] | @tsv' "$1" |
    while IFS=$'\t' read -r decision class tests why; do
      printf '  %-4s  %-26s %3s  %s\n' "$decision" "$class" "$tests" "$why"
    done
}

# Totals and failing tests from the JUnit files that the emulator run saved.
summarize_junit() {
  python3 - "$1" <<'PY'
import glob, os, sys
import xml.etree.ElementTree as ET

files = sorted(glob.glob(os.path.join(sys.argv[1], "**", "junit-*.xml"), recursive=True))
if not files:
    print("No JUnit files were saved. The build may have failed before any test ran.")
    sys.exit(0)
total = skipped = 0
failed = []
for path in files:
    for case in ET.parse(path).getroot().iter("testcase"):
        total += 1
        problem = case.find("failure")
        if problem is None:
            problem = case.find("error")
        if problem is not None:
            lines = [l.strip() for l in (problem.get("message") or problem.text or "").strip().splitlines()]
            # Espresso puts the useful part on its Expected: and Got: lines.
            detail = [l for l in lines if l.startswith(("Expected:", "Got:"))] or lines[:1] or ["no message"]
            name = case.get("classname", "").rsplit(".", 1)[-1] + "." + case.get("name", "")
            failed.append((name, [l[:200] for l in detail]))
        elif case.find("skipped") is not None:
            skipped += 1
summary = f"{total} tests ran on the emulator: {total - len(failed) - skipped} passed, {len(failed)} failed"
print(summary + (f", {skipped} skipped." if skipped else "."))
for name, detail in failed:
    print("  FAILED " + name)
    for line in detail:
        print("         " + line)
PY
}

trace() {
  [ -n "$BRANCH" ] || fail "BRANCH is not set, so there is no branch to trace."
  local args=(run testworkflow "$TRACE_WORKFLOW" --config "branch=$BRANCH" -o json)
  if [ -n "$COMMIT" ]; then
    args+=(--tag "commit=${COMMIT:0:7}")
  fi
  local out id name
  if ! out=$(testkube "${args[@]}"); then
    echo "$out"
    fail "Testkube did not start $TRACE_WORKFLOW."
  fi
  id=$(jq -r '.id // empty' <<<"$out" 2>/dev/null || true)
  name=$(jq -r '.name // empty' <<<"$out" 2>/dev/null || true)
  if [ -z "$id" ]; then
    echo "$out"
    fail "Testkube did not start $TRACE_WORKFLOW."
  fi
  save trace_id "$id"
  save trace_name "$name"
  echo "Started $name for $BRANCH${COMMIT:+ at ${COMMIT:0:7}}."
  echo
  if testkube watch testworkflowexecution "$id"; then
    echo "$name passed. The AI agent takes it from here."
  else
    fail "$name did not pass, so the agent will not start: $(url_of "$TRACE_WORKFLOW" "$id")"
  fi
}

pick() {
  local trace_id trace_name started elapsed last_note=-30 runs run_id run_name
  trace_id=$(load trace_id)
  trace_name=$(load trace_name)
  [ -n "$trace_id" ] || fail "No trace run was started."
  echo "The android-test-selector agent reads the trace and the diff from $trace_name,"
  echo "decides every test class, and starts $RUN_WORKFLOW with the classes it picks."
  started=$(now)
  while :; do
    # The agent tags its run evidence=<trace run>. The decisions it passes in as config
    # also start with that name, which covers a run whose tags are not set yet.
    runs=$(testkube get testworkflowexecution -w "$RUN_WORKFLOW" --limit 10 -o json 2>/dev/null || echo '[]')
    run_id=$(jq -r --arg ev "$trace_name" '
      [ (. // [])[]
        | select((.tags.evidence // "") == $ev
                 or ((.configParams.selection.value // "") | test("\"evidence\"\\s*:\\s*\"" + $ev + "\""))) ]
      | sort_by(.scheduledAt) | last | .id // empty' <<<"$runs" 2>/dev/null || true)
    if [ -n "$run_id" ]; then
      break
    fi
    if [ "$(execution_json "$trace_id" 2>/dev/null | jq -r '.tags.selection // empty' 2>/dev/null)" = none ]; then
      save outcome none
      echo "The agent picked no test class. No instrumented test reaches this change, so nothing runs on the emulator."
      return 0
    fi
    elapsed=$(( $(now) - started ))
    if [ "$elapsed" -ge "$PICK_TIMEOUT" ]; then
      fail "The agent did not start a run within $((PICK_TIMEOUT / 60)) minutes. Check its chat for $trace_name in Testkube."
    fi
    if [ $((elapsed - last_note)) -ge 30 ]; then
      echo "Waiting for the agent: ${elapsed}s"
      last_note=$elapsed
    fi
    sleep "$POLL"
  done

  run_name=$(jq -r --arg id "$run_id" '.[] | select(.id == $id) | .name' <<<"$runs")
  save run_id "$run_id"
  save run_name "$run_name"
  echo "The agent started $run_name after $(( $(now) - started ))s."

  # The run saves the agent's decisions as selection.json in its first step.
  local deadline running_since="" st
  deadline=$(( $(now) + PICK_TIMEOUT ))
  while :; do
    if testkube download artifact "$run_id" selection.json "$STATE" >/dev/null 2>&1 && [ -s "$STATE/selection.json" ]; then
      echo
      print_decisions "$STATE/selection.json" || echo "The agent's decisions in selection.json could not be read."
      return 0
    fi
    st=$(status_of "$run_id" 2>/dev/null || echo unknown)
    case "$st" in
      passed|failed|aborted|canceled)
        echo "$run_name ended ($st) before its decisions could be read."
        return 0 ;;
      running)
        running_since=${running_since:-$(now)}
        if [ $(( $(now) - running_since )) -ge 90 ]; then
          echo "$run_name did not save the agent's decisions."
          return 0
        fi ;;
    esac
    if [ "$(now)" -ge "$deadline" ]; then
      echo "$run_name is still $st. Its decisions will show in the report."
      return 0
    fi
    sleep "$POLL"
  done
}

run() {
  if [ "$(load outcome)" = none ]; then
    echo "The agent picked nothing, so there is nothing to run."
    return 0
  fi
  local run_id run_name rc st
  run_id=$(load run_id)
  run_name=$(load run_name)
  [ -n "$run_id" ] || fail "No emulator run was started."
  echo "Following $run_name. It builds the app, boots an Android emulator in the cluster"
  echo "and runs only the picked test classes."
  echo
  set +e
  timeout "$RUN_TIMEOUT" testkube watch testworkflowexecution "$run_id"
  rc=$?
  set -e
  # The stored status can lag the log stream by a few seconds.
  for _ in 1 2 3 4 5 6; do
    st=$(status_of "$run_id" 2>/dev/null || echo unknown)
    case "$st" in passed|failed|aborted|canceled) break ;; esac
    sleep "$POLL"
  done
  # The watch exits 0 only when the run passed.
  if [ "$rc" -eq 0 ] && [ "$st" != passed ]; then
    case "$st" in failed|aborted|canceled) ;; *) st=passed ;; esac
  fi
  save run_status "$st"
  case "$st" in
    passed) echo "$run_name passed." ;;
    failed|aborted|canceled) fail "$run_name $st." ;;
    *)
      if [ "$rc" -eq 124 ]; then
        fail "$run_name is still $st after $((RUN_TIMEOUT / 60)) minutes: $(url_of "$RUN_WORKFLOW" "$run_id")"
      fi
      fail "Lost track of $run_name while it was $st (testkube watch exit code $rc): $(url_of "$RUN_WORKFLOW" "$run_id")" ;;
  esac
}

report() {
  set +e
  if [ "$(load outcome)" = none ]; then
    echo "No instrumented test reaches this change. No emulator run was needed."
    echo "Trace: $(url_of "$TRACE_WORKFLOW" "$(load trace_id)")"
    return 0
  fi
  local run_id run_name st
  run_id=$(load run_id)
  run_name=$(load run_name)
  if [ -z "$run_id" ]; then
    echo "No emulator run was started, so there are no test results."
    return 0
  fi
  mkdir -p "$RESULTS/junit"
  testkube download artifacts "$run_id" --download-dir "$RESULTS/junit" --mask '^junit-[0-9]+\.xml$' >/dev/null 2>&1
  testkube download artifacts "$run_id" --download-dir "$RESULTS" --mask '^html-report/' >/dev/null 2>&1
  if [ ! -s "$STATE/selection.json" ]; then
    testkube download artifact "$run_id" selection.json "$STATE" >/dev/null 2>&1
  fi
  if [ -s "$STATE/selection.json" ]; then
    cp "$STATE/selection.json" "$RESULTS/"
  fi
  st=$(load run_status)
  if [ -z "$st" ]; then
    st=$(status_of "$run_id" 2>/dev/null || echo unknown)
  fi
  echo "$run_name $st."
  summarize_junit "$RESULTS"
  if [ -s "$RESULTS/selection.json" ]; then
    echo
    print_decisions "$RESULTS/selection.json"
  fi
  echo
  echo "Trace:    $(url_of "$TRACE_WORKFLOW" "$(load trace_id)")"
  echo "Emulator: $(url_of "$RUN_WORKFLOW" "$run_id")"
  return 0
}

case "$STAGE" in
  trace) trace ;;
  pick) pick ;;
  run) run ;;
  report) report ;;
  *) echo "Usage: $0 trace|pick|run|report" >&2; exit 2 ;;
esac
