# Langfuse Observability Plugin

This plugin ships bundled with Allr but is **opt-in** — it only loads when
you explicitly enable it.

## Enable

Pick one:

```bash
# Interactive: walks you through credentials + SDK install + enable
allr tools  # → Langfuse Observability

# Manual
pip install langfuse
allr plugins enable observability/langfuse
```

## Required credentials

Set these in `~/.allr/.env` (or via `allr tools`):

```bash
ALLR_LANGFUSE_PUBLIC_KEY=pk-lf-...
ALLR_LANGFUSE_SECRET_KEY=sk-lf-...
ALLR_LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your self-hosted URL
```

Without the SDK or credentials the hooks no-op silently — the plugin fails
open.

## Verify

```bash
allr plugins list                 # observability/langfuse should show "enabled"
allr chat -q "hello"              # then check Langfuse for a "Allr turn" trace
```

## Optional tuning

```bash
ALLR_LANGFUSE_ENV=production       # environment tag
ALLR_LANGFUSE_RELEASE=v1.0.0       # release tag
ALLR_LANGFUSE_SAMPLE_RATE=0.5      # sample 50% of traces
ALLR_LANGFUSE_MAX_CHARS=12000      # max chars per field (default: 12000)
ALLR_LANGFUSE_DEBUG=true           # verbose plugin logging
```

## Disable

```bash
allr plugins disable observability/langfuse
```
