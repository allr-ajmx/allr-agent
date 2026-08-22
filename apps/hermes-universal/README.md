# Allr Universal

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
| `npm run dev:ext:*` | One dev server, several native shells attached to it (see below). |
| `npm run dev:prodweb` | Tauri dev shell against the **minified production** frontend (see below). |
| `npm run check` | typecheck → lint → test → build. What CI runs. |
| `npm run fix` | `eslint --fix` then Prettier. Run before pushing. |
| `npm run tauri build` | Full release bundle (deb + rpm + AppImage). |

### `dev:ext:*` — desktop and mobile side by side

Normally each `tauri dev` spawns its own Vite. The `ext` ("external Vite") split
inverts that: you start **one** dev server and attach as many native shells to it as
you like, so desktop and a phone can show the same frontend at once.

```
npm run dev:ext:vite       # the one dev server — leave it running
npm run dev:ext:desktop    # in another terminal
npm run dev:ext:android    # …and another (adb reverses 5176/5177 for you)
npm run dev:ext:ios
```

`src-tauri/tauri.external-vite.conf.json` is the whole trick: it blanks
`beforeDevCommand` so the shells point at the running server instead of starting one.

Two things keep the shells from disturbing each other:

- **`src-tauri/.taurignore`** — each shell runs its own Rust file watcher over
  `src-tauri/`. Without this, an Android build's Gradle and Cargo output made the
  desktop watcher rebuild continuously. Genuine source edits still rebuild both
  shells; only generated output is filtered.
- **A Cargo target tree per surface** — desktop keeps `src-tauri/target`, while
  `dev:ext:android` and `dev:ext:ios` set `CARGO_TARGET_DIR` to
  `src-tauri/target-android` / `target-ios`. Concurrent builds would otherwise
  serialize on Cargo's lock over the shared directory. The first Android or iOS run
  after a fresh checkout rebuilds from scratch into its own tree.

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

`ALLR_DEV_HOST` makes it one. It defaults to `127.0.0.1` — the **USB tunnel**, which `npm run adb:reverse`
already maps and which needs no network at all:

```sh
npm run dev:ext:vite            # terminal 1
npm run dev:ext:android         # terminal 2
```

To send the same traffic over **Wi-Fi** instead, set it to the machine's LAN address — on *both* commands,
since they are separate processes:

```sh
env ALLR_DEV_HOST=192.168.1.15 npm run dev:ext:vite
env ALLR_DEV_HOST=192.168.1.15 npm run dev:ext:android
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

### Android release build

`npm run android:build:release` builds a Play-uploadable AAB at
`src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`
(arm64 + armv7; drop `--target` in the script for x86 too). It is signed with the upload key named by
`src-tauri/gen/android/keystore.properties` (gitignored):

```
password=<store and key password>
keyAlias=upload
storeFile=/absolute/path/to/allr-upload.jks
```

Without that file the release variant is unsigned and Play Console rejects it. Every upload needs a higher
`versionCode`, which Tauri derives from the version in `tauri.conf.json` / `package.json` — bump the patch
before building. `jarsigner -verify <aab>` confirms the signature.

## Desktop release build

Desktop releases are cut by CI, not by hand: push a `desktop-v*` tag and
`.github/workflows/release-desktop.yml` builds, signs, notarizes and publishes
both apps (Allr and Allr Setup) for macOS, Linux and Windows.

```
python scripts/bump-desktop-version.py 0.1.1   # all 11 version sites, both apps
git commit -am 'chore(desktop): bump to 0.1.1'
git tag desktop-v0.1.1 && git push origin main desktop-v0.1.1
```

The bump must land **before** the tag: the workflow's first job runs
`bump-desktop-version.py --check` against the tag and fails in seconds rather
than after a 40-minute universal macOS build.

The tag prefix matters. `v0.1.1` is the Python CLI's CalVer channel
(`scripts/release.py`) and would fire `install-e2e.yml`; `desktop-v*` is
invisible to it.

### Building one locally

`npm run tauri build` produces, under `src-tauri/target/`:

| Platform | Installer | Updater artifact |
| --- | --- | --- |
| macOS | `universal-apple-darwin/release/bundle/dmg/Allr_0.1.1_universal.dmg` | `.../bundle/macos/Allr.app.tar.gz` + `.sig` |
| Linux | `release/bundle/appimage/Allr_0.1.1_amd64.AppImage`, plus `.deb` and `.rpm` | `.../Allr_0.1.1_amd64.AppImage.tar.gz` + `.sig` |
| Windows | `release/bundle/nsis/Allr_0.1.1_x64-setup.exe`, plus `.msi` | `.../Allr_0.1.1_x64-setup.nsis.zip` + `.sig` |

macOS is built **universal** (`--target universal-apple-darwin`, needs
`rustup target add x86_64-apple-darwin`). That is not just convenience:
`updates.rs` picks a release asset with
`name.contains(std::env::consts::ARCH)`, and Tauri names Intel bundles `_x64`,
which does not contain `x86_64` — a per-arch release would hand Intel users the
aarch64 build. One universal artifact makes that impossible.

arm64 Linux is not built; those users build from source with the prerequisites
at the top of this file.

### Signing credentials

Like `gen/android/keystore.properties`, these are **optional by presence** —
with none of them set the build still succeeds and simply produces unsigned
artifacts:

```
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/allr-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<password set at generation>'

export APPLE_SIGNING_IDENTITY='Developer ID Application: Jai Shukla (6M43WS4436)'
export APPLE_API_ISSUER='<App Store Connect issuer UUID>'
export APPLE_API_KEY='<10-char key id>'
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_<key id>.p8"
```

The first local signed build pops a **keychain prompt** ("codesign wants to use
key ... in your keychain") and blocks until you answer — choose *Always Allow*
so later builds run unattended. CI never hits this: `tauri-action` creates a
throwaway keychain from `KEYCHAIN_PASSWORD` and imports the `.p12` into it.

`Developer ID Application`, not `Apple Distribution`: this is direct
distribution, and a Mac App Store identity produces a bundle Gatekeeper rejects
on download. Notarization uses an App Store Connect **API key** rather than an
Apple ID + app-specific password, so it is team-scoped, individually revocable,
and survives a password rotation.

Windows is **unsigned** for now — there is no certificate. Users see a
SmartScreen warning on first run; `SHA256SUMS.txt` on each release is the
integrity signal until that changes. The workflow already carries the seam that
turns signing on.

### Verifying a signed build

```
codesign -dv --verbose=4 /Applications/Allr.app     # flags=0x10000(runtime), Developer ID
codesign -d --entitlements :- /Applications/Allr.app  # the audio-input entitlement
spctl -a -vvv -t install /Applications/Allr.app     # accepted, source=Notarized Developer ID
xcrun stapler validate Allr_0.1.1_universal.dmg     # proves stapling actually happened
lipo -archs /Applications/Allr.app/Contents/MacOS/Allr  # x86_64 arm64
```

These are the counterpart of `jarsigner -verify` for the Android AAB above.

**Counting keychain dialogs.** A signed build shows one Touch ID prompt — the
app's own credential gate — and no keychain password dialogs at all. An ad-hoc
build shows that Touch ID prompt plus exactly one keychain dialog per launch, for
the key that seals the credential vault; it never shows one per credential, which
is what it used to do. So:

```
ls -l ~/Library/Application\ Support/work.allr.app/secrets.vault  # -rw------- , the sealed secrets
security find-generic-password -s allr -a allr/vaultKey/password   # the one keychain item
security dump-keychain | grep 'allr/'                              # should be that one line
```

Credentials from an older build migrate into the vault on first read, so the
first launch after upgrading may still raise a dialog per surviving item — once.

A `vaultKey` item created by an ad-hoc build prompts once more under the first
signed build, because the ACL is being bound to a code identity for the first
time; "Always Allow" sticks from then on.

**Test voice capture on a notarized build, not a dev build.** Hardened runtime
is what `entitlements.plist` exists for, and a missing entitlement makes the
microphone return silence with no error, no prompt and no log line — only in the
signed artifact. Download the DMG through a browser so the quarantine bit is
set, then record something.

### The update channel

The app self-updates via `tauri-plugin-updater`. It reads `latest.json` from a
permanent, fixed-tag pointer release (`desktop-updater`) rather than
`/releases/latest` — because `/releases/latest` resolves to the newest Python
CalVer release, which carries no `latest.json`. Do not "simplify" the endpoint
in `tauri.conf.json`: the failure mode is silent, surfacing to users as
"You're on the latest version" forever.

Bundles are verified against the public key compiled into the binary
(`plugins.updater.pubkey`). **Losing `~/.tauri/allr-updater.key` or its password
is unrecoverable** — every installed copy is pinned to that key, so a new keypair
orphans the entire installed base and the only remedy is asking every user to
reinstall by hand. Back it up before the first release.

`.deb` and `.rpm` installs are not self-updating; those update through the
package manager or a fresh download.

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
