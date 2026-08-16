//! `hermes-artifact://` — an origin of its own for model-generated HTML.
//!
//! An artifact is a page the model wrote. Running it means running a stranger's
//! scripts, and where that happens decides what those scripts can reach.
//!
//! The obvious route — `srcdoc`, or a `blob:`/`data:` URL — is the wrong one
//! here, and not by a little. The app's `frame-src` names THIS scheme and
//! nothing else (it shipped with no `frame-src` at all, which fell back to
//! `default-src 'self'` and framed nothing): a `blob:` or `data:` frame is
//! refused outright, and a `srcdoc` frame renders but inherits the APP DOCUMENT's
//! policy, including `script-src 'self' blob:`, so the artifact's own inline
//! scripts never run. The only way to make that route work is to widen the
//! app's own `script-src` — which is to say, to weaken the policy protecting
//! the app in order to run untrusted code inside it. That is the outcome to
//! avoid.
//!
//! A dedicated scheme inverts the problem. The frame gets its own origin and
//! its own response CSP, sent from here, so `'unsafe-inline'` applies to the
//! ARTIFACT's document and to nothing else; the app's policy is untouched and
//! only grows a `frame-src` naming exactly this one scheme. The frame is
//! additionally sandboxed WITHOUT `allow-same-origin` (see the viewer), so even
//! within its own origin it is opaque.
//!
//! Precedent: `media.rs` registers `hermes-media://` the same way. This one is
//! simpler — it serves in-memory content the renderer handed it, never touching
//! the network or the disk.

use std::collections::HashMap;
use std::sync::RwLock;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{State, UriSchemeContext, UriSchemeResponder};

pub const ARTIFACT_SCHEME: &str = "hermes-artifact";

/// What an artifact document may do, sent as the FRAME's own policy.
///
/// `default-src 'none'` is the whole point: a generated page gets no network at
/// all — no `fetch`, no XHR, no WebSocket, no remote font, no beacon. It cannot
/// reach the gateway, it cannot reach `ipc:`, and it cannot phone home with
/// whatever it managed to read. What it CAN do is be a page: inline scripts and
/// styles, and images it inlines itself.
///
/// `'unsafe-inline'` looks alarming out of context and is exactly right in it.
/// The content IS the script — a generated page's code is written inline, and a
/// nonce would only be a lock on a door whose key is printed on the door. What
/// makes this safe is where it applies: this origin, this frame, nothing else.
///
/// There is deliberately NO `frame-ancestors`, and that absence is the whole
/// reason this comment is long. `frame-ancestors` names who may embed THIS
/// document, resolved against THIS document's origin — so `'self'` means "only
/// `hermes-artifact://…` may frame me", and the app document
/// (`tauri://localhost`, `http://tauri.localhost` on Windows/Android, a
/// `http://localhost:1420` dev server under `tauri dev`) is none of those. It
/// shipped as `frame-ancestors 'self'`, which is to say the policy forbade the
/// only embedder the scheme has: a blank frame everywhere the directive is
/// enforced. Naming the app's origins instead would mean hard-coding four
/// spellings plus whatever port vite picked today, and it would buy nothing —
/// `hermes-artifact://` is registered on this app's webview and is not reachable
/// from anywhere else, so there is no third-party embedder to defend against.
/// The isolation here comes from the opaque sandbox origin and from
/// `default-src 'none'`, not from an ancestor check.
const ARTIFACT_CSP: &str = "default-src 'none'; \
     script-src 'unsafe-inline' 'unsafe-eval'; \
     style-src 'unsafe-inline'; \
     img-src data: blob:; \
     font-src data:; \
     media-src data: blob:; \
     form-action 'none'; \
     base-uri 'none'";

/// One staged document and the number of frames that asked for it.
///
/// The count is not bookkeeping for its own sake: this state is per-APP, not
/// per-window, and the same artifact can be open in the main window and in a
/// detached chat window at once. Without it, the first of those two frames to
/// unmount would delete the document out from under the other, and the survivor
/// would 404 the moment anything reloaded it.
struct Staged {
    html: String,
    refs: usize,
}

/// Documents the renderer has staged for the frame, by id.
///
/// In memory only, and deliberately so: the transcript is the durable copy of
/// an artifact, and writing generated HTML to disk to render it would leave a
/// trail of stranger's pages in a temp directory the app never cleans.
#[derive(Default)]
pub struct ArtifactState(RwLock<HashMap<String, Staged>>);

/// Cap on staged documents. A session can iterate on an artifact many times;
/// only the ones actually opened are staged, and an unbounded map would hold
/// every version's full HTML for the life of the process.
const MAX_STAGED: usize = 16;

/// The store's own verbs, off the command layer so they can be exercised
/// directly — a `State<'_, _>` needs a running app, and the ref-counting below
/// is exactly the part worth a test.
impl ArtifactState {
    fn stage(&self, id: String, html: String) -> Result<(), String> {
        if id.is_empty() {
            return Err("artifact_id_required".into());
        }

        let mut guard = self.0.write().map_err(|_| "artifact_state_poisoned")?;

        if let Some(entry) = guard.get_mut(&id) {
            entry.refs += 1;
            entry.html = html;

            return Ok(());
        }

        if guard.len() >= MAX_STAGED {
            // Every surviving entry backs a MOUNTED frame (an entry is dropped
            // the moment its last frame releases it), so there is no idle
            // candidate to prefer — any choice blanks a visible preview. At 16
            // artifact frames open at once the cap is the smaller problem.
            if let Some(victim) = guard.keys().next().cloned() {
                guard.remove(&victim);
            }
        }

        guard.insert(id, Staged { html, refs: 1 });

        Ok(())
    }

    fn release(&self, id: &str) -> Result<(), String> {
        let mut guard = self.0.write().map_err(|_| "artifact_state_poisoned")?;

        let drained = match guard.get_mut(id) {
            Some(entry) => {
                entry.refs = entry.refs.saturating_sub(1);
                entry.refs == 0
            }
            None => false,
        };

        if drained {
            guard.remove(id);
        }

        Ok(())
    }

    fn document(&self, id: &str) -> Option<String> {
        self.0
            .read()
            .ok()
            .and_then(|map| map.get(id).map(|entry| entry.html.clone()))
    }
}

/// Stage a document and hand back the id the frame should load.
///
/// The renderer owns identity — an artifact id plus a content hash — so
/// re-staging the same version is idempotent and the frame's `src` stays
/// stable, which is what stops a re-render reloading (and re-running) the page.
#[tauri::command]
pub fn artifact_stage(
    state: State<'_, ArtifactState>,
    id: String,
    html: String,
) -> Result<(), String> {
    state.stage(id, html)
}

/// Drop a staged document — the viewer calls this when its frame unmounts.
/// The document only actually goes when the LAST frame holding it is gone.
#[tauri::command]
pub fn artifact_release(state: State<'_, ArtifactState>, id: String) -> Result<(), String> {
    state.release(&id)
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The id a request names.
///
/// Every platform spells a custom-scheme URL differently — `hermes-artifact://<id>`
/// on Linux/macOS, `http://hermes-artifact.localhost/<id>` on Windows and
/// Android — so read the id from whichever of host/path actually carries it
/// rather than assuming one shape.
fn requested_id(uri: &tauri::Url) -> String {
    let path = uri.path().trim_matches('/');

    if !path.is_empty() {
        return percent_encoding::percent_decode_str(path)
            .decode_utf8_lossy()
            .into_owned();
    }

    uri.host_str().unwrap_or_default().to_owned()
}

pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    use tauri::Manager;

    let app = ctx.app_handle();
    let uri = request.uri().to_string();

    let id = match tauri::Url::parse(&uri) {
        Ok(parsed) => requested_id(&parsed),
        Err(_) => String::new(),
    };

    let html = app
        .try_state::<ArtifactState>()
        .and_then(|state| state.document(&id));

    let response = match html {
        Some(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, ARTIFACT_CSP)
            // Nothing here is shareable: the document is one client's staged
            // copy, and a cached artifact would outlive the version it renders.
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(body.into_bytes())
            .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR)),
        None => status_only(StatusCode::NOT_FOUND),
    };

    responder.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the renderer actually builds (`lib/artifact-frame.ts`): a fixed
    /// `localhost` host with the id on the path, matching `hermes-media://`.
    #[test]
    fn reads_the_id_from_a_custom_scheme_url() {
        let url = tauri::Url::parse("hermes-artifact://localhost/abc123").expect("url");

        assert_eq!(requested_id(&url), "abc123");
    }

    /// The older host-carries-the-id spelling still resolves, so a webview that
    /// kept a stale frame URL across a hot reload doesn't 404.
    #[test]
    fn reads_the_id_from_a_bare_host_url() {
        let url = tauri::Url::parse("hermes-artifact://abc123").expect("url");

        assert_eq!(requested_id(&url), "abc123");
    }

    // Windows and Android rewrite a custom scheme to an http host, where the id
    // lands on the PATH instead. Both spellings have to resolve to one artifact
    // or the frame is blank on exactly those platforms.
    #[test]
    fn reads_the_id_from_the_localhost_rewrite() {
        let url = tauri::Url::parse("http://hermes-artifact.localhost/abc123").expect("url");

        assert_eq!(requested_id(&url), "abc123");
    }

    #[test]
    fn decodes_a_percent_encoded_id() {
        let url = tauri::Url::parse("http://hermes-artifact.localhost/a%3Ab").expect("url");

        assert_eq!(requested_id(&url), "a:b");
    }

    // The artifact's own policy must never grant it a way back to the app or
    // the gateway — that is the whole reason it gets an origin of its own.
    #[test]
    fn the_artifact_policy_grants_no_network() {
        assert!(ARTIFACT_CSP.contains("default-src 'none'"));
        assert!(!ARTIFACT_CSP.contains("connect-src"));
        assert!(!ARTIFACT_CSP.contains("ipc:"));
    }

    /// `frame-ancestors` resolves against the ARTIFACT's origin, so any value we
    /// could write here either forbids the app document (the one embedder there
    /// is) or hard-codes four platform spellings plus a dev-server port. The
    /// directive stays out; see ARTIFACT_CSP's comment.
    #[test]
    fn the_artifact_policy_does_not_forbid_its_own_embedder() {
        assert!(!ARTIFACT_CSP.contains("frame-ancestors"));
    }

    #[test]
    fn an_empty_id_is_refused() {
        let state = ArtifactState::default();

        assert!(state.stage(String::new(), "<p>x</p>".into()).is_err());
    }

    // Two frames, one document — the main window and a detached chat window can
    // hold the same artifact open. The first to unmount must not take the
    // document away from the second.
    #[test]
    fn a_document_survives_until_its_last_frame_releases_it() {
        let state = ArtifactState::default();

        state
            .stage("doc".into(), "<p>v1</p>".into())
            .expect("stage");
        state
            .stage("doc".into(), "<p>v1</p>".into())
            .expect("stage");

        state.release("doc").expect("release");

        assert_eq!(state.document("doc").as_deref(), Some("<p>v1</p>"));

        state.release("doc").expect("release");

        assert_eq!(state.document("doc"), None);
    }

    #[test]
    fn releasing_an_unknown_id_is_a_no_op() {
        let state = ArtifactState::default();

        state.release("nothing").expect("release");

        assert_eq!(state.document("nothing"), None);
    }

    // A released document is gone immediately, so staging the same id N times
    // and releasing it N times leaves nothing behind for the cap to trip over.
    #[test]
    fn staging_the_same_id_repeatedly_keeps_one_entry() {
        let state = ArtifactState::default();

        for _ in 0..MAX_STAGED * 2 {
            state.stage("doc".into(), "<p>v</p>".into()).expect("stage");
        }

        for _ in 0..MAX_STAGED * 2 {
            state.release("doc").expect("release");
        }

        assert_eq!(state.document("doc"), None);
    }
}
