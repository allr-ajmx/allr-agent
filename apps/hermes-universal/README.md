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

On Arch/Manjaro the same set is named differently:

```sh
sudo pacman -S --needed \
  webkit2gtk-4.1 base-devel curl wget file \
  xdotool openssl libayatana-appindicator \
  librsvg patchelf
```

The appindicator package is the one to get right:

- **`libayatana-appindicator`** — Tauri's `tray-icon` feature `dlopen`s
  `libayatana-appindicator3.so.1` at *runtime*, so everything compiles and links and then
  `tauri dev` panics the moment it launches:

  ```
  thread 'main' panicked at libappindicator-sys-0.9.0/src/lib.rs:41:5:
  Failed to load ayatana-appindicator3 or appindicator3 dynamic library
  ```

  Arch ships no separate `-dev` package, and `libappindicator` is the wrong one — that is the
  older Unity-era library and does not provide the `.so.1` the loader asks for.

Two of those only ever mattered to the AppImage, which **is no longer built** (see "No AppImage, and why"
below). They are documented because they are still in the CI package list, and because the failure they cause
is unrecognisable: nothing goes wrong until the very last bundling step, long after the app itself has compiled
and the `.deb` and `.rpm` have been produced.

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

If you only need to run or package for local use, `npm run tauri build --bundles deb` is the quickest path.

### Running under Wayland

Two things look like failures and are not.

**The clipboard warning is expected.** Every Wayland session logs this at startup:

```
[WARN arboard::platform::linux] Tried to initialize the wayland data control protocol clipboard,
but failed. Falling back to the X11 clipboard protocol.
```

`ext-data-control` and `wlr-data-control` are wlroots-family protocols; GNOME's Mutter and KDE's
KWin implement neither. arboard falls back to X11 through XWayland and the clipboard works. Don't
chase this one.

**The tray needs a StatusNotifier host.** Wayland has no XEmbed tray, so `libayatana-appindicator`
gets the icon *published* but something still has to *display* it:

| session | what to enable |
| --- | --- |
| GNOME | `gnome-shell-extension-appindicator`, switched on in Extensions |
| KDE Plasma | built in, nothing to do |
| sway / wlroots | waybar with the `tray` module, or another SNI host |

With no host, `tray::install` returns `false`, the tray is skipped, and **the background-mode
switch in Settings stays disabled**. That is deliberate — see the comment above the `tray::install`
call in `src-tauri/src/lib.rs`: background mode hides the window, so with no icon to bring it back
you would be left with a live process and no way to reach it. The app itself runs fine; it just
cannot run hidden.

## Scripts

| command | what it does |
| --- | --- |
| `npm run dev` | Vite dev server (port 5176). Pair with `npm run tauri dev`. |
| `npm run dev:ext:*` | One dev server, several native shells attached to it (see below). |
| `npm run dev:prodweb` | Tauri dev shell against the **minified production** frontend (see below). |
| `npm run check` | typecheck → lint → test → build. What CI runs. |
| `npm run fix` | `eslint --fix` then Prettier. Run before pushing. |
| `npm run tauri build` | Full release bundle (deb + rpm; no AppImage — see below). |

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

### The JDK Gradle runs on

The Android project's Gradle wrapper is pinned to **8.14.3** by Tauri's template
(`src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties`), and Gradle 8.14 runs on **Java 17 through
21**. Use JDK 21:

```sh
sudo pacman -S --needed jdk21-openjdk   # Arch/Manjaro
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
```

Leave the *system* default alone — `archlinux-java set` is not needed and JDK 26 is fine for everything else.
Only `JAVA_HOME` for this build has to move.

The footgun is pointing `JAVA_HOME` at Android Studio's bundled runtime, `/opt/android-studio/jbr`. That used
to be JDK 21 and is now JDK 25, so an IDE update silently breaks the command line with an error that names no
JDK at all and reads like a repo bug:

```
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_'
Unsupported class file major version 69
```

It fails while parsing `build.gradle.kts` itself, before a line of app code is compiled. The number is the only
clue, and it is a class-file version, not a Java one — **69 is Java 25, 70 is Java 26**. Subtract 44.

Raising the wrapper instead is a dead end for now: `build.gradle.kts` pins AGP 8.11.0 and the Kotlin Gradle
plugin 1.9.25, neither of which supports Gradle 9, and both lines are written by Tauri's template, so
`npm run android:init` would undo the change. Android Studio itself keeps working either way — the IDE builds
with its own "Gradle JDK" setting and ignores `JAVA_HOME`.

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
Allr for macOS, Linux and Windows.

`apps/bootstrap-installer` ("Allr Setup") used to ship on the same tag and no
longer does. It drives `scripts/install.ps1` through PowerShell, so its Linux
and macOS bundles had no install script to run, and on Windows its NSIS output
sat one character away from the product app's own `Allr_<ver>_x64-setup.exe`.
It is still built and tested by CI — it is just not a release asset.

Every leg now **launches what it built** before the draft is published — see
the smoke-test steps in the workflow and `scripts/smoke-test-linux-bundle.sh`.
That is not belt-and-braces: `desktop-v0.0.7` shipped an AppImage that opened a
window and never painted a pixel, and a build-and-upload pipeline had no way to
notice.

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
| Linux | `release/bundle/deb/*.deb` and `release/bundle/rpm/*.rpm` | `.../Allr_0.1.1_amd64.deb.tar.gz` + `.sig` |
| Windows | `release/bundle/nsis/Allr_0.1.1_x64-setup.exe`, plus `.msi` | `.../Allr_0.1.1_x64-setup.nsis.zip` + `.sig` |

### No AppImage, and why

`bundle.targets` deliberately omits `appimage`. An AppImage carries its own copy
of WebKitGTK, taken from whichever runner built it, and ubuntu-22.04's WebKitGTK
cannot initialise EGL against a modern host graphics stack:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

That is what `desktop-v0.0.7` shipped — a window that mapped and never painted.
The *same* binary linked against the host's WebKitGTK renders fine, which is why
the `.deb` and `.rpm` were never affected. Nothing can be set at runtime to fix
it; the bundled library is simply the wrong vintage for the host.

The distro-agnostic download is a plain tarball instead —
`Allr_<ver>_linux_x86_64.tar.gz`, built by `scripts/package-linux-tarball.sh`
and uploaded by the release workflow. It ships our binary, an `install.sh` that
targets `~/.local` (or `--system`), icons and a generated `.desktop` entry, and
links the system's WebKitGTK exactly as the packages do.

`scripts/install-desktop-linux.sh` is the one-liner wrapper around it:

```sh
curl -fsSL https://raw.githubusercontent.com/allr-ajmx/allr-agent/main/scripts/install-desktop-linux.sh | bash
```

It resolves the version from the `desktop-updater` pointer — deliberately *not*
`/releases/latest`, which resolves to the Python CalVer release and has no
desktop assets — verifies the download against the release's `SHA256SUMS.txt`,
then delegates to the tarball's own `install.sh` so there is one definition of
where files land. `ALLR_RELEASE_BASE_URL` points it at a mirror or a local
server.

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
