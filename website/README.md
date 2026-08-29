# Allr documentation site

The [Docusaurus](https://docusaurus.io/) site published at **https://allr.work/docs**.

Uses **npm**, not yarn — there is no `yarn.lock`, and CI runs `npm ci`.

## Requirements

| | |
|---|---|
| Node | 22.22+ locally; CI builds on **Node 26** |
| npm | **>= 11.17.0** (`package.json` engines); CI installs npm 12 explicitly |
| Python | 3.11, for the prebuild scripts |
| Python deps | `pyyaml` (skill extraction), `ascii-guard` (diagram lint) |

## Local development

```bash
npm ci
npm start          # dev server with live reload
```

`npm start` and `npm run build` each fire a `pre*` lifecycle hook that runs
`scripts/prebuild.mjs` automatically. That script:

1. refreshes `static/api/skills-index.json` if it is missing or more than 24h old,
2. runs `scripts/extract-skills.py` → `static/api/skills.json` + `skills-meta.json`,
3. runs `scripts/generate-llms-txt.py` → `static/llms.txt` + `llms-full.txt`,
4. runs `scripts/extract-automation-blueprints.py`.

Each step degrades gracefully — a missing `python3` or `pyyaml` writes an empty
placeholder rather than failing the build, so a JS-only contributor is never blocked.

> **`generate-skill-docs.py` is deliberately NOT in that chain.** It is run by CI only.
> If you are working on skill pages, run it yourself (see below) or you will be looking
> at stale output locally while CI regenerates it.

## Building

```bash
npm run build:fast   # English only — what PR checks run
npm run build        # full bilingual build (en + zh-Hans) — what deploy runs
npm run serve        # serve the production build locally
npm run lint:diagrams  # ascii-guard: rejects ASCII box diagrams, use Mermaid
npm run typecheck
```

## Generated files — do not edit by hand

Regenerated from the `SKILL.md` files in `skills/` and `optional-skills/` by
`website/scripts/generate-skill-docs.py`:

- `docs/user-guide/skills/**` — one page per skill (191 of them)
- `docs/reference/skills-catalog.md`
- `docs/reference/optional-skills-catalog.md`
- the Skills subtree inside `sidebars.ts`

Edit the source `SKILL.md`, then regenerate:

```bash
python3 scripts/extract-skills.py
python3 scripts/generate-skill-docs.py
```

Hand edits to the files above are overwritten on the next CI run.

## Deployment

Production is served from **Vercel**, triggered by a deploy hook in
`.github/workflows/deploy-site.yml` on release publish or manual dispatch.

That workflow also contains a GitHub Pages job, but it is gated on
`github.repository == 'NousResearch/hermes-agent'` and therefore **never runs in this
fork**. Nothing here deploys via `docusaurus deploy` or a `gh-pages` branch — the
`deploy` script in `package.json` is vestigial.

PR checks run through `.github/workflows/docs-site-checks.yml`: `npm ci`, the two skill
scripts, `lint:diagrams`, then `build:fast`.

## Search

Search is `@easyops-cn/docusaurus-search-local` — an offline index built at compile
time, configured in `docusaurus.config.ts` under `themes`. It replaced Algolia
DocSearch, which pointed at an index this project does not own. It needs no account,
no crawler and no API key; if you add a docs section, search picks it up on the next
build.
