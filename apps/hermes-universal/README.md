# Hermes Universal

Tauri v2 client — desktop, Android and iOS from one codebase.

## Linux build prerequisites

The webview and the bundlers link against system libraries, so `cargo` alone is not enough. On Debian/Ubuntu:

```sh
sudo apt install \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

Two of those are easy to miss because **nothing fails until the very last bundling step**, long after the app
itself has compiled and the `.deb` and `.rpm` have been produced:

- **`librsvg2-dev`** — the AppImage bundler runs `linuxdeploy-plugin-gtk`, which reads `librsvg-2.0.pc` via
  `pkg-config` to find the SVG loader. The runtime `librsvg2-2` package does **not** ship that `.pc` file. Without
  the `-dev` package the plugin aborts with:

  ```
  there is no 'libdir' variable for 'librsvg-2.0' library.
  ERROR: Failed to run plugin: gtk (exit code: 1)
  failed to bundle project: `failed to run linuxdeploy`
  ```

  which reads like a broken toolchain rather than a missing package.

- **`patchelf`** — linuxdeploy uses it to rewrite `RPATH` on every bundled `.so`.

If you only need to run or package for local use, `npm run tauri build --bundles deb` skips AppImage entirely.

## Scripts

| command | what it does |
| --- | --- |
| `npm run dev` | Vite dev server (port 5176). Pair with `npm run tauri dev`. |
| `npm run dev:prodweb` | Tauri dev shell against the **minified production** frontend (see below). |
| `npm run check` | typecheck → lint → test → build. What CI runs. |
| `npm run fix` | `eslint --fix` then Prettier. Run before pushing. |
| `npm run tauri build` | Full release bundle (deb + rpm + AppImage). |

### `dev:prodweb`

Runs the Rust side in dev (fast rebuilds, devtools) while the webview loads the production bundle from
`vite preview` on port 5179 instead of the dev server. That isolates how much of a performance problem is React
dev-mode overhead — double-render, dev warnings, HMR runtime — versus the real thing, a distinction `tauri dev`
alone cannot make and `tauri build` makes too slowly to iterate on.

It builds with `--mode benchmark` so `.env.benchmark` sets `VITE_ENABLE_BENCH=true`, keeping the
`/dev/markdown-bench` route in the bundle. `npm run build` (mode `production`) never includes it.

### The Android dev loop

A phone is not the simulator. An iOS simulator run reaches the dev server over real loopback, so its module
requests are free; an Android device reaches it either through an `adb reverse` tunnel over USB or over Wi-Fi,
and Vite serves ~1000 separate modules in dev. Whichever link is slower is what you feel on every reload, so
the transport is a choice worth making on purpose.

`HERMES_DEV_HOST` makes it one. It defaults to `127.0.0.1` — the **USB tunnel**, which `npm run adb:reverse`
already maps and which needs no network at all:

```sh
npm run dev:ext:vite            # terminal 1
npm run dev:ext:android         # terminal 2
```

To send the same traffic over **Wi-Fi** instead, set it to the machine's LAN address — on *both* commands,
since they are separate processes:

```sh
env HERMES_DEV_HOST=192.168.1.15 npm run dev:ext:vite
env HERMES_DEV_HOST=192.168.1.15 npm run dev:ext:android
```

Try both once and keep the faster one; which wins depends on the USB controller and the access point, not on
anything in this repo. Keep `adb:reverse` running either way — tracing still leaves the device on 4317/4318
(see [TRACING.md](./TRACING.md)).

Setting this explicitly also removes a footgun: the Tauri CLI rewrites a `localhost` dev URL to a real address
whenever the attached Android device is physical, and if it has to pick that address itself it prompts with
every interface on the machine — including docker bridges and VPN adapters that the phone cannot reach, or can
reach only via a slow detour.

**When the loop still feels slow, read the log before changing anything:**

```sh
adb logcat -c && adb logcat | grep -iE '\[vite\]'
```

- `[vite] connecting to ws://…` names the transport actually in use. If that host is not the one you set,
  nothing below matters until it is.
- `[vite] connected.` must appear. Without it HMR is dead and every edit is a full page reload.
- `[vite] hot updated: /src/…` is the good case.
- `[vite] page reload src/…` means Fast Refresh bailed out. Unavoidable when editing `src/store/*.ts` (no
  component boundary to patch); on a plain `.tsx` it usually means that file exports something other than
  components, and moving that export out restores hot updates.
- `[vite] optimized dependencies changed. reloading` means a dependency escaped the cold-start scan. Add it to
  `optimizeDeps.include` in `vite.config.ts` — that list exists precisely to keep this line from appearing.

## Performance harness

Markdown/KaTeX rendering is the app's heaviest path. Three tools, deliberately measuring different layers:

- `node bench/pipeline-bench.mjs` — markdown → hast stage timings and **node counts**, with a regression ceiling.
  Node count is the headline number: every hast node becomes a React element *and* a DOM node, and every later
  style recalc walks all of them.
- `bench/index.html` — standalone, no framework. Open it in the **same engine Tauri embeds**, not Chrome:
  `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser apps/hermes-universal/bench/index.html`. Chromium numbers
  do not predict WebKitGTK. Variants A/B/C separate engine cost from React cost.
- `/dev/markdown-bench` — the real component tree over a LaTeX-heavy fixture, with commit time, node count and
  worst-frame during a sidebar toggle or width sweep.
