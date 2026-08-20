#!/usr/bin/env python3
"""Allr Desktop Version Bump

Sets the shared desktop-app version across every file that carries it. The two
Tauri apps ship together as one GitHub Release, so they move together.

This exists because the version lives in TEN places and a stale one does not
fail loudly. Tauri's own mismatch check catches some of them; the tracked Apple
project does not -- `gen/apple/project.yml` is hand-maintained rather than
regenerated, so a stale CFBundleVersion there silently wins over tauri.conf.json
(learned in 67f679a109). The Windows side manifest is a fourth, four-component
form.

Usage:
    # Show what would change
    python scripts/bump-desktop-version.py 0.1.0 --dry-run

    # Apply it
    python scripts/bump-desktop-version.py 0.1.0

Cargo.lock is refreshed with `cargo update -p <crate> --precise <version>` when
cargo is on PATH; pass --no-lock to skip that.
"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

UNIVERSAL = REPO_ROOT / "apps" / "hermes-universal"
INSTALLER = REPO_ROOT / "apps" / "bootstrap-installer"

# Semver only. The Windows manifest needs a fourth component, which is derived.
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


class Edit:
    """One substitution in one file, with a guard on how many it should make."""

    def __init__(self, path: Path, pattern: str, replacement: str, count: int = 1):
        self.path = path
        self.pattern = pattern
        self.replacement = replacement
        self.count = count

    def current(self) -> str | None:
        """The version this file currently declares, or None if it can't be read."""
        if not self.path.exists():
            return None

        match = re.search(self.pattern, self.path.read_text(encoding="utf-8"))

        if not match:
            return None

        # The version literal is whatever sits between the captured prefix and
        # the captured suffix. Two-group patterns (the plists) wrap the value in
        # </string>; one-group patterns run to the end of the match.
        start = match.end(1) - match.start(0)
        end = (match.start(2) - match.start(0)) if match.lastindex and match.lastindex > 1 else None

        return match.group(0)[start:end].strip('"')

    def apply(self, version: str) -> tuple[bool, str]:
        """Returns (changed, message)."""
        rel = self.path.relative_to(REPO_ROOT)

        if not self.path.exists():
            return False, f"  MISSING  {rel}"

        original = self.path.read_text(encoding="utf-8")
        replacement = self.replacement.format(version=version)
        updated, made = re.subn(self.pattern, replacement, original, count=self.count)

        if made != self.count:
            return False, f"  FAILED   {rel} -- matched {made}x, expected {self.count}x"

        if updated == original:
            return False, f"  ok       {rel} (already {version})"

        self.path.write_text(updated, encoding="utf-8")

        return True, f"  bumped   {rel}"


def edits(version: str) -> list[Edit]:
    """Every place the desktop version is written."""
    quad = f"{version}.0"

    return [
        # --- Allr (apps/hermes-universal) ---------------------------------
        Edit(
            UNIVERSAL / "package.json",
            r'("version":\s*)"[^"]+"',
            r'\1"{version}"',
        ),
        Edit(
            UNIVERSAL / "src-tauri" / "tauri.conf.json",
            r'("version":\s*)"[^"]+"',
            r'\1"{version}"',
        ),
        Edit(
            UNIVERSAL / "src-tauri" / "Cargo.toml",
            r'(?m)^(version\s*=\s*)"[^"]+"',
            r'\1"{version}"',
        ),
        # Tracked and hand-maintained -- a stale value here beats tauri.conf.json.
        Edit(
            UNIVERSAL / "src-tauri" / "gen" / "apple" / "project.yml",
            r"(CFBundleShortVersionString:\s*)\S+",
            r"\g<1>{version}",
        ),
        Edit(
            UNIVERSAL / "src-tauri" / "gen" / "apple" / "project.yml",
            r'(CFBundleVersion:\s*)"[^"]*"',
            r'\1"{version}"',
        ),
        Edit(
            UNIVERSAL
            / "src-tauri"
            / "gen"
            / "apple"
            / "hermes-universal_iOS"
            / "Info.plist",
            r"(<key>CFBundleShortVersionString</key>\s*\n\s*<string>)[^<]*(</string>)",
            r"\g<1>{version}\g<2>",
        ),
        Edit(
            UNIVERSAL
            / "src-tauri"
            / "gen"
            / "apple"
            / "hermes-universal_iOS"
            / "Info.plist",
            r"(<key>CFBundleVersion</key>\s*\n\s*<string>)[^<]*(</string>)",
            r"\g<1>{version}\g<2>",
        ),
        # --- Allr Setup (apps/bootstrap-installer) ------------------------
        Edit(
            INSTALLER / "package.json",
            r'("version":\s*)"[^"]+"',
            r'\1"{version}"',
        ),
        Edit(
            INSTALLER / "src-tauri" / "tauri.conf.json",
            r'("version":\s*)"[^"]+"',
            r'\1"{version}"',
        ),
        Edit(
            INSTALLER / "src-tauri" / "Cargo.toml",
            r'(?m)^(version\s*=\s*)"[^"]+"',
            r'\1"{version}"',
        ),
        # Four components, and ONLY the assemblyIdentity's own version -- the
        # file also carries a `version="6.0.0.0"` dependency on the common
        # controls further down.
        Edit(
            INSTALLER / "src-tauri" / "allr-setup.manifest",
            r'(<assemblyIdentity\s*\n\s*version=)"[^"]*"',
            rf'\g<1>"{quad}"',
        ),
    ]


def refresh_lock(manifest: Path, crate: str, version: str) -> str:
    rel = manifest.relative_to(REPO_ROOT)

    if not shutil.which("cargo"):
        return f"  skipped  {rel} lock refresh (cargo not on PATH)"

    result = subprocess.run(
        [
            "cargo",
            "update",
            "-p",
            crate,
            "--precise",
            version,
            "--manifest-path",
            str(manifest),
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        return f"  FAILED   {rel} lock refresh -- {result.stderr.strip().splitlines()[-1:]}"

    return f"  bumped   {rel} lock"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Set the shared Allr desktop version everywhere it appears."
    )
    parser.add_argument("version", help="New semver version, e.g. 0.1.0")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List every file that would change without writing.",
    )
    parser.add_argument(
        "--no-lock",
        action="store_true",
        help="Skip the Cargo.lock refresh.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Write nothing; exit 1 if any file disagrees with VERSION. This is "
            "what the release workflow runs against the tag, so a mismatch "
            "fails in seconds instead of after a 40-minute universal build."
        ),
    )
    args = parser.parse_args()

    if not VERSION_RE.match(args.version):
        print(f"error: {args.version!r} is not a MAJOR.MINOR.PATCH version", file=sys.stderr)

        return 2

    planned = edits(args.version)

    if args.check:
        quad = f"{args.version}.0"
        drift = []

        for edit in planned:
            found = edit.current()
            want = quad if edit.path.name == "allr-setup.manifest" else args.version

            if found != want:
                drift.append(f"  {edit.path.relative_to(REPO_ROOT)}: {found!r} != {want!r}")

        if drift:
            print(f"error: {len(drift)} file(s) disagree with {args.version}:\n", file=sys.stderr)
            print("\n".join(drift), file=sys.stderr)
            print(
                f"\nRun: python scripts/bump-desktop-version.py {args.version}",
                file=sys.stderr,
            )

            return 1

        print(f"All {len(planned)} version sites agree on {args.version}.")

        return 0

    if args.dry_run:
        print(f"Would set the desktop version to {args.version} in {len(planned)} places:\n")

        for edit in planned:
            print(f"  {edit.path.relative_to(REPO_ROOT)}")

        print("\n  apps/hermes-universal/src-tauri/Cargo.lock")
        print("  apps/bootstrap-installer/src-tauri/Cargo.lock")
        print(f"\nThen tag: git tag desktop-v{args.version}")

        return 0

    print(f"Setting the desktop version to {args.version}\n")

    failed = False

    for edit in planned:
        changed, message = edit.apply(args.version)
        print(message)

        if "FAILED" in message or "MISSING" in message:
            failed = True

    if failed:
        print("\nerror: at least one file did not match as expected -- nothing was tagged.")
        print("The tree may be partially edited; check `git diff` before retrying.")

        return 1

    if not args.no_lock:
        print()
        print(
            refresh_lock(
                UNIVERSAL / "src-tauri" / "Cargo.toml", "hermes-universal", args.version
            )
        )
        print(
            refresh_lock(
                INSTALLER / "src-tauri" / "Cargo.toml", "hermes-bootstrap", args.version
            )
        )

    print(f"\nDone. Review `git diff`, commit, then tag:\n\n    git tag desktop-v{args.version}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
