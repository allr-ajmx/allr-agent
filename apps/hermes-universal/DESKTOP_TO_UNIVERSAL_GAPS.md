# Desktop → Universal: features still to port

Features `apps/desktop` (Electron) has that `apps/hermes-universal` (Tauri) does **not** yet,
i.e. remaining desktop→universal port work. Sourced from the **live** `FIXME(<track>)` markers in
`apps/hermes-universal/src` (the authoritative "not-fully-ported" index — the `PORT.md`/`UI_PORT.md`
ledgers are partly stale, e.g. full `buildToolView` tool rendering is now done) plus a structural
diff of the two `settings/` and `app/` trees.

Verify each against current `src` before scheduling — a couple of ledger items already landed.

---

## Tier 1 — chat message richness (MJX-103) — mostly LANDED

Status after MJX-103 (`FIXME(chat-port)` 14 → 9 remaining; `FIXME(K4)` resolved):

- ✅ **Media / attachment rendering** — `#media:` image/audio/video + file attachments render inline
  (`MediaAttachment` in `markdown-text.tsx`); `lib/media.ts` grown to the full helper set, routing
  gateway bytes through the authenticated Rust `readFileDataUrl` transport (closes the old K4
  cookie/ticket-auth gap by construction).
- ✅ **Directive chips** — `@file:`/`@image:`/`@url:` chips + thumbnails render in sent user messages via
  the new `components/assistant-ui/directive-content.tsx` (React half of `directive-text.ts`), wired into
  `thread/user-message-text.tsx` (inline) and `thread/user-message.tsx` (attachments slot).
- ✅ **Link-title bridge** — new native `fetch_link_title` Tauri command (reqwest GET + `<title>`/`og:title`
  parse in `src-tauri/src/link_title.rs`); `lib/external-link.tsx` invokes it with cache + inflight dedup.
- ⚠️ **Deferred (not blocked):** seekable audio/video streaming (desktop `hermes-media://` custom scheme;
  universal uses data URLs for now — `markdown-text.tsx` FIXME); link-preview attachments (`PreviewAttachment`
  depends on the Tier-4 preview-store remodel — `assistant-message.tsx:62`).
- ⛔ **Branch/fork + reload/regenerate** — BLOCKED on the incremental runtime (not gateway-media). Markers
  kept + annotated in `thread/assistant-message.tsx` (:121/:141/:219).

## Tier 2 — sessions (`FIXME(H)`, `FIXME(sidebar)`)

- **Export conversation** (H4), **Branch-from** (H5), **Open-in-new-window** — desktop session menu verbs, deferred. `app/chat/sidebar/session-actions-menu.tsx`
- **True offset pagination** of history (universal re-fetches a bigger limit). `store/session.ts`
- **Attached-Context marker** handling in history. `lib/session-history.ts`

## Tier 3 — settings pages MISSING entirely (structural diff — no file in universal)

- **Custom endpoints** (`custom-endpoints-settings.tsx`) — custom API base URLs
- **Plugins** (`plugins-settings.tsx`) — plugin management
- **Billing** (`billing/`) — cloud subscription/billing
- **Pet settings** (`pet-settings.tsx`) and **Sessions settings** (`sessions-settings.tsx`) — present only partially
- **Config export/import** (`FIXME(J)`) — needs a Tauri fs-write dialog; **placeholder** section renderers still stubbed (`settings-section.tsx`)
- **Local-endpoint onboarding** (`FIXME(J7)`)

## Tier 4 — composer status rows (STUB `FIXME(chat-port)`)

- **CodingStatusRow** (branch / worktree status) — stub. `composer/status-stack/coding-row.tsx`
- **PreviewStatusRow** (localhost preview surfacing) — stub. `composer/status-stack/preview-row.tsx`
- **Slash-command exec + arg-completion** edge cases (`FIXME(Gc7)`). `app/chat/composer-completions.ts`

## Tier 5 — workspace / projects (`FIXME(projects)` ×4)

- **Git worktree ops** — create/scan/base-branch, repo scan, lane nesting, browsable local folder picker,
  IDEA.md write. Desktop-native; needs local `git`. `store/projects.ts`, `app/chat/sidebar/projects/*`

## Tier 6 — polish / smaller

- **Theme marketplace / file import** (VS Code themes) — dropped in universal (`FIXME(I3)`). `themes/user-themes.ts`
- **FancyZones structural layout authoring** (TreeEditBar / ZoneEditor) — layout presets are read-only (`FIXME(MJX-51)`). `app/contrib/controller.tsx`, `components/pane-shell/tree/renderer/*`
- **Profile rail** — drag-reorder, long-press recolor, "all profiles" (`FIXME(profile-rail)`). `app/chat/sidebar/profile-switcher.tsx`
- **CLI-terminal providers** in onboarding (`FIXME(K11)`) — need a terminal.
- Rich status/session handling (`FIXME(G)`, `FIXME(G8)`) — minor.

---

## Explicitly OUT — do NOT port (design decision / mobile-only / blocked)

- **Self-updater** (K12) — "no client self-updater by design" (version → Command Center system panel).
- **Uninstall** (J15) and **Computer-use panel** (J12) — no mobile analog.
- **SSH _terminal_ backend** (`terminal-backend-panel`, `ssh-host-selection`; K15) — impractical on Android; local PTY already works on desktop.
  Note: the SSH **gateway mode** is a different feature and is now IN — see MJX-55 / `src-tauri/src/ssh/`. Only the terminal backend remains out.
- **Deep-link** (`hermes://`, R13), **biometric** (`FIXME(D)`) — intentionally deferred/dropped.
- Android-only cloud/oauth gaps: `FIXME(E4)`, `FIXME(D3)`, `FIXME(D7)`, `FIXME(E3)`.

## Suggested next step

Turn Tier 1–3 into Linear issues (biggest user value, mostly self-contained TS). Tier 1 media/attachments
is the single highest-impact item but depends on the gateway-media RPCs — worth scoping that dependency first.
