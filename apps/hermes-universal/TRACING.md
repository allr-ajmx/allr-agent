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

3. In the webview console:

   ```js
   __hermesTrace.on()          // start recording, persisted across reloads
   // ...reproduce the slow thing...
   __hermesTrace.timeline()    // console waterfall, gaps marked
   ```

   Spans auto-drain to the collector every 2 s, so they are in Jaeger already.

To include the Rust backend, add the cargo feature and the env switch:

```sh
HERMES_TRACE=1 npm run tauri dev -- --features tracing
```

## Two halves, four switches

Tracing is deliberately *additive*: nothing runs unless asked for, and a release
build contains as little of it as possible.

| Half | Compiled? | Running? |
| --- | --- | --- |
| **Frontend** | Always. The core (`span.ts`, `otlp.ts`) ships, because a user's bug report is worth an OTLP dump. The exporter, store autocapture and console API are dev/bench only. | `__hermesTrace.on()` — persisted in localStorage, survives reloads. |
| **Rust backend** | `--features tracing`. A default build links **no** OTel crates at all; `cargo tree` shows zero. | `HERMES_TRACE=1`. Compiled-but-unasked-for costs nothing, and enabling never needs a rebuild. |

Splitting compile-time from runtime is the point: build once with
`--features tracing` and you can trace any later session with an env var, while
a release binary can never be talked into exporting anything.

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
| Interactions | Every click/keypress via `PerformanceObserver('event')`, decomposed into input delay / processing / presentation | `auto/events.ts` |
| Store writes | Every nanostores write, named. A vite alias points `nanostores` at a wrapper so all ~34 direct importers are covered without edits; a build transform recovers the variable name so spans read `$paneStates` rather than `atom#7`. | `auto/stores.ts` |
| HTTP | Every request through the Rust transport | `auto/http.ts` |
| WebSocket | Frame-level, outbound | `auto/websocket.ts` |
| Markdown / Shiki / KaTeX / stream flush | The chat rendering pipeline, stage by stage | hand-placed, semantic |
| All ~50 Tauri commands | Correct timing, including the 41 async ones | `tauri/tracing` feature |

### Why command timing is Tauri's job, not ours

Worth recording so nobody rebuilds it. The obvious approach — wrapping
`generate_handler!` via `Builder::invoke_handler` — **does not work**.
`InvokeResolver::respond_async` spawns the future and returns immediately, so a
wrapper measures *dispatch*, in microseconds, for every async command. Tauri's
own `tracing` feature calls `.instrument()` on the spawned future, which is
exactly the thing a hand-rolled wrapper cannot do. So it is one line in
`Cargo.toml` rather than code we maintain.

## Console API

```js
__hermesTrace.on()                 // start recording (persisted across reloads)
__hermesTrace.off()                // stop
__hermesTrace.run('before-fix')    // label this capture
__hermesTrace.timeline()           // console waterfall, gaps marked
__hermesTrace.flush()              // send to the collector now
__hermesTrace.autoflush(false)     // keep spans local so timeline() can see them
```

`autoflush(false)` is the one that catches people out: with auto-drain on (the
default, every 2 s) `timeline()` will often show nothing, because the spans are
already in Jaeger. The empty-state message says so.

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

## Current status — what does *not* work yet

Honest state as of this writing, so nobody hunts for a feature that is not there.

- **The two halves are separate traces.** Frontend and Rust spans land in the
  same Jaeger under the same `hermes.run`, but they are **not stitched into one
  waterfall**. You correlate them by label and timestamp today. This is exactly
  why the shared run label matters so much right now.
- **IPC context propagation is pending.** The design is settled: a vite alias on
  `@tauri-apps/api/core` puts a `traceparent` in `InvokeOptions.headers` — out of
  band, so no command signature changes — and a Rust `TraceCtx` extractor reads
  it back. Not yet built.
- **Not yet spanned:** the window main-thread hop, the ten SSH connect phases,
  and the voice session/turn.

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
- **Trace ids used to repeat.** They were derived from the span buffer index,
  which `clearSpans()` resets every 2 s — so unrelated interactions silently
  merged in Jaeger. Fixed with a counter that survives the drain;
  `trace-identity.test.ts` is the regression net. It matters because a long
  operation (SSH connect runs 45–90 s, roughly 45 drains) is exactly the case
  that broke.
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
