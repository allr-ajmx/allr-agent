# Bundled plugins

Drop a `<name>/plugin.{ts,tsx}` here that default-exports a `HermesPlugin` and it
registers automatically at boot (vite glob in `../contrib/plugins.ts`), with the
same inventory + live enable/disable contract runtime plugins get.

Three ship here, as the reference implementations of the SDK — they are the
companion [`hermes-example-plugins`](https://github.com/NousResearch/hermes-example-plugins)
demos, kept in-tree so the plugin surface has live consumers on every platform
universal runs on (desktop keeps the same folder at `apps/desktop/src/plugins/`):

| | |
|---|---|
| `example/` | The counter: `keybinds` + `palette` + `statusBar.right` contributions, `ctx.storage` persistence, `host.onEvent`. |
| `gateway-pill/` | The gateway health pill — `host.state.gateway`, `host.request`, `host.restartGateway`, a stateful `render()` item that owns its slot. |
| `hello-runtime/` | **Not bundled.** See below. |

`hello-runtime/plugin.runtime.js` is named `.runtime.js` deliberately so the glob
above skips it: it is a copy-me sample for the *other* door, already plain ESM
importing only `@hermes/plugin-sdk` and `react/jsx-runtime` — no build step.

```
cp src/plugins/hello-runtime/plugin.runtime.js \
   ~/.hermes/desktop-plugins/hello-runtime/plugin.js
```

That is the only way to exercise the runtime pipeline end to end (specifier
rewrite → SDK/react shim blobs → `blob:` import under the app CSP → React
singleton), which a bundled plugin never touches.

User- and agent-authored plugins load from that same disk door —
`$HERMES_HOME[/profiles/<p>]/desktop-plugins/<name>/plugin.js` on this device, or
the connected gateway's copy of the tree when the local one is empty (see
`../contrib/plugin-disk.ts`).
