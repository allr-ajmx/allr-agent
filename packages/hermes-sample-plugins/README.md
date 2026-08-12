# Sample plugins

The SDK's reference plugins. **This is the one canonical copy** — `apps/desktop`
and `apps/hermes-universal` both glob this directory, so a sample can't drift
between the two apps, and there is no third copy to keep in sync when a third
surface appears.

Deliberately **not** an npm workspace: it has no `package.json` and nothing
depends on it by name. It is a source directory two apps compile, which keeps
`package-lock.json` out of the change entirely.

| | |
|---|---|
| `example/` | The counter — the smallest thing that registers a statusbar contribution and a keybind. |
| `gateway-pill/` | A 1:1 rebuild of a core statusbar control, as a plugin. Proof the SDK can express what core expresses. |
| `hello-runtime/` | Plain ESM with `jsx()` calls, no compiler. See below. |
| `kanban/` | The widest consumer: `routes` + `sidebar.nav` + `palette` + `keybinds` together, plus both plugin-namespaced transports. |

## The two ways these ship

**Bundled** — the vite glob in each app's `src/contrib/plugins.ts` picks up
every `<name>/plugin.{ts,tsx}` here and registers it at boot, with the same
inventory and live enable/disable contract as a runtime plugin. They compile
with the app, so **both** apps typecheck them (each `tsconfig.json` names this
directory in `include`).

Lint runs once rather than twice: `@hermes/universal`'s `lint:samples` script
is the single caller, because an ESLint flat config only reaches files beneath
its own directory — hence the `eslint.config.mjs` here, and the `cd` in that
script. Pointing an app's config at this directory silently matches **nothing**
and exits 0, so if you rework the lint wiring, check the file count rather than
the exit code.

**Through the disk door** — `node scripts/build-sample-plugins.mjs` compiles
each one to a standalone ESM `plugin.js` in
`$HERMES_HOME/desktop-plugins/<name>/`, which is the same shape a third-party
plugin has. That path is worth exercising because it is the only one that
touches the real runtime pipeline: specifier rewrite → SDK/react shim blobs →
`blob:` import under the app CSP → React singleton. A bundled plugin is
compiled with the app and never goes near any of it.

The two are not redundant. Bundling gives typechecking; the artifact is the
only honest test of the published contract.

## Writing one

Import from `@hermes/plugin-sdk` and nothing else. Relative `./` siblings are
fine; `@/…` app internals are not, and a runtime-loaded plugin importing any
other bare specifier is rejected up front by the loader. That rule is what lets
these files live outside both apps' `src/` and compile in either.

`hello-runtime` is the exception that proves the shape: it is
`plugin.runtime.js`, hand-written plain ESM, and the bundled glob does not
match it. The build script copies it verbatim. It exists to show exactly what
an agent (or a compiler) writes into `$HERMES_HOME/desktop-plugins/<name>/plugin.js`.

## Reaching the OS

`ctx.os` is the only sanctioned way out of the app window — `notify`,
`openExternal`, `revealPath`, `writeClipboard`. Both apps present the identical
contract over different machinery (desktop: the Electron preload bridge;
universal: Tauri), so a plugin written against one runs unmodified on the other.

Every member is **result-shaped, never throwing**: the three async doors resolve
`false` when the platform can't honour the call, and `notify` is fire-and-forget.
That is what makes the same code safe on a phone, where `revealPath` has no file
manager to reveal into and the clipboard may be refused outright. Branch on the
result; never assume the door opened.

```ts
if (!(await ctx.os.openExternal(url))) {
  host.notify({ kind: 'info', message: 'Copy this link: ' + url })
}
```

`ctx.os.notify` is the native OS notification, gated by Settings ▸ Notifications
▸ "Plugin notifications", throttled per plugin, and fires only while the user is
away from Hermes. For anything the user should see *while looking at the app*,
use `host.notify` — the in-app toast.

kanban talks to `/api/plugins/kanban`, served by the Python dashboard plugin at
`plugins/kanban/dashboard/plugin_api.py` in this repo — a separate plugin
system that meets this one only at that namespace. With the backend disabled
the board shows a message rather than a blank pane.

`ctx.socket` carries its live updates on both apps, but they are not equal. On
universal it mints a ws-ticket on ticket/oauth gateways rather than requiring a
`token=` query, and it **follows `$connection`** (`lib/plugin-transport.ts`):
opening it before the app has dialled is the normal case — plugins register from
a module body, the app dials afterwards — and it re-homes itself when the user
soft-switches gateways, so it never streams the previous backend's data into a
plugin whose `ctx.rest` has already moved. Desktop's door is still token-mode
only and resolves to nothing on an OAuth remote (`apps/desktop/src/hermes.ts`).

Either way it is an **accelerator over your polling, never a replacement** — a
socket can always drop, a ticket mint can fail on an expired session, and
neither failure is reported back to the plugin, so every consumer needs the
polling fallback anyway.
