#!/usr/bin/env node
// Trace an Android code change to the instrumented (Espresso) test classes that reach it.
//
// Lives in this repo at testkube/tracer/trace-android.mjs. The android-test-selection
// workflow in Testkube takes it from main, so a change cannot rewrite the rules that
// judge it. It reads the repo checked out at a branch and writes impact.json, which
// the selector agent reads to decide which test classes to run on the emulator.
//
// How it works, with no mapping file to maintain:
//   1. Build the dependency graph of the app: Kotlin and Java references, layouts
//      (custom views, data binding variables and adapters, includes), navigation
//      graphs, menus and resources. Walk it backwards from each changed file.
//   2. Every Activity and Fragment on that walk is a reached screen. An Activity
//      that only hosts a reached screen through its navigation graph counts for a
//      test only when the test shows it goes to that screen.
//   3. A test class "checks the change" when it checks a view (R.id) or a Compose
//      test tag that the change renders, or calls changed code directly. A test class that only
//      opens a reached screen is reported as "opens a reached screen", for the
//      agent to judge.
//   4. Gradle, manifest and theme files always mean "run everything".
//
// Usage:
//   node trace-android.mjs --root <repo> --changed <file with one path per line>
//        [--diff change.diff] [--variant mockDebug] [--out impact.json]
//        [--base main] [--branch name] [--head sha]

import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root ?? ".");
const VARIANT = args.variant ?? "mockDebug"; // the build the emulator runs
const [FLAVOR, BUILD_TYPE] = VARIANT.match(/^([a-z]\w*?)?([A-Z]\w*)$/)?.slice(1).map((x) => (x ?? "").toLowerCase()) ?? ["", VARIANT];
const VARIANT_SETS = new Set(["main", FLAVOR, BUILD_TYPE, VARIANT].filter(Boolean));

const RUN_EVERYTHING = [
  [/(^|\/)(build|settings)\.gradle(\.kts)?$/, "the Gradle build changed"],
  [/(^|\/)gradle\.properties$/, "the Gradle properties changed"],
  [/(^|\/)gradle\/.*\.(toml|properties|jar)$/, "the Gradle wrapper or version catalog changed"],
  [/(^|\/)gradlew(\.bat)?$/, "the Gradle wrapper changed"],
  [/(^|\/)AndroidManifest\.xml$/, "the manifest changed"],
  [/(^|\/)proguard[^/]*\.(pro|txt)$/, "the shrinker rules changed"],
  [/\/res\/values[^/]*\/(styles|themes|attrs)\.xml$/, "themes and styles apply to every screen"],
];
const DOCS = [/\.md$/i, /^docs\//, /(^|\/)LICENSE/i, /(^|\/)CONTRIBUTING/i, /\.(png|jpg|gif)$/i];
const OTHER = [
  [/^\.github\//, "GitHub Actions"], [/^\.circleci\//, "CircleCI"], [/^testkube\//, "Testkube resources"],
  [/^\.idea\//, "IDE settings"], [/^\.claude\//, "Claude commands"],
];
const SKIP_DIRS = new Set([".git", "build", ".gradle", ".idea", "node_modules", ".cxx", ".kotlin"]);
const VALUE_TYPES = ["string", "plurals", "string-array", "array", "color", "dimen", "integer", "bool"];

// ---------- read the repo ----------

const allFiles = walk(ROOT, "").filter((f) => describe(f).inVariant !== false);
const info = new Map(allFiles.map((f) => [f, describe(f)]));
const codeFiles = allFiles.filter((f) => info.get(f).kind === "code");
const xmlRes = allFiles.filter((f) => ["layout", "menu", "navigation", "drawable", "xml"].includes(info.get(f).resType) && f.endsWith(".xml"));

const code = new Map(); // file -> parsed code
for (const f of codeFiles) code.set(f, parseCode(read(f)));

// Symbol index: simple name -> declarations
const decls = new Map();
for (const [file, c] of code) {
  for (const name of c.decls) {
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push({ file, pkg: c.pkg });
  }
}
const fqcnToFile = new Map();
for (const [file, c] of code) for (const name of c.decls) fqcnToFile.set(`${c.pkg}.${name}`, file);

// Binding adapters: attribute -> files that declare it
const adapters = new Map();
for (const [file, c] of code) {
  for (const attr of c.bindingAdapters) {
    for (const key of [attr, attr.replace(/^\w+:/, "")]) {
      if (!adapters.has(key)) adapters.set(key, new Set());
      adapters.get(key).add(file);
    }
  }
}

// Resources by type and name
const resByName = new Map(); // "layout/tasks_frag" -> [files]
for (const f of allFiles) {
  const i = info.get(f);
  if (!i.resType || i.resType === "values") continue;
  const key = `${i.resType}/${i.resName}`;
  if (!resByName.has(key)) resByName.set(key, []);
  resByName.get(key).push(f);
}

const xml = new Map(); // file -> parsed elements
for (const f of xmlRes) xml.set(f, parseXml(read(f)));

// Navigation graphs: destinations
const destinations = []; // { graph, id, cls, file }
const graphStart = new Map(); // graph file -> start destination class file
for (const f of xmlRes.filter((x) => info.get(x).resType === "navigation")) {
  const els = xml.get(f);
  const startId = idName(els[0]?.attrs["app:startDestination"]);
  for (const el of els) {
    const cls = el.attrs["android:name"];
    if (!["fragment", "activity", "dialog"].includes(el.tag) || !cls) continue;
    const file = resolveClass(cls, f);
    const id = idName(el.attrs["android:id"]);
    destinations.push({ graph: f, id, cls, file });
    if (startId && id === startId && file) graphStart.set(f, file);
  }
}
const destById = new Map(destinations.filter((d) => d.id && d.file).map((d) => [d.id, d]));

// ---------- the dependency graph ----------

const edges = []; // { from, to, kind, ...extra }
const edge = (from, to, kind, extra = {}) => { if (from && to && from !== to) edges.push({ from, to, kind, ...extra }); };

for (const [file, c] of code) {
  for (const target of referencedFiles(file, c)) edge(file, target, "code");
  for (const ref of c.rRefs) {
    if (ref.type === "id") continue;
    if (VALUE_TYPES.includes(ref.type)) edge(file, `${ref.type}/${ref.name}`, "value");
    else for (const t of resByName.get(`${ref.type}/${ref.name}`) ?? []) edge(file, t, "resource");
  }
  for (const b of c.bindings) for (const t of resByName.get(`layout/${b}`) ?? []) edge(file, t, "binding");
  for (const id of c.idents) {
    const m = id.match(/^([A-Z]\w*?)(Directions|Args)$/);
    if (!m) continue;
    for (const d of destinations) if (d.file && path.basename(d.file).replace(/\.\w+$/, "") === m[1]) edge(file, d.graph, "navargs");
  }
}

for (const [file, els] of xml) {
  const type = info.get(file).resType;
  const vars = new Map(); // binding variable or import alias -> class file
  for (const el of els) {
    if (el.tag === "variable" && el.attrs.type) {
      const t = resolveClass(el.attrs.type, file);
      if (t) { vars.set(el.attrs.name, t); edge(file, t, "var", { name: el.attrs.name }); }
    }
    if (el.tag === "import" && el.attrs.type) {
      const t = resolveClass(el.attrs.type, file);
      if (t) { const alias = el.attrs.alias ?? el.attrs.type.split(".").pop(); vars.set(alias, t); edge(file, t, "var", { name: alias }); }
    }
  }
  for (const el of els) {
    if (type === "layout") {
      if (el.tag.includes(".")) { const t = resolveClass(el.tag, file); if (t) edge(file, t, "view", { tag: el.tag }); }
      for (const key of ["class", "android:name"]) {
        if (el.attrs[key] && (el.tag === "view" || /fragment/i.test(el.tag))) { const t = resolveClass(el.attrs[key], file); if (t) edge(file, t, "view", { tag: el.attrs[key] }); }
      }
    }
    if (type === "navigation" && el.attrs["android:name"]) {
      const t = resolveClass(el.attrs["android:name"], file);
      if (t) edge(file, t, "destination");
    }
    for (const [attr, value] of Object.entries(el.attrs)) {
      for (const m of value.matchAll(/@\+?(layout|menu|navigation|drawable|mipmap|string|plurals|array|color|dimen|integer|bool|font|anim)\/([\w.]+)/g)) {
        const [, rtype, rname] = m;
        if (VALUE_TYPES.includes(rtype)) edge(file, `${rtype}/${rname}`, "value");
        else for (const t of resByName.get(`${rtype}/${rname}`) ?? []) edge(file, t, rtype === "navigation" ? "navhost" : "resource");
      }
      if (/^@=?\{/.test(value)) {
        for (const a of [attr, attr.replace(/^\w+:/, "")]) for (const t of adapters.get(a) ?? []) edge(file, t, "adapter", { attr });
      }
    }
    if (type === "navigation" && el.tag === "include" && el.attrs["app:graph"]) {
      const n = el.attrs["app:graph"].replace(/^@navigation\//, "");
      for (const t of resByName.get(`navigation/${n}`) ?? []) edge(file, t, "navhost");
    }
  }
}

const reverse = new Map(); // to -> edges into it
const forward = new Map(); // from -> edges out of it
for (const e of edges) {
  if (!reverse.has(e.to)) reverse.set(e.to, []);
  reverse.get(e.to).push(e);
  if (!forward.has(e.from)) forward.set(e.from, []);
  forward.get(e.from).push(e);
}
const out = (n) => forward.get(n) ?? [];
const PRIORITY = ["view", "var", "adapter", "binding", "resource", "navhost", "value", "code", "navargs", "destination"];
for (const list of reverse.values()) list.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));

// ---------- classify the change ----------

const changed = fs.readFileSync(args.changed, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const diff = args.diff && fs.existsSync(args.diff) ? parseDiff(fs.readFileSync(args.diff, "utf8")) : null;
const changedSet = new Set(changed);
const changes = changed.map((file) => classify(file));
const runAll = changes.filter((c) => c.kind === "run_everything");
const changedValues = new Set(changes.flatMap((c) => c.resources ?? []));

// ---------- walk backwards from each change ----------
// Destinations do not pass the change on to their navigation graph here. A host
// Activity that only shows a reached screen through navigation is handled below.

const parent = new Map(); // node -> { from: node it was reached from, kind }
const reached = new Set();
const queue = [];
for (const c of changes) {
  if (["source", "layout", "menu", "navigation", "resource", "test_helper"].includes(c.kind) && fs.existsSync(path.join(ROOT, c.file))) {
    reached.add(c.file); queue.push(c.file);
  }
}
for (const v of changedValues) { reached.add(v); queue.push(v); }
while (queue.length) {
  const cur = queue.shift();
  for (const e of reverse.get(cur) ?? []) {
    if (e.kind === "destination") continue;
    if (e.kind === "navargs" && !changedSet.has(cur)) continue; // only a changed graph regenerates Directions and Args
    if (reached.has(e.from)) continue;
    reached.add(e.from);
    parent.set(e.from, { from: cur, kind: e.kind });
    queue.push(e.from);
  }
}

const isApp = (f) => info.get(f)?.role === "app";
const screens = new Set(codeFiles.filter((f) => isApp(f) && code.get(f).screen));
const reachedScreens = [...reached].filter((f) => screens.has(f));

// Host activities: an Activity whose layout hosts a graph with reached destinations
const graphsOf = new Map(); // activity file -> nav graph files it hosts
for (const s of screens) {
  const graphs = new Set();
  const seen = new Set([s]);
  const q = [s];
  while (q.length) {
    const cur = q.shift();
    for (const e of out(cur)) {
      if (e.kind === "navhost") { graphs.add(e.to); for (const g of nestedGraphs(e.to)) graphs.add(g); continue; }
      if (["binding", "resource"].includes(e.kind) && info.get(e.to)?.resType === "layout" && !seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  if (graphs.size) graphsOf.set(s, graphs);
}
const viaNavigation = new Map(); // host screen -> reached destination files
for (const [host, graphs] of graphsOf) {
  if (reached.has(host)) continue;
  const dests = destinations.filter((d) => graphs.has(d.graph) && d.file && (reached.has(d.file) || changedSet.has(d.file))).map((d) => d.file);
  if (dests.length) viaNavigation.set(host, [...new Set(dests)]);
}

// Which screens show which layouts and menus (for views named the same on several screens)
const owners = new Map(); // layout or menu file -> screens that show it
for (const s of screens) {
  const seen = new Set([s]);
  const q = [s];
  while (q.length) {
    const cur = q.shift();
    for (const e of out(cur)) {
      if (!["code", "binding", "resource"].includes(e.kind) || seen.has(e.to)) continue;
      if (screens.has(e.to) && e.to !== s) continue;
      if (info.get(e.to)?.role === "test") continue;
      seen.add(e.to); q.push(e.to);
      const rt = info.get(e.to)?.resType;
      if (rt === "layout" || rt === "menu") {
        if (!owners.has(e.to)) owners.set(e.to, new Set());
        owners.get(e.to).add(s);
      }
    }
  }
}
const idOwners = new Map(); // view id -> screens that show it
for (const [file, els] of xml) {
  const rt = info.get(file).resType;
  if (rt !== "layout" && rt !== "menu") continue;
  for (const el of els) {
    if (!el.id || !/^@\+id\//.test(el.attrs["android:id"] ?? "")) continue;
    if (!idOwners.has(el.id)) idOwners.set(el.id, new Set());
    for (const s of owners.get(file) ?? []) idOwners.get(el.id).add(s);
  }
}

// ---------- views the change renders ----------

const carriers = []; // { id, file, via, how }
const addCarrier = (el, file, via, how, withChildren) => {
  const els = xml.get(file);
  const list = withChildren ? [el, ...descendants(els, el)] : [el];
  for (const x of list) if (x.id) carriers.push({ id: x.id, file, via, how });
};
for (const [file, els] of xml) {
  const rt = info.get(file).resType;
  if (rt !== "layout" && rt !== "menu") continue;
  if (changedSet.has(file)) {
    const touched = diff?.files.get(file);
    if (touched) {
      for (const el of els) {
        const inTag = touched.added.some((l) => l >= el.start && l <= el.tagEnd);
        const inBody = touched.added.some((l) => l > el.tagEnd && l <= el.end && !el.children.some((ch) => l >= els[ch].start && l <= els[ch].end));
        if (inTag) addCarrier(el, file, file, "the element changed", true);
        else if (inBody) addCarrier(el, file, file, "its content changed", false);
      }
      for (const p of touched.removedAt) {
        const inner = (pred) => els.filter(pred).sort((a, b) => b.start - a.start)[0];
        const tagHit = inner((el) => p > el.start && p <= el.tagEnd);
        if (tagHit) { addCarrier(tagHit, file, file, "the element changed", true); continue; }
        const bodyHit = inner((el) => p > el.tagEnd && p <= el.end);
        if (bodyHit) addCarrier(bodyHit, file, file, "its content changed", false);
      }
    } else {
      for (const el of els) if (el.id) carriers.push({ id: el.id, file, via: file, how: "the layout changed" });
    }
  }
  if (!reached.has(file)) continue;
  for (const e of out(file).filter((x) => reached.has(x.to))) {
    const via = e.to;
    if (e.kind === "view") {
      for (const el of els) if (el.tag === e.tag || el.attrs.class === e.tag || el.attrs["android:name"] === e.tag) addCarrier(el, file, via, `inside ${e.tag.split(".").pop()}`, true);
    } else if (e.kind === "var") {
      const re = new RegExp(`\\b${e.name}\\b`);
      for (const el of els) {
        const hits = Object.entries(el.attrs).filter(([a, v]) => /^@=?\{/.test(v) && re.test(v));
        if (hits.length) addCarrier(el, file, via, `bound to ${e.name}`, hits.some(([a]) => a === "android:visibility"));
      }
    } else if (e.kind === "adapter") {
      for (const el of els) if (el.attrs[e.attr] !== undefined && /^@=?\{/.test(el.attrs[e.attr])) addCarrier(el, file, via, `uses the ${e.attr} binding adapter`, false);
    } else if (e.kind === "resource" || e.kind === "navhost") {
      const rel = info.get(via);
      const ref = `@${rel.resType}/${rel.resName}`;
      for (const el of els) if (Object.values(el.attrs).some((v) => v.includes(ref))) addCarrier(el, file, via, `uses ${ref}`, false);
    }
  }
  for (const e of out(file).filter((x) => x.kind === "value" && changedValues.has(x.to))) {
    const ref = `@${e.to}`;
    for (const el of els) if (Object.values(el.attrs).some((v) => v.includes(ref))) addCarrier(el, file, e.to, `shows the changed ${e.to}`, false);
  }
}
// Views that changed code refers to by id
for (const c of changes.filter((x) => x.kind === "source" && code.has(x.file))) {
  const p = code.get(c.file);
  for (const b of p.bindings) {
    for (const t of resByName.get(`layout/${b}`) ?? []) {
      for (const el of xml.get(t) ?? []) if (el.id && p.idents.has(camel(el.id))) carriers.push({ id: el.id, file: t, via: c.file, how: "the changed code uses it" });
    }
  }
  const mine = new Set([...owners].filter(([, s]) => s.has(c.file)).map(([f]) => f));
  for (const id of new Set(p.rRefs.filter((r) => r.type === "id").map((r) => r.name))) {
    const defs = [...xml].filter(([, els]) => els.some((el) => el.id === id && /^@\+id\//.test(el.attrs["android:id"] ?? ""))).map(([f]) => f);
    const pick = defs.filter((f) => mine.has(f));
    for (const f of pick.length ? pick : defs) carriers.push({ id, file: f, via: c.file, how: "the changed code uses it" });
  }
}

// Compose test tags that the change renders: tags set in changed code, or in
// reached code below a screen (a screen that only calls a changed composable does
// not count, the same way a layout's own views do not).
const tagCarriers = []; // { tag, file, how }
for (const f of reached) {
  const p = code.get(f);
  if (!p || !p.tagsSet.length || info.get(f)?.role !== "app") continue;
  if (screens.has(f) && !changedSet.has(f)) continue;
  for (const tag of p.tagsSet) tagCarriers.push({ tag, file: f, how: changedSet.has(f) ? "set in the changed code" : "set in code the change reaches" });
}

// ---------- read the tests ----------

const testFiles = codeFiles.filter((f) => info.get(f).role === "test" && /@Test\b/.test(code.get(f).text));
const helperFiles = new Set(codeFiles.filter((f) => info.get(f).role === "test" && !testFiles.includes(f)));
const changedHelpers = changes.filter((c) => c.kind === "test_helper").map((c) => c.file);
const unitTests = codeFiles.filter((f) => info.get(f).role === "unit" && /@Test\b/.test(code.get(f).text));

const tests = testFiles.sort().map((file) => {
  const c = code.get(file);
  const cls = `${c.pkg}.${path.basename(file).replace(/\.\w+$/, "")}`;
  const count = (c.text.match(/@Test\b/g) ?? []).length;
  const refs = referencedFiles(file, c);
  const helperRefs = closure(refs.filter((r) => helperFiles.has(r)), (h) => referencedFiles(h, code.get(h)).filter((r) => helperFiles.has(r)));
  const appRefs = new Set([...refs, ...helperRefs.flatMap((h) => referencedFiles(h, code.get(h)))].filter((r) => isApp(r)));
  const checkedIds = [...new Set(c.rRefs.filter((r) => r.type === "id").map((r) => r.name))];
  const opensScreens = [...appRefs].filter((r) => screens.has(r));
  const evidence = new Map(); // screen file -> how the test gets there
  const note = (s, how) => { if (s && !evidence.has(s)) evidence.set(s, how); };
  for (const s of opensScreens) note(s, "launches it");
  for (const id of checkedIds) if (destById.has(id)) note(destById.get(id).file, `navigates to ${id}`);
  for (const id of checkedIds) {
    const own = idOwners.get(id);
    if (own && own.size === 1) note([...own][0], `checks ${id}, shown only there`);
  }
  for (const s of opensScreens) for (const g of graphsOf.get(s) ?? []) if (graphStart.has(g)) note(graphStart.get(g), `first screen of ${screenName(s)}`);
  const out = {
    class: cls, file, source_set: info.get(file).set, tests: count,
    opens: [...evidence.keys()].map(screenName).sort(),
  };
  if (changedSet.has(file)) return { ...out, verdict: "test_changed" };
  const helper = changedHelpers.find((h) => helperRefs.includes(h));
  if (helper) return { ...out, verdict: "uses_changed_helper", helper };

  const checks = [];
  for (const id of checkedIds) {
    for (const k of carriers.filter((x) => x.id === id)) {
      const own = idOwners.get(id) ?? new Set();
      const fileOwners = owners.get(k.file) ?? new Set();
      const unambiguous = own.size <= 1 || [...fileOwners].some((s) => evidence.has(s));
      if (unambiguous && !checks.some((x) => x.view === id)) checks.push({ view: id, rendered_by: k.file, because: k.how, change: k.via });
    }
  }
  for (const tag of new Set(c.tagsUsed)) {
    const k = tagCarriers.find((x) => x.tag === tag);
    if (k && !checks.some((x) => x.tag === tag)) checks.push({ tag, rendered_by: k.file, because: k.how, change: k.file });
  }
  const calls = [...appRefs].filter((r) => changedSet.has(r) && !screens.has(r)).map((r) => ({ code: r }));
  const opensReached = [...evidence]
    .filter(([s]) => reached.has(s) || changedSet.has(s))
    .map(([s, how]) => `${screenName(s)} (${how})`)
    .sort();
  const usesReached = [...appRefs].filter((r) => reached.has(r) && !changedSet.has(r) && !screens.has(r));
  if (checks.length || calls.length) return { ...out, verdict: "checks_change", checks, ...(calls.length ? { calls } : {}), opens_reached: opensReached };
  if (opensReached.length) return { ...out, verdict: "opens_reached_screen", opens_reached: opensReached };
  if (usesReached.length) return { ...out, verdict: "opens_reached_screen", opens_reached: [], uses_reached: usesReached };
  return { ...out, verdict: "not_reached" };
});

// ---------- write ----------

const paths = reachedScreens.map((s) => ({ to: screenName(s), files: chain(s) })).sort((a, b) => a.to.localeCompare(b.to));
for (const [host, dests] of viaNavigation) {
  paths.push({ to: screenName(host), files: [...chain(dests[0]), ...navChain(host, dests[0])], by_navigation_to: dests.map(screenName) });
}
const totalTests = tests.reduce((n, t) => n + t.tests, 0);
const result = {
  generated_by: "testkube/tracer/trace-android.mjs, run by the android-test-selection workflow",
  variant: VARIANT,
  base: args.base ?? null,
  branch: args.branch ?? null,
  head: args.head ?? null,
  changed: changes,
  run_everything: { required: runAll.length > 0, files: runAll.map((c) => c.file), because: [...new Set(runAll.map((c) => c.because))] },
  reached_screens: [...new Set([...reachedScreens.map(screenName), ...[...viaNavigation.keys()].map(screenName)])].sort(),
  paths,
  tests,
  other_suites: [{ name: "JVM unit tests (src/test)", classes: unitTests.length, note: "they run outside the emulator and are not selected here" }],
  projects: ["emulator"],
  tests_per_project: { emulator: totalTests },
};
if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
printSummary(result);

// ---------- helpers ----------

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  if (!o.changed) {
    console.error("usage: node trace-android.mjs --root <repo> --changed <file> [--diff change.diff] [--out impact.json]");
    process.exit(2);
  }
  return o;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function walk(abs, rel) {
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(abs, entry.name), childRel));
    else out.push(childRel);
  }
  return out;
}

function describe(file) {
  let m = file.match(/^(?:(.*)\/)?src\/([^/]+)\/(?:java|kotlin)\/.+\.(kt|java)$/);
  if (m) return { kind: "code", module: m[1] ?? "", set: m[2], role: roleOf(m[2]), inVariant: inVariant(m[2]) };
  m = file.match(/^(?:(.*)\/)?src\/([^/]+)\/res\/([a-z]+)(-[^/]+)?\/([^/]+)$/);
  if (m) return { kind: "res", module: m[1] ?? "", set: m[2], role: roleOf(m[2]), inVariant: inVariant(m[2]), resType: m[3], resName: m[5].replace(/(\.9)?\.\w+$/, "") };
  return { kind: "other" };
}

function inVariant(set) {
  if (set === "sharedTest") return true;
  const base = set.replace(/^(androidTest|test)(?=[A-Z]|$)/, "");
  if (!base) return true;
  return VARIANT_SETS.has(base.charAt(0).toLowerCase() + base.slice(1));
}

function roleOf(set) {
  if (/^androidTest/.test(set) || set === "sharedTest") return "test";
  if (/^test/.test(set)) return "unit";
  return "app";
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
}

function parseCode(src) {
  const text = stripComments(src);
  const pkg = (text.match(/^\s*package\s+([\w.]+)/m) ?? [])[1] ?? "";
  const imports = [...text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/gm)]
    .map((m) => ({ path: m[1], wildcard: Boolean(m[2]), alias: m[3] }));
  const declsOut = new Set();
  for (const line of text.split("\n")) {
    if (/^\s/.test(line)) continue;
    const m = line.match(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|protected|abstract|open|sealed|data|enum|annotation|inline|value|external|expect|actual|final|static|const|suspend|tailrec|operator|infix|lateinit)\s+)*(fun\s+interface|class|interface|object|typealias|fun|val|var|@interface|enum)\s+(.*)$/);
    if (!m) continue;
    let rest = m[2].replace(/^<[^>]*>\s*/, "");
    if (/^(fun|val|var)$/.test(m[1])) {
      const head = rest.split(/[(:={\s]/)[0];
      const name = head.split(".").pop();
      if (/^[A-Za-z_]\w*$/.test(name)) declsOut.add(name);
    } else {
      const name = (rest.match(/^([A-Za-z_]\w*)/) ?? [])[1];
      if (name) declsOut.add(name);
    }
  }
  const bindingAdapters = [...text.matchAll(/@BindingAdapter\(\s*(?:value\s*=\s*)?(?:\[|arrayOf\()?\s*((?:"[^"]+"\s*,?\s*)+)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const rRefs = [...text.matchAll(/\bR\.(layout|menu|navigation|drawable|mipmap|string|plurals|array|color|dimen|integer|bool|id|font|anim|xml|raw)\.(\w+)/g)]
    .map((m) => ({ type: m[1], name: m[2] }));
  const idents = new Set(text.match(/\b[A-Za-z_]\w*\b/g) ?? []);
  const tagsSet = [...text.matchAll(/\btestTag\(\s*"([^"$]+)"/g)].map((m) => m[1]);
  const tagsUsed = [...text.matchAll(/\b(?:onNodeWithTag|onAllNodesWithTag|hasTestTag)\(\s*"([^"$]+)"/g)].map((m) => m[1]);
  const bindings = [...idents].filter((i) => /^[A-Z]\w*Binding$/.test(i) && i !== "ViewDataBinding" && i !== "ViewBinding").map((i) => snake(i.replace(/Binding$/, "")));
  const screen = [...text.matchAll(/^(?:(?:public|internal|private|open|abstract|final)\s+)*class\s+(\w+)/gm)].some((m) => /(Activity|Fragment)$/.test(m[1]))
    || /@Composable\s+(?:\w+\s+)*fun\s+\w+Screen\s*\(/.test(text);
  return { text, pkg, imports, decls: declsOut, bindingAdapters, rRefs, idents, bindings, screen, tagsSet, tagsUsed };
}

function referencedFiles(file, c) {
  const out = new Set();
  const exact = new Map(c.imports.filter((i) => !i.wildcard).map((i) => [i.alias ?? i.path.split(".").pop(), i.path]));
  const wild = new Set(c.imports.filter((i) => i.wildcard).map((i) => i.path));
  for (const id of c.idents) {
    const imported = exact.get(id);
    if (imported) {
      const name = imported.split(".").pop();
      const pkgPath = imported.slice(0, -(name.length + 1));
      for (const d of decls.get(name) ?? []) if (d.pkg === pkgPath && d.file !== file) out.add(d.file);
      continue;
    }
    for (const d of decls.get(id) ?? []) {
      if (d.file === file) continue;
      if (d.pkg === c.pkg || wild.has(d.pkg) || c.text.includes(`${d.pkg}.${id}`)) out.add(d.file);
    }
  }
  return [...out];
}

function resolveClass(name, fromXml) {
  if (!name) return null;
  if (fqcnToFile.has(name)) return fqcnToFile.get(name);
  if (name.startsWith(".")) {
    for (const [fq, f] of fqcnToFile) if (fq.endsWith(name)) return f;
  }
  const outer = name.split("$")[0];
  return fqcnToFile.get(outer) ?? null;
}

function parseXml(src) {
  const lineAt = [];
  let line = 1;
  for (let i = 0; i < src.length; i++) { lineAt.push(line); if (src[i] === "\n") line++; }
  lineAt.push(line);
  const els = [];
  const stack = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) { i = src.indexOf("-->", i); i = i < 0 ? src.length : i + 3; continue; }
    if (src.startsWith("<?", i)) { i = src.indexOf("?>", i); i = i < 0 ? src.length : i + 2; continue; }
    if (src.startsWith("<![CDATA[", i)) { i = src.indexOf("]]>", i); i = i < 0 ? src.length : i + 3; continue; }
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const idx = stack.pop();
      if (idx !== undefined) els[idx].end = lineAt[end];
      i = end + 1;
      continue;
    }
    if (src[i] === "<") {
      const start = i;
      let j = i + 1;
      while (j < src.length && /[^\s/>]/.test(src[j])) j++;
      const tag = src.slice(i + 1, j);
      const attrs = {};
      let selfClose = false;
      while (j < src.length) {
        while (/\s/.test(src[j])) j++;
        if (src.startsWith("/>", j)) { selfClose = true; j += 2; break; }
        if (src[j] === ">") { j++; break; }
        let k = j;
        while (k < src.length && /[^\s=/>]/.test(src[k])) k++;
        const name = src.slice(j, k);
        j = k;
        while (/\s/.test(src[j])) j++;
        if (src[j] === "=") {
          j++;
          while (/\s/.test(src[j])) j++;
          const q = src[j];
          const close = src.indexOf(q, j + 1);
          attrs[name] = decode(src.slice(j + 1, close));
          j = close + 1;
        } else if (!name) j++;
      }
      const el = { tag, attrs, id: idName(attrs["android:id"]), start: lineAt[start], tagEnd: lineAt[j - 1], end: lineAt[j - 1], parent: stack.length ? stack[stack.length - 1] : -1, children: [] };
      els.push(el);
      const idx = els.length - 1;
      if (el.parent >= 0) els[el.parent].children.push(idx);
      if (!selfClose) stack.push(idx);
      i = j;
      continue;
    }
    i++;
  }
  return els;
}

function decode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function idName(v) {
  const m = (v ?? "").match(/^@(?:\+)?id\/([\w.]+)$/);
  return m ? m[1] : null;
}

function descendants(els, el) {
  const out = [];
  const q = [...el.children];
  while (q.length) { const k = q.shift(); out.push(els[k]); q.push(...els[k].children); }
  return out;
}

function nestedGraphs(g) {
  return (forward.get(g) ?? []).filter((e) => e.kind === "navhost").map((e) => e.to);
}

function parseDiff(text) {
  const files = new Map();
  let cur = null;
  let newLine = 0;
  for (const l of text.split("\n")) {
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).replace(/^b\//, "");
      cur = { added: [], removedAt: [], addedText: [], removedText: [] };
      if (p !== "/dev/null") files.set(p, cur);
      continue;
    }
    if (l.startsWith("--- ")) continue;
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { newLine = Number(h[1]); continue; }
    if (!cur) continue;
    if (l.startsWith("+")) { cur.added.push(newLine); cur.addedText.push(l.slice(1)); newLine++; }
    else if (l.startsWith("-")) { cur.removedAt.push(newLine); cur.removedText.push(l.slice(1)); }
    else if (l.startsWith(" ")) newLine++;
  }
  return { files };
}

function classify(file) {
  const i = info.get(file) ?? describe(file);
  const exists = fs.existsSync(path.join(ROOT, file));
  const all = RUN_EVERYTHING.find(([re]) => re.test(file));
  if (all) return { file, kind: "run_everything", because: all[1] };
  if (!exists) return { file, kind: "deleted" };
  if (i.inVariant === false) return { file, kind: "other_variant", note: `not in the ${VARIANT} build the emulator runs` };
  if (DOCS.some((re) => re.test(file)) && !i.resType) return { file, kind: "docs" };
  const other = OTHER.find(([re]) => re.test(file));
  if (other) return { file, kind: "other", what: other[1] };
  if (i.kind === "code") {
    if (i.role === "unit") return { file, kind: "unit_test" };
    if (i.role === "test") return /@Test\b/.test(read(file)) ? { file, kind: "test" } : { file, kind: "test_helper" };
    return { file, kind: "source" };
  }
  if (i.resType === "values") {
    const d = diff?.files.get(file);
    if (!d) return { file, kind: "run_everything", because: "resource values changed and no diff was given" };
    const names = new Set();
    const typeOf = { string: "string", plurals: "plurals", "string-array": "array", "integer-array": "array", array: "array", color: "color", dimen: "dimen", integer: "integer", bool: "bool" };
    for (const t of [...d.addedText, ...d.removedText]) {
      const m = t.match(/<(string|plurals|string-array|integer-array|array|color|dimen|integer|bool)\b[^>]*\bname="([\w.]+)"/);
      if (m) names.add(`${typeOf[m[1]]}/${m[2]}`);
    }
    if (!names.size) return { file, kind: "run_everything", because: "resource values changed in a way the trace cannot name" };
    return { file, kind: "resource_values", resources: [...names] };
  }
  if (["layout", "menu", "navigation"].includes(i.resType)) return { file, kind: i.resType };
  if (i.resType) return { file, kind: "resource" };
  if (i.kind === "other" && /\.(kt|java|xml)$/.test(file)) return { file, kind: "unknown" };
  return { file, kind: "unknown" };
}

function closure(start, next) {
  const seen = new Set(start);
  const q = [...start];
  while (q.length) for (const n of next(q.shift())) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return [...seen];
}

function chain(node) {
  const out = [node];
  while (parent.has(out[out.length - 1])) out.push(parent.get(out[out.length - 1]).from);
  return out.reverse();
}

function navChain(host, dest) {
  const graph = destinations.find((d) => d.file === dest)?.graph;
  const hostLayouts = edges.filter((e) => e.kind === "navhost" && e.to === graph).map((e) => e.from);
  return [graph, ...hostLayouts.slice(0, 1), host].filter(Boolean);
}

function screenName(file) {
  return path.basename(file).replace(/\.\w+$/, "");
}

function snake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function camel(id) {
  return id.replace(/_(\w)/g, (_, c) => c.toUpperCase());
}

function printSummary(r) {
  const line = (s = "") => console.log(s);
  const short = (f) => f.replace(/^.*\/(java|kotlin)\/(?:[\w]+\/)*?([\w]+\/[\w]+\.(kt|java))$/, "$2").replace(/^.*\/res\//, "res/");
  line(`Change${r.branch ? ` on ${r.branch}` : ""}${r.base ? ` against ${r.base}` : ""}: ${r.changed.length} file(s)`);
  for (const c of r.changed) line(`  ${c.file}  (${c.kind.replace(/_/g, " ")}${c.resources ? `: ${c.resources.join(", ")}` : ""})`);
  line();
  if (r.run_everything.required) { line(`Run everything: yes, because ${r.run_everything.because.join("; ")}`); line(); }
  line(`Reaches ${r.reached_screens.length} screen(s): ${r.reached_screens.join("  ") || "none"}`);
  for (const p of r.paths) line(`  ${p.files.map(short).join(" > ")}${p.by_navigation_to ? `  (hosts ${p.by_navigation_to.join(", ")})` : ""}`);
  line();
  const label = {
    test_changed: "test changed",
    uses_changed_helper: "uses a changed test helper",
    checks_change: "checks the change",
    opens_reached_screen: "opens a reached screen",
    not_reached: "not reached",
  };
  for (const v of Object.keys(label)) {
    const group = r.tests.filter((t) => t.verdict === v);
    if (!group.length) continue;
    line(`${label[v]}:`);
    for (const t of group) {
      let why = "";
      if (t.checks?.length) why = t.checks.map((c) => `${c.view ?? c.tag} (${c.because}, ${short(c.rendered_by)})`).join(", ");
      if (t.calls?.length) why += (why ? "; " : "") + `calls ${t.calls.map((c) => short(c.code)).join(", ")}`;
      if (!why && t.opens_reached?.length) why = `opens ${t.opens_reached.join(", ")}`;
      if (!why && t.uses_reached?.length) why = `uses ${t.uses_reached.map(short).join(", ")}`;
      if (t.helper) why = short(t.helper);
      line(`  ${t.class.split(".").pop()} [${t.source_set}] ${t.tests} test(s)${why ? "  " + why : ""}`);
    }
  }
  line();
  line(`Instrumented tests on the emulator: ${r.tests_per_project.emulator} in ${r.tests.length} classes`);
}
