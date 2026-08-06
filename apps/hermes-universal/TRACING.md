# Debugging & Tracing in Hermes Universal

How to find out where the time actually goes — in the webview, in the Rust
backend, and on a phone.

This file is the operator's manual. The design rationale lives in code comments
(`src/observability/index.ts` and `src-tauri/src/telemetry.rs`), which are the
source of truth if the two ever disagree.

## Why this exists

Built while chasing MJXHRM-139 (chat rendering is slow), where it earned its
keep not by confirming a hunch but by **killing several**. Each of these was
believed and then disproved by measurement: compositor starvation, software
rendering, a too-expensive stylesheet, backdrop-filter cost, and the WebKit
engine itself. The real cause was a layout-tree structure re-rendering every
pane on every drag frame — 109 React commits / 2565 ms in a 9-second drag, while
the store write it was blamed on took 3 ms.

The lesson that shaped the design:

> A hand-placed span encodes a guess about where the time goes, and a wrong
> guess is invisible.

An early span on `$layoutTree` recorded nothing at all, because a sidebar is a
fixed track and writes `$paneStates`. The result was clean, empty, and entirely
convincing — with no hint that the wrong thing had been measured.

Hence the rule the code follows:

> **Auto-instrument the seams. Hand-instrument only what the machine cannot
> name.**

## Quick start — desktop, about 60 seconds

1. Start the collector (once per boot; nothing auto-starts on reboot):

   ```sh
   cd ~/Documents/dev-instances/jaeger && docker compose up -d
   ```

   Jaeger UI: <http://localhost:8200>

2. Run the app as normal (`npm run tauri dev`). The frontend tracing layer is
   already present — it ships, and is off by default.

3. Hit **record** on the floating HUD in the top-right corner, reproduce the
   slow thing, hit **stop**.

That is the whole loop. Everything between record and stop is **one trace**,
and stopping is what completes it — see "One capture, one trace" below.

The HUD is dev/bench only and draggable; `–` collapses it to a pill, `×` hides it
(`__hermesTrace.hud()` brings it back). Its live span count is the thing to
watch: a capture that is running and finding nothing looks different from one
that never started, which is not true of any other readout here.

It is **not** a React component and is not mounted by the app. `installTraceHud()`
appends raw DOM to `<body>` at boot, so it never joins the app's render commits,
never re-renders because the app did, and is up before the first render — it
works during a gateway outage, a routing failure, or a blank screen, which is
when you actually want a tracer. That is a correctness requirement, not tidiness:
the first version was a React component polling at 4Hz inside the app shell, and
it put its own cost into the frames it was measuring.

The console API still exists and drives the same controls, if you prefer it:

```js
__hermesTrace.on()          // start recording, persisted across reloads
// ...reproduce the slow thing...
__hermesTrace.timeline()    // console waterfall, gaps marked
__hermesTrace.off()         // stop — this is what completes the trace
```

To include the Rust backend, add the cargo feature and the env switch:

```sh
HERMES_TRACE=1 npm run tauri dev -- --features tracing
```

## Two halves, four switches

Tracing is deliberately *additive*: nothing runs unless asked for, and a release
build contains as little of it as possible.

| Half | Compiled? | Running? |
| --- | --- | --- |
| **Frontend** | Always. The core (`span.ts`, `otlp.ts`) ships, because a user's bug report is worth an OTLP dump. The exporter, the HUD, store autocapture, IPC propagation and the console API are dev/bench only. | The HUD's record button, or `__hermesTrace.on()` — persisted in localStorage, survives reloads. |
| **Rust backend** | `--features tracing`. A default build links **no** OTel crates at all; `cargo tree` shows zero. | `HERMES_TRACE=1`. Compiled-but-unasked-for costs nothing, and enabling never needs a rebuild. |

Splitting compile-time from runtime is the point: build once with
`--features tracing` and you can trace any later session with an env var, while
a release binary can never be talked into exporting anything.

## One capture, one trace

Everything recorded between record and stop belongs to a single trace, hung off
a single `capture` root span. Two consequences worth knowing before you read a
capture:

- **The trace has no root until you stop.** A root span can only be sent with
  its real end time, so mid-capture Jaeger shows the trace rootless — browsable,
  just missing its top bar. Stopping completes it. A reload also completes it
  (`pagehide`), which matters because editing any traced module triggers one.
- **Captures roll after ten minutes.** Recording and forgetting would otherwise
  build a trace with a quarter million spans that Jaeger will not open. The seam
  is visible as a second `capture` span.

Use **mark** in the HUD (or `__hermesTrace.mark('drag-sidebar')`) to bracket a
named region inside the capture. One trace per capture is what makes the
waterfall causally complete; marks are what make it navigable. Without them a
ten-minute capture is a flat list of four thousand spans with no answer to
"which of these was the drag".

### Why not one trace per interaction

That was the first design and it failed in a way worth recording, because it
looks obviously correct. A span whose synchronous stack was empty was treated as
a ROOT, and every root minted a trace id. But every seam in this app is entered
from a scheduled callback — a `PerformanceObserver`, a Tauri event listener, a
React render, an `await` continuation — so in practice *every* span was a root.
One session produced 573 traces, essentially all of them a single span. Nothing
nested inside anything, so `gapMs` had nothing to subtract from and Jaeger had
nothing to draw.

An empty stack is not evidence that a new trace started. It is evidence that the
work was scheduled, which in a browser is the normal case.

## Naming a run — read this before you capture

Without a label every trace looks alike: same service, same operation names,
differing only by timestamp. Comparing "before the fix" to "after" then means
squinting at clocks.

The label surfaces as the resource attribute `hermes.run`, which Jaeger indexes
as a process tag and offers in its search box.

### Use one variable for both halves

```sh
HERMES_TRACE_RUN=before-fix HERMES_TRACE=1 npm run tauri dev -- --features tracing
```

This is the one to reach for. The Rust process reads `HERMES_TRACE_RUN` from its
environment; a webview has no environment, so `vite.config.ts` bakes the same
name into the bundle at build time. One variable, both halves, same label.

### Full precedence — last one wins

| Lever | Scope | Notes |
| --- | --- | --- |
| *(nothing)* | both | Defaults to the current **git branch name**, so even an unlabelled capture says where it came from. |
| `HERMES_TRACE_RUN=x` | **both halves** | The recommended lever. |
| `VITE_TRACE_RUN=x` | frontend only | Vite's own convention. Useful when you deliberately want the halves labelled differently. Second choice. |
| `__hermesTrace.run('x')` | frontend only, runtime | No rebuild. **Careful:** the backend label is fixed at process start, so calling this mid-session splits the two halves apart. |

`service.name` stays `hermes-universal` in every case. The label is a *filter*,
not an identity — minting a service per experiment would turn Jaeger's service
dropdown into a junk drawer.

## What is captured automatically

Nothing in this list requires touching a call site. That is the whole design.

| Source | What you get | Where |
| --- | --- | --- |
| Interactions | Every click/keypress via `PerformanceObserver('event')`, decomposed into input delay / processing / presentation, plus `frames` — how many frames the interaction spanned — and a `target` named by structure (`span[sash]`, `div[tab:session-tile]`, `div[zone]`) rather than by tag alone | `auto/events.ts` |
| Frames | A `frame` span per frame that did instrumented work, and `frame.stall` for a long frame that did none | `auto/frames.ts` |
| Style vs layout | `layout.forced` — the presentation phase pulled apart into `styleMs` and `layoutMs`, at commit time and again pre-frame | `auto/engine-probe.ts` |
| React commits | `react.commit` for the layout tree, with both the span extent and React's own `actualMs` | `auto/layout-counters.ts` |
| Layout work | `layout.tracks` — per frame: `splitRenders`, `distinctSplits`, `paneVisits` | `auto/layout-counters.ts` |
| Layout mutations | `layout.commit` (with `reason` + tree shape), `layout.adopt`, `layout.persist` (with `bytes`), `layout.tiles.sync` | `tree/store.ts`, `chat/pane-mirror.ts` |
| Opening a chat | `chat.open` — the gesture to the first paint that shows the tile | `store/session-states.ts` |
| The exporter itself | `exporter.drain` — the tracer's own main-thread cost, inside the frames it is measuring | `exporter.ts` |
| Store writes | Every nanostores write, named. A vite alias points `nanostores` at a wrapper so all ~34 direct importers are covered without edits; a build transform recovers the variable name so spans read `$paneStates` rather than `atom#7`. | `auto/stores.ts` |
| HTTP | Every request through the Rust transport | `auto/http.ts` |
| WebSocket | Frame-level, both directions | `auto/websocket.ts` |
| Markdown / Shiki / KaTeX / stream flush | The chat rendering pipeline, stage by stage | hand-placed, semantic |
| All ~50 Tauri commands | Correct timing, including the 41 async ones | `tauri/tracing` feature |
| IPC trace context | A `traceparent` on every `invoke`, so the command spans above join the frontend's trace | `auto/tauri-core.ts` |

### Frames, and the four numbers on a `frame` span

`auto/frames.ts` owns the app's only `requestAnimationFrame` loop — the FPS HUD
subscribes to it rather than running its own, so the HUD's frame times and the
tracer's `frame` spans cannot disagree. It runs only while recording or while
the FPS HUD is visible: a running rAF loop keeps the compositor awake, and an
instrument that changes the app under test in every dev session is worse than
one you have to switch on.

| attribute | what it is |
| --- | --- |
| `sinceLastMs` | rAF → rAF. **Pacing.** Includes idle. What the FPS HUD plots. |
| `rafMs` | our callback's own duration — JS inside the rendering step |
| `activeMs` | rAF start → post-paint task. **The work window.** |
| `paintEstimateMs` | `activeMs − rafMs −` work children reported. The residual: paint and compositing. A subtraction, not a measurement. |

The distinction is the whole point. Bracketing rAF→rAF and calling it "the
frame" reports an idle app as ~16 ms of uninstrumented engine work per frame,
which would turn `gapMs` — the number `span.ts` exists to produce — into noise
everywhere.

The frame span is allocated **lazily**, on the first child that asks for it, so
a frame in which nothing happened produces no span. Idle costs nothing and reads
as nothing.

### Two things to verify by hand before trusting the numbers

Neither is verified on WebKitGTK yet. Until they are, trust `layout.forced` over
`activeMs`.

1. **Is the style/layout split real?** `auto/engine-probe.ts` flushes style with
   `getComputedStyle` and layout with `offsetHeight`, and times them separately.
   If WebKit folds style recalculation into the layout flush, `styleMs` reads 0
   forever and `layoutMs` silently carries both. Check: toggle a class on
   `<html>` and confirm `styleMs` moves while `layoutMs` does not, then change a
   width and confirm the reverse.
2. **Is the post-paint task really post-paint?** `activeMs` ends on a
   `MessageChannel` message posted from inside the rAF callback. Check: dirty a
   large layout inside that callback and confirm `activeMs` grows while `rafMs`
   stays flat. If both grow together, the message is landing before the
   rendering update and `activeMs` is meaningless.

### How to read `layout.tracks` — and how not to

The counters answer **how much work**. `react.commit`'s `actualMs` answers **how
long**. Only together are they a finding.

`performance.now()` is clamped to 1 ms here, so a `layout.tracks` span with
`paneVisits: 340` and a duration of 0 ms does **not** mean the tracks pass is
free — it means the clock could not see it. Read it against the React commit
time in the same frame.

`splitRenders`, not `splitCommits`: React 19 can render a tree and discard it,
so this counts cost *paid*, which may exceed the number of commits. A large
divergence between `splitRenders` and `reactCommits` is itself the finding.

Two more traps worth stating:

- `react.commit` carries **both** its span extent and `actualMs` because they
  measure different things. `actualDuration` is React's summed render work — it
  excludes browser layout and paint, and includes any nested Profiler. The span
  extent covers the whole render + commit including whatever React yielded for.
  A 40 ms `react.commit` with `actualMs: 6` is React *yielding*, not React
  working.
- The engine probe **moves** cost rather than only revealing it: forced layout
  is real work pulled earlier in the frame. Frame durations measured with the
  probe installed are not comparable to frame durations measured without it.

### Why command timing is Tauri's job, not ours

Worth recording so nobody rebuilds it. The obvious approach — wrapping
`generate_handler!` via `Builder::invoke_handler` — **does not work**.
`InvokeResolver::respond_async` spawns the future and returns immediately, so a
wrapper measures *dispatch*, in microseconds, for every async command. Tauri's
own `tracing` feature calls `.instrument()` on the spawned future, which is
exactly the thing a hand-rolled wrapper cannot do. So it is one line in
`Cargo.toml` rather than code we maintain.

There *is* a wrapper in `lib.rs` now — `telemetry::traced_invoke_handler` — and
it is not a timer. It exists to enter a span carrying the webview's trace context
before dispatch, which is the one thing that position is good for: Tauri builds
its command spans inside the generated wrapper, so they inherit the remote parent
from there. Its own duration is meaningless by construction. Do not "fix" it.

## The HUD, and the console API

Both drive the same controller (`tracer` in `observability/exporter.ts`), so they
cannot disagree — changing the run label in the console updates the HUD field.

| HUD | Console | |
| --- | --- | --- |
| ● record / ■ stop | `__hermesTrace.on()` / `.off()` | Recording is persisted across reloads. Stopping completes the trace. |
| flush | `__hermesTrace.flush()` | Send now. |
| clear | `__hermesTrace.clear()` | Drop what has not been sent. |
| auto-drain | `__hermesTrace.autoflush(false)` | Keep spans local so `timeline()` can see them. |
| run label | `__hermesTrace.run('before-fix')` | No rebuild. |
| mark… | `__hermesTrace.mark('drag')` | Open a named region; the next mark or stop closes it. |
| timeline | `__hermesTrace.timeline()` | Console waterfall, gaps marked. |
| copy | `__hermesTrace.otlp()` | Self-contained OTLP JSON for Jaeger's upload tab. |
| jaeger ↗ | — | Opens the UI prefiltered to this run label. |
| × | `__hermesTrace.hud(false)` | Hide the panel. `hud()` brings it back. |
| — | `__hermesTrace.status()` | What the HUD is showing, as an object. |

`autoflush(false)` is the one that catches people out: with auto-drain on (the
default, every 2 s) `timeline()` will often show nothing, because the spans are
already in Jaeger. The empty-state message says so, and the HUD spells out the
state next to the checkbox.

Everything is available in the WebKit inspector console — no devtools-only APIs
are used, deliberately, because the shipping runtime is WebKitGTK rather than
Chromium.

## Android — the loopback trap

The exporter defaults to `127.0.0.1:4317`. On a phone that is **the device's own
loopback**, not the workstation, so without help the export posts into the void
and fails silently forever — the worst way for telemetry to break, because you
get an empty Jaeger and no error.

The fix reuses the tunnel the vite dev ports already relied on:

```sh
npm run adb:reverse    # tcp:5176, tcp:5177, tcp:4317, tcp:4318
```

`android:dev` and `dev:ext:android` both run it for you. With the tunnel up,
loopback means the workstation and the default endpoint is right everywhere.

Note that the dev server no longer necessarily rides this tunnel: `HERMES_DEV_HOST`
(see the README's "Android dev loop") can move 5176/5177 onto Wi-Fi to find the
faster link. 4317/4318 are unaffected — keep `adb:reverse` running for tracing
regardless of which transport the frontend is using.

| Situation | Endpoint |
| --- | --- |
| Desktop | default |
| Device on adb | default (via `adb:reverse`) |
| Emulator without the tunnel | `HERMES_TRACE_ENDPOINT=http://10.0.2.2:4317` |
| Device off adb | workstation LAN IP |
| iOS simulator | default (shares the Mac's network) |
| iOS device | workstation LAN IP |

The exporter is deliberately **not** gated off mobile by target. Mobile is where
the interesting jank lives, and the cleartext-egress concern such a gate would
address is already answered by the feature being off by default: a release APK
compiles no exporter at all.

## Environment variables

| Variable | Half | Default | Purpose |
| --- | --- | --- | --- |
| `HERMES_TRACE` | Rust | off | Runtime on/off. Any value except `0`/empty. |
| `HERMES_TRACE_RUN` | **both** | git branch | The `hermes.run` label. |
| `HERMES_TRACE_ENDPOINT` | Rust | `http://127.0.0.1:4317` | OTLP/gRPC collector. |
| `HERMES_TRACE_FILTER` | Rust | `info,hermes_universal_lib=debug,tauri=debug` | `EnvFilter` syntax. Tauri's per-command spans are DEBUG under `ipc::request::*` — turn them down here if they drown the trace. |
| `VITE_TRACE_RUN` | frontend | — | Frontend-only label override. |
| `VITE_OTLP_ENDPOINT` | frontend | `http://127.0.0.1:4318/v1/traces` | OTLP/HTTP collector. |

## Infrastructure

The stack lives at `~/Documents/dev-instances/jaeger`, following the house
convention (127.0.0.1-only, restart policy `no`, copied from `_template/`).

- **8200** — Jaeger UI
- **4317** — OTLP/gRPC (the Rust backend)
- **4318** — OTLP/HTTP (the webview)

4317/4318 sit deliberately outside the 82xx lane because every OTel SDK defaults
to them, so a host-side app needs zero configuration.

**Gotcha:** the collector must allow CORS or the webview's POSTs die at the
preflight with a `405` and nothing useful in the console. That lives in
`otel-collector.yaml`. After editing it use `docker compose restart
otel-collector` — `up -d` will not pick up the change.

## Capture recipes — the two layout reproductions

Both start from the quick-start loop, with a run label so the pair stays
separable in Jaeger (`__hermesTrace.run('…')`, or the run field on the HUD).

**`layout-baseline-open`** — open four chats into one stack, then switch between
them a few times. Read: `chat.open` duration, `layout.tiles.sync`'s `registered`
(one registration per tile means one adoption pass and one `localStorage` write
per tile), `layout.adopt`, and `layout.persist`'s `bytes` and frequency.

**`layout-baseline-sash`** — drag the main↔sidebar seam for about ten seconds,
then a flex↔flex seam. Read: `react.commit` count and total for the drag,
`layout.tracks` counters per frame, and `frame` spans over budget.

Then read `layout.forced` and let it pick what to fix:

| what dominates | what it means |
| --- | --- |
| `layoutMs`, with high `react.commit` counts and large `paneVisits` | the layout-engine hypothesis holds — narrow the subscriptions and stop the per-frame store writes |
| `styleMs`, with `layoutMs ≈ 0` | the tracks pass is a red herring; the cost is selector matching. Suspects: the `group-hover` transition on `Sash`, and the two global `<style>` blocks in `tree/renderer/index.tsx` whose `[data-tree-group] :is(…)` and `[class*="…"]` selectors re-match broadly |
| `paintEstimateMs` | neither; the cost is compositing. Look at the kept-alive layer count — they are hidden with `visibility`, so they stay in style and layout |

The instrument is built to be able to return the second and third answers. An
instrument that could only confirm the first would eventually "confirm" it
whether or not it was true, because it would be the only thing measured.

## Current status — what does *not* work yet

Honest state as of this writing, so nobody hunts for a feature that is not there.

- **Command spans stitch; the surrounding IPC plumbing does not.** A vite alias
  on `@tauri-apps/api/core` puts a `traceparent` in `InvokeOptions.headers`, and
  `telemetry::traced_invoke_handler` enters a span with that remote parent before
  dispatch — so `ipc::request::handler` and `ipc::request::run`, which Tauri
  creates inside the generated command wrapper, land in the frontend's trace.
  Their ancestors do not: `wry::custom_protocol::handle`, `ipc::request` and
  `ipc::request::handle` are created in Tauri's protocol layer, before any code
  of ours runs, and still form their own small traces. Nothing in them is
  interesting, but they will show up in a service search.
- **The reverse direction is not propagated.** Rust → webview events (`app::emit`)
  carry no context, so an emit and the webview work it triggers are separate
  traces. Closing that needs the context inside event payloads, which changes the
  event schema.
- **Not yet spanned:** the window main-thread hop, the ten SSH connect phases,
  and the voice session/turn.
- **`activeMs` and `styleMs` are unverified on WebKitGTK.** Both checks are
  written up under "Two things to verify by hand" above; neither has been run
  against the real engine yet. `layout.forced`'s total (`styleMs + layoutMs`) is
  sound either way — it is the *split* between the two, and the post-paint
  boundary, that are on trust.
- **`layoutMs` is a lower bound** until the `pre-frame` probe says otherwise.
  `pane-shell/geometry.ts` writes `--workspace-left/right` on `:root` from a
  post-layout ResizeObserver callback, which re-dirties style for every reader —
  a second style+layout pass in the same frame that the commit-time probe cannot
  see. That is what the `reason: 'pre-frame'` probe exists to catch.

## Hard-won gotchas

Each of these cost real time. Read them before trusting a number.

- **WebKitGTK clamps the clock to 1 ms.** Every individual measurement is an
  integer, so sub-millisecond spans are noise and only aggregates survive.
  `clockResolutionMs` is exposed for this reason. Do not read meaning into a 1 ms
  span.
- **Timing a drag callback measures nothing.** The handler only writes a store
  atom; React renders later. Frame-gap probing is what actually captures the
  cost — and it needs a further split between "main thread blocked" and
  "compositor starved", which are different problems with different fixes.
- **Scope your DOM counts.** A node count scoped to the transcript container
  reported "7 nodes" and misled the investigation for several rounds.
  Whole-document counts exist alongside for that reason.
- **Buffer indices are not identity.** Two bugs came out of treating them as if
  they were, and they are worth reading together because the second hid behind
  the first. Trace ids derived from the span buffer index repeated, because
  `clearSpans()` resets that index every 2 s, so unrelated interactions merged.
  Parent pointers had the same flaw and it was worse: a drain could not preserve
  them at all, so the exporter had to wait for an idle stack and then wipe
  everything — which made a trace longer than one stack unwind structurally
  impossible. An SSH connect (45–90 s, roughly 45 drains) is exactly that case.
  Both are now monotonic serials that no drain resets, and `trace-identity.test.ts`
  is the regression net.
- **The instrument must not appear in its own measurements.** The HUD started as
  a React component inside the app shell polling at 4Hz. Three ways that is
  wrong, all of them invisible in the output: its renders joined the app's React
  commits, so its cost landed in the frames under investigation; every parent
  re-render re-rendered it, constantly, during exactly the streaming it is used
  to debug; and a `position: fixed` element with no `contain` invalidates style
  and layout past its own box on every text change. It is now raw DOM outside
  React, writing only values that changed. Anything added to it must keep that
  property — no app stores, no React, no unconditional per-tick writes.
- **A synchronous stack cannot describe an `await`.** `http.request` held a
  stack-pushed span across its round trip, so every unrelated span opened while
  it was in flight became its child, and closing it truncated the stack out from
  under spans that were legitimately open. Async work uses `spanAsync`, which
  captures the parent at call time and stays off the stack. If you add a span
  around anything that awaits, use it.
- **Rust needed a tokio runtime, twice.** Building the exporter outside one
  panics at startup inside hyper-util with "no reactor running", an error
  pointing nowhere near telemetry. Worse, *shutdown* failed silently: it returned
  `Ok`, logged success, and dropped the batch. Both are now wrapped in
  `tauri::async_runtime::block_on`. Only the live smoke test caught the second
  one, which is why the `#[ignore]`d `export_reaches_collector` stays in the
  tree — it is the only thing that distinguishes "constructed without error" from
  "actually reached a collector".

## Deliberately not traced

Per-frame and per-token paths get counters at most, never spans. Instrumenting
them would change the thing being measured.

- The cpal audio input callback (~100 Hz, **realtime thread** — never)
- The voice capture actor loop (~100 Hz)
- The WebSocket reader's per-frame emit — every streamed token
- `pty_write` (per keystroke), `pty_resize` (per drag frame)
- `set_window_translucency` — microseconds, but on the UI thread at 60 Hz during
  a slider drag

## Related

- **MJXHRM-176** — the observability layer itself (PR #68 frontend, plus the Rust
  backend work)
- **MJXHRM-139** — chat rendering performance, the investigation that motivated
  all of this
- **MJXHRM-62** — the layout-tree rework; the actual fix for the resize symptom,
  and a blocker on 139
