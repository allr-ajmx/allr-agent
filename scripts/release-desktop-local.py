#!/usr/bin/env python3
"""Build and publish a desktop release from developer machines, not from CI.

Why this exists
---------------
`.github/workflows/release-desktop.yml` is still the intended path. This is the
fallback for when it cannot ship, and as of 2026-08-28 it cannot: `notarytool
submit --wait` does not return on GitHub's hosted macOS runners. Two runs
(33143417933, 33147522451) sat silent for ~54 minutes on a 16MB bundle and were
killed by the job timeout, while Apple's status feed reported no incident and an
earlier submission from the same key came back ACCEPTED. Notarization works; the
hosted runner cannot observe it finishing.

Notarization DOES complete on a developer Mac, so the fix is to move the build
to machines that work and keep every other guarantee the workflow provides.

The three-phase shape mirrors how the build actually happens: one machine per
platform, then one machine assembles and publishes.

    # on macOS, on Linux, on Windows -- each produces its own platform's assets
    python scripts/release-desktop-local.py build --out dist/

    # collect the three dist/ directories onto one machine, then
    python scripts/release-desktop-local.py assemble --dist dist/
    python scripts/release-desktop-local.py publish  --dist dist/

`build` refuses to produce an artifact it cannot vouch for. That is the whole
point: the reason this release is being cut by hand is that a green CI run
turned out not to mean what everyone assumed, so a hand-cut release that skips
the assertions would be strictly worse than the thing it replaces.

Credentials
-----------
Pass them in a file rather than exporting them, because the same release is
built on three machines running three different shells and the credential block
is the step people get wrong:

    python scripts/release-desktop-local.py build --env-file ~/.allr-release.env

`--check-only` runs every credential assertion and stops, so a bad value costs
seconds rather than a completed build nobody can install.

What every platform needs
-------------------------
    TAURI_SIGNING_PRIVATE_KEY           updater signing key (the minisign secret)
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password

Without these the bundler emits no `.sig` files, `assemble` cannot build a
`latest.json`, and existing installs never learn the release happened.

What macOS additionally needs
-----------------------------
    APPLE_SIGNING_IDENTITY   'Developer ID Application: NAME (TEAMID)'
    APPLE_API_KEY            10-character App Store Connect key id
    APPLE_API_ISSUER         issuer UUID
    APPLE_API_KEY_PATH       path to AuthKey_<key id>.p8

Signing and notarization are different fixes for different complaints -- see
scripts/verify-macos-signing.sh. Signing stops the keychain prompts; notarization
stops Gatekeeper refusing a DOWNLOADED build. A release needs both, so unlike
scripts/build-signed-macos.sh (a debugging tool, which tolerates skipping
notarization) this refuses to build a macOS release without all four.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "apps" / "hermes-universal"
TAURI_CONF = APP_DIR / "src-tauri" / "tauri.conf.json"

REPO_SLUG = "allr-ajmx/allr-agent"

# The permanent pointer release the updater polls. Its only asset is
# latest.json. Named here rather than derived, because tauri.conf.json's
# updater endpoint hardcodes this tag and the two must not drift.
UPDATER_TAG = "desktop-updater"

TARGETS = {
    "Darwin": "universal-apple-darwin",
    "Linux": "x86_64-unknown-linux-gnu",
    "Windows": "x86_64-pc-windows-msvc",
}


def die(msg):
    print(f"\nerror: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd, **kw):
    """Run a command, echoing it first so a failed release is reconstructible."""
    printable = " ".join(str(c) for c in cmd)
    print(f"  $ {printable}", flush=True)
    return subprocess.run(cmd, check=True, **kw)


def capture(cmd, **kw):
    return subprocess.run(
        cmd, check=True, capture_output=True, text=True, **kw
    ).stdout.strip()


def version():
    return json.loads(TAURI_CONF.read_text())["version"]


def tag_for(v):
    return f"desktop-v{v}"


def load_env_file(path):
    """Populate os.environ from a KEY=VALUE file.

    This exists because the same release is built on three machines running
    three different shells, and the credential block is the step people get
    wrong. `export FOO=bar` is bash; fish needs `set -x FOO bar` and splits
    command substitutions on newlines; PowerShell needs `$env:FOO = 'bar'`.
    One file that all three read identically removes that whole class of
    mistake -- and a mistake here does not fail cleanly, it produces an
    unsigned or un-notarized artifact that looks like a success.

    Values are taken literally: no shell expansion, no interpolation. A value
    may be wrapped in matching quotes, which are stripped, so a signing
    identity with spaces needs no escaping.

    `NAME_FILE=<path>` sets NAME to that file's contents instead, so the
    updater private key can stay in one place with one set of permissions
    rather than being copied into this file as a second plaintext original.
    """
    path = Path(path).expanduser()
    if not path.is_file():
        die(f"no env file at {path}")

    mode = path.stat().st_mode & 0o077
    if mode:
        print(
            f"warning: {path} is readable by others (mode "
            f"{oct(path.stat().st_mode & 0o777)}). It holds signing "
            f"credentials; chmod 600 it.",
            file=sys.stderr,
        )

    loaded = []
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # Tolerate a leading `export ` so a bash-style file works unchanged.
        line = re.sub(r"^export\s+", "", line)
        if "=" not in line:
            die(f"{path}:{n}: not a KEY=VALUE line: {raw!r}")
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]

        if key.endswith("_FILE"):
            key = key[: -len("_FILE")]
            src = Path(value).expanduser()
            if not src.is_file():
                die(f"{path}:{n}: {key}_FILE points at nothing: {src}")
            # rstrip only: a trailing newline from the generator is noise, but
            # the key body's own structure has to survive untouched.
            value = src.read_text().rstrip("\n")

        os.environ[key] = value
        loaded.append(key)

    print(f"==> loaded {len(loaded)} variables from {path}")
    return loaded


def require_env(*names):
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        die(
            "these environment variables are required and unset:\n       "
            + "\n       ".join(missing)
            + "\n\nSee the module docstring for what each one is."
        )


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def check_version_sites():
    """The version lives in ten files and a stale one does not fail loudly.

    release-desktop.yml runs this as a 30-second gate before a 40-minute build
    for exactly that reason; a hand-cut release needs it more, not less, because
    there is no draft-release job to catch a mismatch downstream.
    """
    script = REPO_ROOT / "scripts" / "bump-desktop-version.py"
    print("==> checking every version site agrees")
    try:
        run([sys.executable, str(script), version(), "--check"])
    except subprocess.CalledProcessError:
        die(
            f"version sites disagree. Run:\n"
            f"       python scripts/bump-desktop-version.py {version()}"
        )


def bundle_dir(target):
    return APP_DIR / "src-tauri" / "target" / target / "release" / "bundle"


def check_macos_credentials():
    require_env(
        "APPLE_SIGNING_IDENTITY",
        "APPLE_API_KEY",
        "APPLE_API_ISSUER",
        "APPLE_API_KEY_PATH",
    )
    key_path = Path(os.environ["APPLE_API_KEY_PATH"]).expanduser()
    if not key_path.is_file():
        die(f"APPLE_API_KEY_PATH does not exist: {key_path}")
    os.environ["APPLE_API_KEY_PATH"] = str(key_path)

    identity = os.environ["APPLE_SIGNING_IDENTITY"]
    identities = capture(["security", "find-identity", "-v", "-p", "codesigning"])
    if identity not in identities:
        die(
            f"no codesigning identity on this machine matches:\n       {identity}\n\n"
            "Run 'security find-identity -v -p codesigning' and copy a name "
            "verbatim.\nPick the 'Developer ID Application: ...' line -- NOT "
            "'Apple Distribution',\nwhich is a Mac App Store identity and "
            "produces a bundle Gatekeeper rejects."
        )

    # Not just non-empty: a key id is exactly 10 characters and an issuer is a
    # UUID. Getting these two swapped is easy and the bundler's only complaint
    # is the `skipping app notarization` warning it prints on its way to a
    # successful, un-notarized build.
    if len(os.environ["APPLE_API_KEY"]) != 10:
        die(
            "APPLE_API_KEY should be the 10-character key id, got "
            f"{len(os.environ['APPLE_API_KEY'])} characters. Did it get the "
            "issuer UUID instead?"
        )
    if not re.fullmatch(
        r"[0-9a-fA-F-]{36}", os.environ["APPLE_API_ISSUER"]
    ):
        die("APPLE_API_ISSUER should be a UUID. Did it get the key id instead?")

    print(f"    identity: {identity}")
    print(f"    api key:  {os.environ['APPLE_API_KEY']} at {key_path}")


def notarize_and_staple(path, what):
    """Notarize a file and attach the ticket to it.

    This exists because the Tauri bundler notarizes the .app and STOPS. It then
    builds the DMG from the stapled app and signs it -- but never submits it.
    The DMG is the artifact users download and therefore the one macOS puts
    com.apple.quarantine on, so an unnotarized DMG is refused by Gatekeeper no
    matter how thoroughly the app inside it was notarized. Verified on
    2026-08-28 against a real build: the .app came back `accepted /
    source=Notarized Developer ID` while its own DMG came back `rejected /
    source=Unnotarized Developer ID`.

    Stapling matters as much as notarizing. Without a stapled ticket Gatekeeper
    has to ask Apple at open time, so the download works on a connected machine
    and fails on a plane.
    """
    api = [
        "--key", os.environ["APPLE_API_KEY_PATH"],
        "--key-id", os.environ["APPLE_API_KEY"],
        "--issuer", os.environ["APPLE_API_ISSUER"],
    ]

    print(f"\n==> notarizing the {what}")
    print("    Apple's queue sets the pace here: 30 seconds when it is clear,")
    print("    and hours when it is not. 2026-08-28 saw both.")
    r = subprocess.run(
        ["xcrun", "notarytool", "submit", str(path), "--wait", "--timeout", "30m"] + api,
        capture_output=True, text=True,
    )
    print("\n".join("    " + l for l in r.stdout.splitlines()[-6:]))

    if r.returncode != 0:
        # `notarytool --wait` gives up the whole operation on ONE transient
        # network error -- a single NSURLErrorTimedOut discarded a complete
        # 30-minute build on 2026-08-28, even though Apple went on to ACCEPT
        # that very submission. The submission id is the recovery: it outlives
        # the client, so poll it ourselves rather than resubmitting, which would
        # only add another job to the queue that starved us.
        ids = re.findall(r"id: ([0-9a-f-]{36})", r.stdout or "")
        if not ids:
            print(r.stderr[-800:], file=sys.stderr)
            die(f"could not submit the {what} for notarization")
        sub_id = ids[0]
        print(f"\n    the wait failed, but submission {sub_id} is live - polling it")
        if not wait_for_submission(sub_id, api):
            die(
                f"the {what} was not accepted. Check it with:\n"
                f"       xcrun notarytool log {sub_id} --key ... --key-id ... --issuer ..."
            )

    run(["xcrun", "stapler", "staple", str(path)])


def wait_for_submission(sub_id, api, minutes=45):
    """Poll one submission to a terminal state, tolerating transient errors.

    Deliberately more patient than `notarytool --wait`: a failed poll is retried
    rather than being treated as a failed notarization.
    """
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        try:
            r = subprocess.run(
                ["xcrun", "notarytool", "info", sub_id] + api,
                capture_output=True, text=True, timeout=120,
            )
            status = next(
                (l.split(":", 1)[1].strip() for l in r.stdout.splitlines()
                 if l.strip().startswith("status:")),
                None,
            )
        except subprocess.TimeoutExpired:
            status = None

        if status and status != "In Progress":
            print(f"    submission {sub_id}: {status}")
            return status == "Accepted"

        # `None` means the poll itself failed, which is exactly the condition
        # that must NOT end the wait. Say so, and try again.
        print(f"    {status or 'poll failed, retrying'} ...", flush=True)
        time.sleep(30)

    die(f"submission {sub_id} did not resolve within {minutes} minutes")


def build_macos(out, notarize=True):
    check_macos_credentials()

    target = TARGETS["Darwin"]
    print(f"==> building {target} (signed, notarized)")
    print("    Notarization adds several minutes; the bundler prints nothing")
    print("    while it waits. That silence is normal HERE -- it is the same")
    print("    silence that never ends on a hosted runner.")
    tauri_build(target)

    app = find_one(bundle_dir(target) / "macos", "*.app", "macOS .app")

    # The shared verifier, the same one release-desktop.yml calls. Under
    # --expect-notarized it also runs `stapler validate`, which is the check
    # that separates a genuinely notarized bundle from one that merely passed
    # spctl by an online ticket lookup -- the latter fails on a user's machine
    # when they are offline.
    print("\n==> verifying the signature")
    verify = REPO_ROOT / "scripts" / "verify-macos-signing.sh"
    args = [str(verify), "--require-signed"]
    if notarize:
        args.append("--expect-notarized")
    args.append(str(app))
    try:
        run(args)
    except subprocess.CalledProcessError:
        die("the macOS bundle failed verification; it will NOT be released")

    if notarize:
        dmg = find_one(bundle_dir(target) / "dmg", "*.dmg", "macOS .dmg")
        notarize_and_staple(dmg, "DMG")
        print("\n==> re-verifying the DMG as a download")
        # -t open, not -t exec: a disk image is not executable code, and
        # `-t exec` reports a confusing pass on something Gatekeeper would
        # still refuse when opened.
        run(["spctl", "-a", "-vvv", "-t", "open",
             "--context", "context:primary-signature", str(dmg)])

    collect(out, bundle_dir(target) / "dmg", "*.dmg")

    # The updater tarball is the one bundler output that does NOT carry the
    # version. Tauri writes a bare `Allr.app.tar.gz`; it is tauri-action, not
    # the bundler, that renames it on upload -- which is why v0.0.7's assets
    # and its latest.json both show `Allr_0.0.7_universal.app.tar.gz` while the
    # build log shows `Allr.app.tar.gz`. A hand-cut release has to do that
    # rename itself, or `assemble` matches nothing and every macOS install
    # stalls on "you're on the latest version" forever.
    stem = f"Allr_{version()}_universal.app.tar.gz"
    src_dir = bundle_dir(target) / "macos"
    for src, dst in (
        (src_dir / "Allr.app.tar.gz", out / stem),
        (src_dir / "Allr.app.tar.gz.sig", out / f"{stem}.sig"),
    ):
        if not src.is_file():
            die(
                f"the build produced no {src.name}. If the .sig is the missing "
                "one,\n       TAURI_SIGNING_PRIVATE_KEY was not in scope for "
                "the bundler."
            )
        shutil.copy2(src, dst)
        print(f"    {src.name} -> {dst.name}")


def build_linux(out):
    target = TARGETS["Linux"]
    print(f"==> building {target}")
    tauri_build(target)

    collect(out, bundle_dir(target) / "deb", "*.deb*")
    collect(out, bundle_dir(target) / "rpm", "*.rpm*")

    # The distro-agnostic download. Not a bundler output, so it is built here
    # exactly as release-desktop.yml builds it. It replaced the AppImage, which
    # carried its own WebKitGTK and could not initialise EGL against a modern
    # host -- v0.0.7's AppImage opened a window and never painted a pixel.
    print("\n==> packaging the distro-agnostic tarball")
    binary = APP_DIR / "src-tauri" / "target" / target / "release" / "hermes-universal"
    if not binary.is_file():
        die(f"no binary at {binary}")
    staged = capture(
        [
            str(REPO_ROOT / "scripts" / "package-linux-tarball.sh"),
            str(binary),
            version(),
            str(out / "_tarball"),
        ]
    )
    shutil.move(staged, out / Path(staged).name)
    shutil.rmtree(out / "_tarball", ignore_errors=True)
    print(f"    {Path(staged).name}")


def build_windows(out):
    target = TARGETS["Windows"]
    print(f"==> building {target}")
    print("    Windows is UNSIGNED: there is no certificate yet, so SmartScreen")
    print("    will warn on first run. Documented in the install docs; the")
    print("    published SHA256SUMS.txt is the integrity signal until then.")
    tauri_build(target)

    collect(out, bundle_dir(target) / "nsis", "*setup.exe*")
    collect(out, bundle_dir(target) / "msi", "*.msi*")


def tauri_build(target):
    require_env("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
    npm = "npm.cmd" if platform.system() == "Windows" else "npm"
    run(
        [npm, "run", "tauri", "--", "build", "--target", target, "--verbose"],
        cwd=APP_DIR,
    )


def find_one(directory, pattern, what):
    hits = sorted(directory.glob(pattern)) if directory.is_dir() else []
    if not hits:
        die(f"the build produced no {what} under {directory}")
    return hits[0]


def collect(out, directory, pattern):
    """Copy bundler outputs into the staging directory, flat."""
    if not directory.is_dir():
        die(f"expected bundler output directory is missing: {directory}")
    hits = sorted(directory.glob(pattern))
    if not hits:
        die(f"no files matching {pattern} under {directory}")
    for f in hits:
        shutil.copy2(f, out / f.name)
        print(f"    {f.name}")


def cmd_build(args):
    system = platform.system()
    if system not in TARGETS:
        die(f"unsupported platform: {system}")

    if args.env_file:
        load_env_file(args.env_file)

    check_version_sites()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    print(f"\n==> Allr {version()} on {system}\n")

    if args.check_only:
        # Every credential assertion, none of the 20-40 minutes of building.
        # Worth having as its own mode: the failure this guards against is a
        # build that runs to completion and produces an artifact nobody can
        # install, which is expensive to discover at the end.
        require_env("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
        if system == "Darwin":
            check_macos_credentials()
        print("\nCredentials look right. Re-run without --check-only to build.")
        return

    if system == "Darwin":
        build_macos(out, notarize=not args.skip_notarization)
    elif system == "Linux":
        build_linux(out)
    else:
        build_windows(out)

    sigs = list(out.glob("*.sig"))
    print(f"\nStaged in {out}:")
    for f in sorted(out.iterdir()):
        print(f"  {f.name}  ({f.stat().st_size / 1048576:.1f} MB)")

    if not sigs:
        die(
            "no .sig files were produced, so this build cannot feed latest.json "
            "and\n       existing installs would never see the release. "
            "TAURI_SIGNING_PRIVATE_KEY\n       was almost certainly not in "
            "scope for the bundler."
        )

    print(
        f"\nNext: copy the contents of {out} to the machine that will publish, "
        f"then run\n  python scripts/release-desktop-local.py assemble --dist <dir>"
    )


# ---------------------------------------------------------------------------
# assemble
# ---------------------------------------------------------------------------

# How a bundler output becomes a latest.json platform key.
#
# The keys are what apps/hermes-universal's updater asks for, and a missing one
# strands that platform on the old build while REPORTING "up to date" -- it is a
# silent failure, which is why publish() checks for them explicitly.
#
# macOS is one universal artifact deliberately, and all three darwin keys point
# at it. The reason usually given for this -- that updates.rs matches assets by
# `contains(std::env::consts::ARCH)` -- is out of date: no such code remains in
# updates.rs (only `consts::OS`, in unrelated surface/ files), because asset
# selection now happens inside tauri-plugin-updater against these manifest keys.
# Naming all three anyway is still right, and cheap: a universal bundle is
# correct for whichever key the plugin asks for, and a per-arch split would
# reintroduce the ambiguity that Tauri's `_x64.dmg` naming caused.
PLATFORM_KEYS = [
    ("darwin-aarch64", "*_universal.app.tar.gz"),
    ("darwin-x86_64", "*_universal.app.tar.gz"),
    ("darwin-universal", "*_universal.app.tar.gz"),
    ("windows-x86_64", "*_x64-setup.exe"),
    # The bare linux key USED to be the AppImage's. The AppImage is gone, so it
    # now names the .deb -- the widest-reaching remaining format. Leaving it
    # pointed at a file that no longer ships is how a release silently stops
    # updating every Debian and Ubuntu install.
    ("linux-x86_64", "*_amd64.deb"),
    ("linux-x86_64-deb", "*_amd64.deb"),
    ("linux-x86_64-rpm", "*.x86_64.rpm"),
]


def cmd_assemble(args):
    dist = Path(args.dist).resolve()
    if not dist.is_dir():
        die(f"no such directory: {dist}")

    v = version()
    tag = tag_for(v)

    # Every artifact must carry this release's version in its name. A stale file
    # left in dist/ from a previous attempt would otherwise be uploaded and, if
    # it happens to match a glob below, signed into latest.json.
    stale = [
        f.name
        for f in dist.iterdir()
        if f.is_file()
        and re.search(r"\d+\.\d+\.\d+", f.name)
        and v not in f.name
        and f.name not in ("latest.json", "SHA256SUMS.txt")
    ]
    if stale:
        die(
            f"these files in {dist} are not version {v}:\n       "
            + "\n       ".join(sorted(stale))
            + "\n\nRemove them, or you will publish a mixed-version release."
        )

    platforms = {}
    missing = []
    for key, pattern in PLATFORM_KEYS:
        hits = sorted(dist.glob(pattern))
        if not hits:
            missing.append(f"{key}: nothing matching {pattern}")
            continue
        artifact = hits[0]
        sig = artifact.with_name(artifact.name + ".sig")
        if not sig.is_file():
            missing.append(f"{key}: {artifact.name} has no .sig beside it")
            continue
        platforms[key] = {
            "signature": sig.read_text().strip(),
            # The public download URL, not the api.github.com asset URL that
            # tauri-action emits. Both work, but this one needs no asset id and
            # so can be written before anything is uploaded.
            "url": f"https://github.com/{REPO_SLUG}/releases/download/{tag}/{artifact.name}",
        }

    if missing:
        die(
            "latest.json would strand these platforms:\n       "
            + "\n       ".join(missing)
            + "\n\nA stranded platform reports 'up to date' forever rather than "
            "erroring,\nso this is refused rather than warned about. Did every "
            "machine's dist/\nget copied in?"
        )

    manifest = {
        "version": v,
        "notes": args.notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "platforms": platforms,
    }
    (dist / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"==> latest.json for {v}, covering {len(platforms)} platform keys")

    # Windows ships unsigned, so a published checksum is the only integrity
    # signal a careful user has. Excludes the .sig files (already signatures).
    lines = []
    for f in sorted(dist.iterdir()):
        if not f.is_file() or f.name in ("SHA256SUMS.txt",) or f.suffix == ".sig":
            continue
        h = hashlib.sha256(f.read_bytes()).hexdigest()
        lines.append(f"{h}  {f.name}")
    (dist / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n")
    print(f"==> SHA256SUMS.txt over {len(lines)} assets")

    print(f"\nReady to publish {tag}. Review {dist}/latest.json, then:")
    print("  python scripts/release-desktop-local.py publish --dist", dist)


# ---------------------------------------------------------------------------
# publish
# ---------------------------------------------------------------------------


def cmd_publish(args):
    dist = Path(args.dist).resolve()
    manifest_path = dist / "latest.json"
    if not manifest_path.is_file():
        die("no latest.json -- run `assemble` first")

    manifest = json.loads(manifest_path.read_text())
    v = version()
    if manifest["version"] != v:
        die(
            f"latest.json says {manifest['version']} but the tree says {v}. "
            "Re-run `assemble`."
        )

    tag = tag_for(v)
    assets = [f for f in sorted(dist.iterdir()) if f.is_file()]

    if not shutil.which("gh"):
        die("the GitHub CLI (gh) is not on PATH")

    # Create as a DRAFT and flip it at the end. latest.json names asset URLs on
    # this release, and a draft's asset URLs 404 -- so publishing the pointer
    # before the release is visible would advertise a version nobody can
    # download.
    exists = (
        subprocess.run(
            ["gh", "release", "view", tag, "-R", REPO_SLUG],
            capture_output=True,
        ).returncode
        == 0
    )
    if not exists:
        print(f"==> creating draft release {tag}")
        run(
            [
                "gh", "release", "create", tag,
                "-R", REPO_SLUG,
                "--draft",
                "--title", f"Allr Desktop v{v}",
                "--notes", args.notes or DEFAULT_NOTES,
            ]
        )
    else:
        print(f"==> reusing existing release {tag}")

    print(f"==> uploading {len(assets)} assets")
    run(
        ["gh", "release", "upload", tag, "-R", REPO_SLUG, "--clobber"]
        + [str(a) for a in assets]
    )

    if args.draft:
        print(f"\nLeft as a draft. Review it, then re-run without --draft.")
        return

    # --latest=false is load-bearing: /releases/latest must keep resolving to
    # the Python CalVer release that install.sh is built around.
    print("==> publishing")
    flags = ["--draft=false", "--latest=false"]
    if "-" in v:
        flags.append("--prerelease")
    run(["gh", "release", "edit", tag, "-R", REPO_SLUG] + flags)

    # LAST. A prerelease never moves the stable pointer at all.
    if "-" in v:
        print(f"\n{v} is a prerelease; the updater pointer was NOT moved.")
        return

    print(f"==> moving the {UPDATER_TAG} pointer")
    if (
        subprocess.run(
            ["gh", "release", "view", UPDATER_TAG, "-R", REPO_SLUG],
            capture_output=True,
        ).returncode
        != 0
    ):
        run(
            [
                "gh", "release", "create", UPDATER_TAG,
                "-R", REPO_SLUG,
                "--prerelease",
                "--title", "Desktop update channel",
                "--notes",
                "Pointer release. Its only asset is latest.json, which the Allr "
                "desktop updater reads. Not a downloadable build - see the "
                "desktop-v* releases.",
            ]
        )
    run(
        ["gh", "release", "upload", UPDATER_TAG, "-R", REPO_SLUG,
         str(manifest_path), "--clobber"]
    )

    print(f"\nPublished {tag} and moved the updater pointer to {v}.")
    print(f"  https://github.com/{REPO_SLUG}/releases/tag/{tag}")


DEFAULT_NOTES = (
    "Desktop builds of Allr. See the assets below. On Linux, "
    "`curl -fsSL https://raw.githubusercontent.com/allr-ajmx/allr-agent/main/"
    "scripts/install-desktop-linux.sh | bash` installs into ~/.local with no root."
)


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build this platform's assets")
    b.add_argument("--out", default="dist", help="staging directory (default: dist)")
    b.add_argument(
        "--env-file",
        help="KEY=VALUE file holding the signing credentials. Read identically "
        "by every shell, which `export` is not.",
    )
    b.add_argument(
        "--check-only",
        action="store_true",
        help="validate credentials and version sites, then stop without building",
    )
    b.add_argument(
        "--skip-notarization",
        action="store_true",
        help="macOS only, and NOT for a real release: builds signed but "
        "un-notarized, which Gatekeeper refuses on a downloaded copy.",
    )
    b.set_defaults(func=cmd_build)

    a = sub.add_parser("assemble", help="write latest.json and SHA256SUMS.txt")
    a.add_argument("--dist", default="dist", help="directory holding every platform's assets")
    a.add_argument("--notes", default="", help="release notes embedded in latest.json")
    a.set_defaults(func=cmd_assemble)

    u = sub.add_parser("publish", help="upload to GitHub and move the updater pointer")
    u.add_argument("--dist", default="dist")
    u.add_argument("--notes", default="", help="release body")
    u.add_argument(
        "--draft", action="store_true", help="upload but leave the release a draft"
    )
    u.set_defaults(func=cmd_publish)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
