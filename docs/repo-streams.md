# Repository streams: how allr-agent ingests, and why nothing flows back

**Status:** authoritative description of this repository's branch model.
**Audience:** anyone committing to `allr-agent`, and anyone who also works in
`jaxmatrix/mjx-hermes-agent` or contributes to `NousResearch/hermes-agent`.

`allr-agent` began as a fork of `NousResearch/hermes-agent` by way of
`jaxmatrix/mjx-hermes-agent`, and is no longer one. It is an independent project
that happens to share a skeleton with two upstream repositories. It **ingests**
from both and **pushes back to neither**. That one-way rule is the whole design;
everything below exists to make it hold.

The point of divergence is tagged `divergence/2026-08-17`, on commit
`7d6bcd62c1f446ea64bb29652d99d56543009ef6`. Full history before that point is
preserved (23,104 commits), so `git blame` and `git bisect` work across the seam.

```
  stream/support     (mirror of jaxmatrix/mjx-hermes-agent : main)   ──┐
                                                                       ├──► merge ──► main ──► release
  stream/downstream  (mirror of NousResearch/hermes-agent   : main)   ──┘

  no arrow ever points outward
```

## 1. Branches

| Branch | Role | Who writes to it |
|---|---|---|
| `main` | Product trunk. The only branch development targets. | PRs |
| `stream/support` | Mirror of `jaxmatrix/mjx-hermes-agent:main` | Refresh procedure only — never a commit |
| `stream/downstream` | Mirror of `NousResearch/hermes-agent:main` | Refresh procedure only — never a commit |
| `ingest/<lane>-<date>` | Short-lived; merges one stream into `main` via PR | Whoever runs the ingest |
| `feat/…` `fix/…` `docs/…` `test/…` `refactor/…` | Normal work | Anyone |

The two `stream/*` branches are **mirrors, not development branches**. They only
ever fast-forward to whatever their source repository's `main` has become. A
commit authored directly on a stream lane breaks the mirror invariant and will be
clobbered by the next refresh.

Branch naming and Conventional Commits carry over unchanged from
`CONTRIBUTING.md` (`### Branch naming`, `### Commit messages`).

This formalises what the fork already did informally: `mjx-hermes-agent` carried a
long-lived `main-sync` branch that merged `upstream/main` and then PR'd into
`main` — 35 such merges in history, and this repository's root commit
`7d6bcd62c` is one of them. `stream/*` plus `ingest/*` is that same pattern made
explicit and given two lanes instead of one.

## 2. Remotes

A single local checkout serves all three repositories; they share almost all
objects, so there is no reason to keep separate clones.

```
git remote add origin      https://github.com/allr-ajmx/allr-agent.git
git remote add support     https://github.com/jaxmatrix/mjx-hermes-agent.git
git remote add downstream  https://github.com/NousResearch/hermes-agent.git
```

`support` and `downstream` are **fetch-only in practice**. Never `git push` to
either from work done here. If you want belt-and-braces enforcement:

```
git remote set-url --push support    no-push
git remote set-url --push downstream no-push
```

## 3. Refresh procedure

Moving a mirror forward. This is the repeated operation.

```sh
# support lane — this fork's own work
git fetch support main
git push origin support/main:refs/heads/stream/support

# downstream lane — Nous Research upstream
git fetch downstream main
git push origin downstream/main:refs/heads/stream/downstream
```

Then ingest, deliberately, on a branch — **never straight to `main`**:

```sh
git fetch origin
git switch -c ingest/support-$(date +%F) origin/main
git merge origin/stream/support
# resolve conflicts, run the test suite, open a PR into main
```

The merge is **expected** to conflict, and increasingly so as this repository
diverges. That is the point: each ingest is a reviewed decision, not an automatic
sync. If it ever stops conflicting, check that the lane actually moved.

## 4. Triaging ingest conflicts

Whether a conflict is real divergence or upstream churn depends on which side of
the skeleton boundary the file sits on.

**Inherited skeleton** — arrives via `stream/downstream`; conflicts here are
usually upstream churn to accept:

the Python agent core at root (`run_agent.py`, `cli.py`, `hermes_state*.py`,
`toolsets.py`, `hermes_constants.py`), `agent/`, `hermes_cli/`, `tools/`,
`gateway/`, `ui-tui/`, `tui_gateway/`, `acp_adapter/`, `cron/`, `plugins/`,
`skills/`, `optional-skills/`, `web/`, `website/`, `docs/`, `locales/`,
`native/`, and — this surprises people — `apps/desktop/`,
`apps/bootstrap-installer/`, `apps/shared/` **and the npm workspace itself**, all
of which predate the fork.

**This project's own work** — arrives via `stream/support`; conflicts here are
real divergence and need judgement:

| Path | Origin |
|---|---|
| `apps/hermes-universal/` | Tauri v2 universal app (desktop + iOS/Android), React + Rust `src-tauri/`. First commit `c7dc6ddaf`, 2026-07-06. |
| `packages/hermes-sample-plugins/` | First commit `4d48839a2`, 2026-08-06. |

## 5. Where to author work

`jaxmatrix/mjx-hermes-agent` is dual-purpose: it is both the PR source for
`NousResearch/hermes-agent` and the `stream/support` lane feeding this
repository. So one class of work can be written once and serve both. But that
fork is **public** and `allr-agent` is **private**, and the boundary is hard.

| What you are building | Author it in |
|---|---|
| Generic fix or feature, happy to be public, possibly upstreamable to Nous | `mjx-hermes-agent` → reaches here on the next ingest |
| allr-proprietary or confidential — brand assets, org config, customer features, credentials | `allr-agent` only. Putting it in the fork **publishes it**. |
| Anything touching files `allr-agent` has already rebranded | `allr-agent`, else the same change is fought twice |
| A PR to `NousResearch/hermes-agent` | `mjx-hermes-agent` — this repository never pushes back |

Two things that are easy to forget:

- **Fork work is not automatic.** `stream/support` only moves when someone runs
  the refresh, and the merge into `main` is a reviewed PR. Until then the work
  exists only in the fork.
- **The asymmetry is permanent.** Nothing authored in `allr-agent` ever reaches
  the fork or Nous Research. That is the one-way rule working correctly, but it
  means "just work in one place" only holds in the fork → allr direction.

## 6. Known gaps

- **The stream lanes are not server-enforced.** Branch protection and rulesets
  require GitHub Pro/Team on a private repository; the `allr-ajmx` org is
  currently on the Free plan, so the API returns `403 Upgrade to GitHub Pro or
  make this repository public`. Until that changes, §1's "never a commit" rule on
  `stream/*` and force-push/deletion protection on `main` are **convention only**.
- **GitHub Actions are disabled on this repository.** They were switched off
  before the initial import so that 26 inherited workflows would not fire against
  a repository they were never written for. Several are hard-gated to
  `github.repository == 'NousResearch/hermes-agent'` and would silently never
  run; `deploy-site.yml`'s `deploy-vercel` job has no such guard and fires on
  `release`. Triage the workflows before re-enabling.
- **Repository identity still points upstream** in package metadata, installer
  scripts, and some runtime code (notably `hermes_cli/update_cmd.py`,
  `hermes_cli/banner.py`, `hermes_cli/model_catalog.py`, `tools/skills_hub.py`).
  The MIT `LICENSE` © Nous Research must be retained regardless — that is the
  licence's one obligation.
