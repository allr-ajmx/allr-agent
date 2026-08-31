# Test Checklist — v0.0.8 attribution + docs

Merged into `release/v0.0.8` as `eabb7a0cc`. 11 commits, 573 files.

Grouped by what would actually break. Automated checks first — if any of those
fail, stop, because the manual passes assume they are green.

---

## 1. Automated (must all pass)

- [ ] `python3 scripts/rebrand/rebrand.py --selftest` → `selftest OK`
- [ ] `python3 scripts/rebrand/rebrand.py --check` → `clean`, exit 0
- [ ] **`python3 scripts/rebrand/rebrand.py && git diff --stat` → empty.**
      This is the load-bearing one: it proves the next upstream ingest will not
      silently undo the attribution repair. If this produces a diff, the PROTECT
      masks are wrong and the whole branch regresses on the next merge.
- [ ] `cd apps/hermes-universal && npm run typecheck`
- [ ] `cd apps/hermes-universal && npm run check:i18n` → `OK`
      (fails if any of the 5 locales is missing the new `about.description`)
- [ ] `cd apps/hermes-universal && npm run lint`
- [ ] `cd ui-tui && npx tsc --noEmit`
- [ ] `cd web && npx tsc --noEmit`
- [ ] `cd website && npm ci && npm run build:fast` → succeeds with
      `onBrokenLinks: 'throw'`. Any broken link now fails the build rather than warning.
- [ ] `uv run python -m pytest tests/agent tests/skills tests/hermes_cli/test_windows_native_docs.py tests/test_cli_skin_integration.py -q -p no:randomly`
- [ ] `cd apps/hermes-universal && npx vitest run` — expect ~7 failures in
      `preview-tile`, `model-section`, `session-row-middle-click`,
      `provider-config-*`. **Pre-existing parallel-run flakiness**, not this branch:
      the untouched baseline fails 8 across 6 files, and each passes in isolation.
      Confirm the set has not grown.
- [ ] Full CI green on the PR (`js-tests` runs `check:i18n` as its own required job)

---

## 2. Attribution — the point of the branch

- [ ] Fresh install via `scripts/install.sh` seeds `~/.allr/SOUL.md` reading
      **"You are Allr, built on Hermes Agent by Nous Research."**
- [ ] Same via `scripts/install.ps1` on Windows
- [ ] Same for the Docker image (`docker/SOUL.md`)
- [ ] With **no** SOUL.md present, ask the agent "who made you?" — it must not
      claim to be a Nous Research product, and must not deny the lineage
- [ ] Spot-check restored skill credits, e.g.
      `grep '^author:' skills/productivity/pdf/SKILL.md` and a compound one like
      `skills/software-development/dogfood/SKILL.md` (`Teknium (teknium1), Hermes Agent`)
- [ ] `allr.work/docs` skill pages show the restored `| Author |` rows
- [ ] `LICENSE` still reads `Copyright (c) 2025 Nous Research` — untouched on purpose
- [ ] `plugins/allr-achievements/LICENSE` credits *Hermes Achievements contributors*

### Anthropic OAuth path (easy to miss)
- [ ] Run a turn through the **Claude Code OAuth** provider. The sanitizer must
      not leak a product name: the new attribution sentence is replaced whole, so
      the outgoing prompt should contain neither "Allr" nor "Hermes Agent".

---

## 3. Brand surfaces

- [ ] TUI banner at **wide** width: `◉ Forest of infinite creativity · Built on Hermes Agent`
- [ ] TUI banner at **medium** (46–63 cols) and **narrow** (<46) — no wrap, no
      truncation drift on the box-drawing edges
- [ ] TUI banner below 34 cols — hidden, as before
- [ ] Caduceus `⚕` is gone from the banner in **every skin** (skins cannot
      override `icon`, so one check covers all nine) — but is still present in the
      CLI **status bar**, which is a generic state marker and intentionally unchanged
- [ ] `warm-lightmode` skin response label reads ` Allr `, matching the other skins
- [ ] CLI banner model line ends `· Built on Hermes Agent`
- [ ] Narrow CLI banner (<30 cols) still renders
- [ ] `bash scripts/install.sh --help` (or just the banner) — box borders align
- [ ] Same for `install.ps1` on Windows
- [ ] Web dashboard sidebar renders **"Allr"**, not "ALLR / AGENT"
- [ ] **Dashboard footer still says "Nous Research" and still links to
      nousresearch.com** — deliberately reverted, must not regress
- [ ] Gateway / auth / connect surfaces still say Nous Research and Nous Cloud
- [ ] Pane-shell empty split zone shows the lowercase wordmark, not `ALLR`
- [ ] Bootstrap installer welcome screen shows `Allr`

---

## 4. Allr app — About panel

- [ ] Settings → About shows tagline eyebrow + the three-sentence description
- [ ] Renders correctly in **en, zh, ja, zh-hant**
- [ ] **ar (RTL)** — text direction correct, no clipped or mirrored layout
- [ ] Copy does not overflow on a narrow phone width
- [ ] Version row, update check and Release notes button still work
- [ ] Android: biometric unlock prompt says **"Unlock Allr"**
- [ ] iOS: home-screen name and app switcher say **Allr** (should already be
      correct — `PRODUCT_NAME` was already `Allr`; verify, do not "fix" the pbxproj)

---

## 5. Docs site — highest regression risk

- [ ] Site search works and returns results (Algolia is gone; this is the new
      local index). Try a term deep in the docs, e.g. `credential pools`.
- [ ] **Search index size** — currently 27 MB raw / 6.9 MB gzipped, lazy-loaded.
      Confirm first paint does not fetch it, and judge whether the size is acceptable.
- [ ] Search works on the **zh-Hans** locale
- [ ] All five renamed guide URLs redirect, not 404:
      `/guides/use-mcp-with-hermes`, `use-soul-with-hermes`,
      `use-voice-mode-with-hermes`, `run-hermes-with-nous-portal`,
      `secure-hermes-on-a-work-machine`
- [ ] `/guides/run-nemotron-3-ultra-free` redirects to `/integrations/providers`
- [ ] The 11 adopted orphan pages appear in the sidebar in sensible places
- [ ] Sidebar labels for the newly-titled pages read well (they come from the new
      `title:` frontmatter) — especially the four `secrets/*` siblings
- [ ] `allr.work/llms.txt` and `llms-full.txt` resolve and carry the new description
- [ ] Quickstart copy-paste test: every command in
      `getting-started/quickstart.md` runs as written (`allr`, not `hermes`)
- [ ] `allr --help` epilogue — all examples say `allr`, description column aligned

### Deliberate non-changes — confirm these did NOT get renamed
- [ ] `user-guide/docker.md` still uses `--name hermes` / `docker exec hermes`,
      and the command after the container name is `allr`
- [ ] Honcho `workspace` / `aiPeer` values still `hermes` (on-wire contract)
- [ ] Wake-word docs still say `"hey hermes"` — the shipped model is literally
      `hey_hermes` (`tools/wake_word.py`), so these docs are correct as-is
- [ ] Webhook routing examples still match on the literal `hermes` label

---

## 6. Contribution paths

- [ ] `git clone https://github.com/allr-ajmx/allr-agent.git && cd allr-agent`
      from the contributing guide now actually works (the old form cloned
      `hermes-agent/` and the next `cd` failed)
- [ ] Issue links in the docs land on `allr-ajmx/allr-agent/issues`
- [ ] The 9 `/issues/<number>` upstream citations still point upstream
- [ ] Windows install one-liner fetches `allr.work/install.ps1`
- [ ] Node version stated in both contributing guides matches `package.json` engines

---

## 7. Packaging

- [ ] `uv build` / `pip install -e .` succeeds with the new `[project.urls]`
- [ ] PyPI metadata shows Homepage `allr.work` and the `Upstream` link
- [ ] Tauri build: installer metadata and Windows file properties show the new
      copyright line and `publisher: Allr`
- [ ] `nix build` still works after the `flake.nix` description change

---

## Known open items (not defects in this branch)

- **B2 — Docker image.** `user-guide/docker.md` still documents pulling
  `nousresearch/hermes-agent:latest` in 9 places. Publish an Allr image or state
  plainly that the upstream image is used. Product decision.
- **Nous Portal framing.** `integrations/nous-portal.md` calls Portal "the
  recommended way to run Allr". Left as-is; flag if that is not the intended
  positioning.
- **Wake word.** Renaming "hey hermes" needs the model retrained, not a docs edit.
- **App vitest flakiness** predates this branch and is worth its own ticket.
