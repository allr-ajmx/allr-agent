//! The client-authentication ladder.
//!
//! New work — the Electron desktop app ran the system `ssh` with
//! `BatchMode=yes`, which meant it could never prompt: a passphrase-protected
//! key that was not already in an agent was simply `auth-failed`, and the error
//! copy told the user to run `ssh-add` first. Speaking SSH ourselves means we
//! can actually ask, so passphrase, password and keyboard-interactive auth all
//! become reachable.
//!
//! The ladder is driven by **what the server says it accepts**, not by a fixed
//! list of rungs. We open with a `none` request — the standard discovery move,
//! which OpenSSH makes too — and every subsequent failure refreshes the method
//! set from `AuthResult::Failure { remaining_methods }`. That is what stops a
//! publickey-only host from being shown a password box it can never honour, and
//! what makes the failure message able to say which methods were even on offer.
//!
//! Rung order, matching OpenSSH's own preference. **publickey** comes first, in
//! three flavours tried in turn:
//!
//! 1. **ssh-agent** — desktop only in practice. Android is `cfg(unix)` so this
//!    compiles there, but `SSH_AUTH_SOCK` is unset, so it skips itself.
//! 2. **Key file** — an explicit `keyPath`, then `IdentityFile` from
//!    `~/.ssh/config`, then the conventional `~/.ssh/id_*` names.
//! 3. **Pasted key** — a PEM held in the OS keyring. The mobile path: there is
//!    no usable file picker for a private key on Android or iOS.
//!
//! Then **keyboard-interactive**, deliberately BEFORE `password`: a PAM host
//! commonly has `PasswordAuthentication no` with this left on, and it is then
//! the only way a password reaches the server at all. A stored password answers
//! the single hidden question automatically, so a saved credential works there
//! exactly as it does on a password host.
//!
//! Then **password**.
//!
//! Two things are load-bearing and easy to undo by accident:
//!
//! * **Every exchange is charged against a budget.** sshd's `MaxAuthTries`
//!   defaults to 6 and counts the `none` probe. Overrunning it gets the
//!   connection dropped mid-ladder, and the later rungs then fail with an opaque
//!   transport error rather than an auth one — which reads to the user as "the
//!   password I typed was never used".
//! * **A key is decoded with NO passphrase first.** `KeyIsEncrypted` is the only
//!   definitive signal that a key needs one; a wrong passphrase and a corrupt
//!   file are the same error otherwise. Passing a passphrase straight in — which
//!   this used to do, including the empty string a blank form field produced —
//!   turned "needs a passphrase" into "unreadable" and dropped the key in
//!   silence.

use std::path::Path;

use russh::client::{Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{client::AuthResult, MethodKind, MethodSet};

use super::error::{SshError, SshErrorKind};
use super::prompt::{PromptKind, Prompter};
use super::session::SshHandler;

/// Conventional private-key names, in the order OpenSSH itself prefers.
const DEFAULT_KEY_NAMES: [&str; 4] = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

/// How many authentication requests we may send. sshd's `MaxAuthTries` defaults
/// to 6 and counts the opening `none` probe, so this is the server's ceiling,
/// not a preference — going past it gets the connection dropped rather than
/// merely refused.
const MAX_AUTH_ATTEMPTS: usize = 6;

/// How many agent identities we may offer. An agent holding a dozen keys would
/// otherwise spend the whole budget before a key file or a password is ever
/// tried. OpenSSH has the same ceiling for the same reason.
const MAX_AGENT_IDENTITIES: usize = 3;

/// A cap on keyboard-interactive rounds. The protocol lets a server send any
/// number of info requests, including empty ones; without this a hostile or
/// broken server could keep the exchange going forever.
const MAX_KI_ROUNDS: usize = 16;

/// Drop a value that is present but blank.
///
/// The form sends `""` for an untouched secret row, and `Some("")` is not the
/// same thing as `None` anywhere downstream: an empty passphrase makes russh
/// attempt a decrypt instead of reporting `KeyIsEncrypted`, and an empty
/// password makes us offer a credential the server will refuse. Normalize once,
/// at the boundary.
pub fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Credentials the caller has up front. Everything here is optional; whatever is
/// missing is either prompted for or skipped.
#[derive(Default, Clone)]
pub struct Credentials {
    /// An explicit private-key file, from the settings form.
    pub key_path: Option<String>,
    /// `IdentityFile` as resolved from `~/.ssh/config`.
    pub identity_file: Option<String>,
    /// A PEM pasted by the user, held in the keyring. Never written to disk.
    pub private_key_pem: Option<String>,
    pub passphrase: Option<String>,
    pub password: Option<String>,
}

impl Credentials {
    /// True when nothing here could satisfy a server without prompting. Used to
    /// decide whether a non-interactive context (boot restore) can even try.
    pub fn is_empty(&self) -> bool {
        self.key_path.is_none()
            && self.identity_file.is_none()
            && self.private_key_pem.is_none()
            && self.password.is_none()
    }
}

/// Which rung succeeded. Reported so the UI can say how it got in, and so a
/// reconnect can favour the same route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethodUsed {
    /// The server asked for nothing at all.
    None,
    Agent,
    KeyFile,
    PastedKey,
    Password,
    KeyboardInteractive,
}

/// A private-key file we may try.
///
/// `explicit` separates a path the user (or their `~/.ssh/config`) actually
/// named from one of the four conventional names we guess at. The distinction
/// decides two things: whether a missing file is worth reporting, and whether it
/// is worth raising a passphrase prompt for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCandidate {
    pub path: String,
    pub explicit: bool,
}

/// Candidate key files, in preference order, deduplicated.
///
/// Explicit beats config beats convention. An explicit path that does not exist
/// is still returned: failing with "that key is not there" is far better than
/// silently authenticating as somebody else via a default key.
///
/// `~` is expanded here rather than at the form, because this is the last point
/// before the path reaches `std::fs`. The settings row's own placeholder is
/// `~/.ssh/id_ed25519`, so a tilde path is the expected input, not an edge case.
pub fn key_file_candidates(creds: &Credentials, home: Option<&Path>) -> Vec<KeyCandidate> {
    let mut out: Vec<KeyCandidate> = Vec::new();

    let mut push = |value: Option<String>, explicit: bool| {
        let Some(raw) = value.filter(|v: &String| !v.trim().is_empty()) else {
            return;
        };

        let path = super::config::expand_tilde(raw.trim(), home);

        if !out.iter().any(|c| c.path == path) {
            out.push(KeyCandidate { path, explicit });
        }
    };

    push(creds.key_path.clone(), true);
    push(creds.identity_file.clone(), true);

    if let Some(home) = home {
        for name in DEFAULT_KEY_NAMES {
            push(
                Some(home.join(".ssh").join(name).display().to_string()),
                false,
            );
        }
    }

    out
}

/// Passphrases we already hold, so one answer opens every key it fits.
///
/// Without this, a prompt was raised per candidate — and with four conventional
/// names behind the one the user named, that is a prompt storm.
#[derive(Default)]
struct Passphrases {
    known: Vec<String>,
}

impl Passphrases {
    fn seed(initial: Option<&str>) -> Self {
        Self {
            known: initial
                .filter(|p| !p.is_empty())
                .map(|p| vec![p.to_string()])
                .unwrap_or_default(),
        }
    }

    fn remember(&mut self, value: String) {
        if !value.is_empty() && !self.known.contains(&value) {
            self.known.push(value);
        }
    }
}

/// What came of trying to open one key.
enum KeyOutcome {
    Loaded(Box<PrivateKey>),
    /// Not there, and unremarkably so — a conventional name that does not exist.
    Absent,
    /// There, but unusable. Recorded and reported: a key the user named and we
    /// could not read is the single most useful thing a failure can say, and
    /// swallowing it is what made a supplied key look like it was ignored.
    Unreadable(String),
}

/// Decode a private key, prompting for a passphrase only when one is genuinely
/// needed and nothing we already hold fits.
///
/// The no-passphrase probe first is the whole point — see the module note. It is
/// also why a wrong stored passphrase now leads to a prompt instead of to a key
/// that vanishes without comment.
async fn decode_key(
    secret: &str,
    label: &str,
    may_prompt: bool,
    passphrases: &mut Passphrases,
    prompter: &dyn Prompter,
) -> Result<KeyOutcome, SshError> {
    match russh::keys::decode_secret_key(secret, None) {
        Ok(key) => return Ok(KeyOutcome::Loaded(Box::new(key))),
        Err(russh::keys::Error::KeyIsEncrypted) => {}
        Err(err) => {
            return Ok(KeyOutcome::Unreadable(format!(
                "{label} is not a private key we can read: {err}"
            )))
        }
    }

    // Encrypted. Spend what we already have before asking the user for anything.
    for passphrase in passphrases.known.clone() {
        if let Ok(key) = russh::keys::decode_secret_key(secret, Some(&passphrase)) {
            return Ok(KeyOutcome::Loaded(Box::new(key)));
        }
    }

    if !may_prompt {
        return Ok(KeyOutcome::Absent);
    }

    let answer = match prompter
        .prompt(
            PromptKind::Passphrase,
            &format!("Passphrase for {label}"),
            true,
        )
        .await
    {
        Ok(answer) => answer,
        // A dismissal is a decision and stops the whole attempt. Anything else
        // — most often no prompter at all, which is every boot restore — just
        // means this key cannot be opened from here.
        Err(err) if err.kind == SshErrorKind::Cancelled => return Err(err),
        Err(_) => {
            return Ok(KeyOutcome::Unreadable(format!(
                "{label} is encrypted and no passphrase was available"
            )))
        }
    };

    match russh::keys::decode_secret_key(secret, Some(&answer)) {
        Ok(key) => {
            passphrases.remember(answer);

            Ok(KeyOutcome::Loaded(Box::new(key)))
        }

        Err(err) => Ok(KeyOutcome::Unreadable(format!(
            "{label} could not be decrypted: {err}"
        ))),
    }
}

/// Read and decode one candidate key file.
///
/// The file is read here rather than through `russh::keys::load_secret_key` so a
/// missing file can be told apart from an unreadable one. That distinction is
/// the difference between "your `~/.ssh/id_dsa` does not exist", which nobody
/// needs to hear, and "the key you named is not there", which is the answer.
async fn load_key(
    candidate: &KeyCandidate,
    passphrases: &mut Passphrases,
    prompter: &dyn Prompter,
) -> Result<KeyOutcome, SshError> {
    let path = candidate.path.as_str();

    let secret = match std::fs::read_to_string(path) {
        Ok(secret) => secret,

        Err(err) => {
            let unremarkable = !candidate.explicit && err.kind() == std::io::ErrorKind::NotFound;

            return Ok(if unremarkable {
                KeyOutcome::Absent
            } else {
                KeyOutcome::Unreadable(format!("{path} could not be opened: {err}"))
            });
        }
    };

    decode_key(&secret, path, candidate.explicit, passphrases, prompter).await
}

/// The state of one walk down the ladder.
///
/// Holds the server's own view of what it accepts, what we have spent against
/// its attempt limit, and enough of a record to explain a failure in terms of
/// what actually happened.
struct Ladder {
    /// What the server says it will still accept. Refreshed from every failure.
    offered: MethodSet,
    /// True when the server told us nothing and we are guessing — see
    /// `run_ladder`. Suppresses claims about what was "offered".
    blind: bool,
    spent: usize,
    exhausted: bool,
    attempted: Vec<String>,
    /// Things worth saying that are not themselves attempts: an unreadable key,
    /// a truncated agent list, an absent password.
    notes: Vec<String>,
}

impl Ladder {
    fn new() -> Self {
        Self {
            offered: MethodSet::empty(),
            blind: false,
            spent: 0,
            exhausted: false,
            attempted: Vec::new(),
            notes: Vec::new(),
        }
    }

    fn offers(&self, method: MethodKind) -> bool {
        self.offered.contains(&method)
    }

    /// Take one attempt from the budget. False means there is none left, and the
    /// caller must stop rather than send a request the server will answer by
    /// hanging up.
    fn charge(&mut self) -> bool {
        if self.spent >= MAX_AUTH_ATTEMPTS {
            self.exhausted = true;

            return false;
        }

        self.spent += 1;

        true
    }

    /// Fold one exchange's result in, and report whether it got us in.
    fn record(&mut self, what: &str, result: AuthResult) -> bool {
        if !self.attempted.iter().any(|a| a == what) {
            self.attempted.push(what.to_string());
        }

        self.absorb(result)
    }

    /// Take the method list off a result without counting it as an attempt the
    /// user chose. The opening `none` probe is discovery, not a credential —
    /// listing it would have every failure open with "Tried: none".
    fn absorb(&mut self, result: AuthResult) -> bool {
        match result {
            AuthResult::Success => true,

            // `partial_success` is deliberately not special-cased: the server
            // has told us what it wants next in `remaining_methods`, and
            // continuing down the ladder is exactly the right response.
            AuthResult::Failure {
                remaining_methods, ..
            } => {
                self.offered = remaining_methods;

                false
            }
        }
    }

    fn note(&mut self, note: impl Into<String>) {
        let note = note.into();

        if !self.notes.iter().any(|n| n == &note) {
            self.notes.push(note);
        }
    }
}

fn transport_failed(what: &str, err: russh::Error) -> SshError {
    SshError::new(
        SshErrorKind::AuthFailed,
        format!("{what} failed on the wire: {err}"),
    )
}

/// Try one private key against the server.
async fn try_key(
    handle: &mut Handle<SshHandler>,
    user: &str,
    key: PrivateKey,
) -> Result<AuthResult, SshError> {
    // RSA keys must be signed with a hash the server actually accepts: SHA-1
    // RSA is rejected outright by any current OpenSSH, so ask the server which
    // it wants rather than guessing. Non-RSA keys ignore this.
    let hash_alg = best_rsa_hash(handle, &key).await;

    let with_hash = PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), hash_alg);

    handle
        .authenticate_publickey(user, with_hash)
        .await
        .map_err(|e| transport_failed("public-key authentication", e))
}

/// Ask the server which RSA signature hash it supports, defaulting to SHA-512.
async fn best_rsa_hash(handle: &Handle<SshHandler>, key: &PrivateKey) -> Option<HashAlg> {
    if !matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
        return None;
    }

    handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .unwrap_or(Some(HashAlg::Sha512))
}

/// The password to try, from the caller or from a prompt.
async fn resolve_password(
    creds: &Credentials,
    prompter: &dyn Prompter,
) -> Result<Option<String>, SshError> {
    if let Some(p) = creds.password.as_deref().filter(|p| !p.is_empty()) {
        return Ok(Some(p.to_string()));
    }

    match prompter
        .prompt(PromptKind::Password, "Password", true)
        .await
    {
        Ok(p) if !p.is_empty() => Ok(Some(p)),
        // A dismissal stops the attempt; anything else (no prompter — a boot
        // restore) simply means this rung is skipped.
        Err(err) if err.kind == SshErrorKind::Cancelled => Err(err),
        _ => Ok(None),
    }
}

/// Compose the label a keyboard-interactive question is shown under.
///
/// The server supplies up to three pieces — a name, free-text instructions and
/// the question itself — and any of them can be empty. Showing a bare empty
/// string, which some PAM stacks send as the prompt, would be a dialog with no
/// question in it.
fn ki_label(name: &str, instructions: &str, prompt: &str) -> String {
    let mut label = String::new();

    for part in [name.trim(), instructions.trim(), prompt.trim()] {
        if part.is_empty() {
            continue;
        }

        if !label.is_empty() {
            label.push_str(" — ");
        }

        label.push_str(part);
    }

    if label.is_empty() {
        "Password".to_string()
    } else {
        label
    }
}

/// Run the keyboard-interactive exchange.
///
/// The whole exchange is ONE authentication attempt as far as the server's
/// counter is concerned, however many info requests it contains — so the caller
/// charges once, not per round.
async fn try_keyboard_interactive(
    handle: &mut Handle<SshHandler>,
    user: &str,
    creds: &Credentials,
    prompter: &dyn Prompter,
    ladder: &mut Ladder,
) -> Result<bool, SshError> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|e| transport_failed("keyboard-interactive authentication", e))?;

    let stored = creds.password.as_deref().filter(|p| !p.is_empty());
    let mut offered_stored = false;

    for _ in 0..MAX_KI_ROUNDS {
        match response {
            KeyboardInteractiveAuthResponse::Success => {
                ladder.record("keyboard-interactive", AuthResult::Success);

                return Ok(true);
            }

            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => {
                ladder.record(
                    "keyboard-interactive",
                    AuthResult::Failure {
                        remaining_methods,
                        partial_success,
                    },
                );

                return Ok(false);
            }

            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // Exactly one hidden question IS the password question. Answering
                // it from the stored password is what makes a saved credential
                // work on a PAM host, where `password` auth is commonly off and
                // this is the only route in. Offered once: a second identical
                // request means it was wrong, and we should ask instead of
                // resubmitting it forever.
                let single_secret = prompts.len() == 1 && prompts.first().is_some_and(|p| !p.echo);
                let mut answers = Vec::with_capacity(prompts.len());

                for prompt in &prompts {
                    if single_secret && !offered_stored {
                        if let Some(password) = stored {
                            offered_stored = true;
                            answers.push(password.to_string());

                            continue;
                        }
                    }

                    let label = ki_label(&name, &instructions, &prompt.prompt);

                    match prompter
                        .prompt(PromptKind::KeyboardInteractive, &label, !prompt.echo)
                        .await
                    {
                        Ok(answer) => answers.push(answer),
                        Err(err) if err.kind == SshErrorKind::Cancelled => return Err(err),
                        // Nothing can answer. Send a blank rather than abandoning
                        // the exchange half-open, and let the server end it.
                        Err(_) => answers.push(String::new()),
                    }
                }

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| transport_failed("keyboard-interactive authentication", e))?;
            }
        }
    }

    ladder.note("the keyboard-interactive exchange did not terminate");

    Ok(false)
}

/// Try every identity the agent holds, up to the budget.
#[cfg(unix)]
async fn try_agent(
    handle: &mut Handle<SshHandler>,
    user: &str,
    ladder: &mut Ladder,
) -> Result<bool, SshError> {
    use russh::keys::agent::client::AgentClient;

    // No SSH_AUTH_SOCK, or nothing listening on it: this rung does not exist.
    // Unavailable is not failure — on mobile there is no agent at all, and on
    // desktop the user may simply not run one.
    let Ok(mut agent) = AgentClient::connect_env().await else {
        return Ok(false);
    };

    let Ok(identities) = agent.request_identities().await else {
        return Ok(false);
    };

    if identities.len() > MAX_AGENT_IDENTITIES {
        ladder.note(format!(
            "your ssh-agent holds {} keys; only the first {MAX_AGENT_IDENTITIES} were offered, \
             because the server allows {MAX_AUTH_ATTEMPTS} attempts in total",
            identities.len()
        ));
    }

    for identity in identities.into_iter().take(MAX_AGENT_IDENTITIES) {
        let public: PublicKey = match &identity {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.clone(),
            // Certificates are a different auth shape; not supported yet.
            _ => continue,
        };

        if !ladder.offers(MethodKind::PublicKey) || !ladder.charge() {
            break;
        }

        let hash_alg = if matches!(public.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
            handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .unwrap_or(Some(HashAlg::Sha512))
        } else {
            None
        };

        match handle
            .authenticate_publickey_with(user, public, hash_alg, &mut agent)
            .await
        {
            Ok(result) => {
                if ladder.record("ssh-agent", result) {
                    return Ok(true);
                }
            }

            // The agent or the transport gave up. Neither is evidence about the
            // remaining rungs, so stop offering keys and let them run.
            Err(_) => break,
        }
    }

    Ok(false)
}

/// Windows OpenSSH exposes its agent over a named pipe rather than
/// `SSH_AUTH_SOCK`; russh's agent client does not cover that here, so the rung
/// is absent rather than broken.
#[cfg(not(unix))]
async fn try_agent(
    _handle: &mut Handle<SshHandler>,
    _user: &str,
    _ladder: &mut Ladder,
) -> Result<bool, SshError> {
    Ok(false)
}

/// Walk the ladder. Returns which rung got in, or an `AuthFailed` naming what
/// was tried — a bare "authentication failed" is not actionable.
pub async fn authenticate(
    handle: &mut Handle<SshHandler>,
    user: &str,
    creds: &Credentials,
    home: Option<&Path>,
    prompter: &dyn Prompter,
) -> Result<AuthMethodUsed, SshError> {
    let mut ladder = Ladder::new();

    match run_ladder(handle, user, creds, home, prompter, &mut ladder).await? {
        Some(method) => Ok(method),

        None => Err(SshError::new(
            SshErrorKind::AuthFailed,
            auth_failure_message(user, &ladder),
        )),
    }
}

/// The ladder proper. `Ok(None)` means it ran out of rungs; the caller turns
/// that into a message from what `ladder` recorded.
async fn run_ladder(
    handle: &mut Handle<SshHandler>,
    user: &str,
    creds: &Credentials,
    home: Option<&Path>,
    prompter: &dyn Prompter,
    ladder: &mut Ladder,
) -> Result<Option<AuthMethodUsed>, SshError> {
    // 0. Ask the server what it accepts. `none` is answered with the method
    //    list, and just occasionally succeeds outright. Charged like any other
    //    request, because sshd counts it against MaxAuthTries.
    if !ladder.charge() {
        return Ok(None);
    }

    let probe = handle
        .authenticate_none(user)
        .await
        .map_err(|e| transport_failed("authentication", e))?;

    if ladder.absorb(probe) {
        return Ok(Some(AuthMethodUsed::None));
    }

    // A server that named no methods has not told us "nothing works" — that is
    // also what russh reports for a connection that dropped during the probe.
    // Assume everything is on the table rather than skipping every rung on no
    // evidence, and remember that we are guessing so the failure copy does not
    // claim otherwise.
    if ladder.offered.is_empty() {
        ladder.offered = MethodSet::all();
        ladder.offered.remove(MethodKind::None);
        ladder.blind = true;
    }

    // 1. publickey: the agent, then key files, then a PEM from the keyring.
    if ladder.offers(MethodKind::PublicKey) {
        if try_agent(handle, user, ladder).await? {
            return Ok(Some(AuthMethodUsed::Agent));
        }

        let mut passphrases = Passphrases::seed(creds.passphrase.as_deref());

        for candidate in key_file_candidates(creds, home) {
            // The server can withdraw publickey mid-ladder (and does, once it
            // has had enough), so re-check rather than burning the budget.
            if !ladder.offers(MethodKind::PublicKey) {
                break;
            }

            match load_key(&candidate, &mut passphrases, prompter).await? {
                KeyOutcome::Loaded(key) => {
                    if !ladder.charge() {
                        return Ok(None);
                    }

                    let result = try_key(handle, user, *key).await?;

                    if ladder.record("key file", result) {
                        return Ok(Some(AuthMethodUsed::KeyFile));
                    }
                }

                // Not there and not worth mentioning.
                KeyOutcome::Absent => {}

                // Recorded rather than swallowed, and NOT fatal: one unreadable
                // candidate must not end the walk, or a stale ~/.ssh/config
                // IdentityFile would block every key behind it.
                KeyOutcome::Unreadable(reason) => ladder.note(reason),
            }
        }

        if let Some(pem) = creds
            .private_key_pem
            .as_deref()
            .filter(|p| !p.trim().is_empty())
        {
            if ladder.offers(MethodKind::PublicKey) {
                match decode_key(pem, "the stored key", true, &mut passphrases, prompter).await? {
                    KeyOutcome::Loaded(key) => {
                        if !ladder.charge() {
                            return Ok(None);
                        }

                        let result = try_key(handle, user, *key).await?;

                        if ladder.record("stored key", result) {
                            return Ok(Some(AuthMethodUsed::PastedKey));
                        }
                    }

                    KeyOutcome::Absent => {}
                    KeyOutcome::Unreadable(reason) => ladder.note(reason),
                }
            }
        }
    }

    // 2. keyboard-interactive, BEFORE password: a PAM host commonly has
    //    `PasswordAuthentication no` with this left on, and it is then the only
    //    way a password reaches the server at all.
    if ladder.offers(MethodKind::KeyboardInteractive) {
        if !ladder.charge() {
            return Ok(None);
        }

        if try_keyboard_interactive(handle, user, creds, prompter, ladder).await? {
            return Ok(Some(AuthMethodUsed::KeyboardInteractive));
        }
    }

    // 3. Password — only when the server actually offers it. Prompting here for
    //    a publickey-only host asks the user for a credential that cannot work,
    //    and then spends an attempt proving it.
    if ladder.offers(MethodKind::Password) {
        match resolve_password(creds, prompter).await? {
            Some(password) => {
                if !ladder.charge() {
                    return Ok(None);
                }

                let result = handle
                    .authenticate_password(user, password)
                    .await
                    .map_err(|e| transport_failed("password authentication", e))?;

                if ladder.record("password", result) {
                    return Ok(Some(AuthMethodUsed::Password));
                }
            }

            None => ladder.note("no password was available to try"),
        }
    }

    Ok(None)
}

/// Explain a failed ladder in terms of what it actually did.
///
/// Three things have to survive into the copy, because each of them sent users
/// hunting in the wrong place when it did not:
///
///   * **What the server offers.** "Tried: key file" reads as "your key is
///     wrong" when the real story is that the host only takes passwords.
///   * **Why a rung was skipped.** A password that was never available, or a key
///     file that could not be read, is not the same as one that was refused.
///   * **Running out of attempts.** Past `MaxAuthTries` the server hangs up, and
///     the remaining rungs then fail for reasons that have nothing to do with
///     the credentials.
fn auth_failure_message(user: &str, ladder: &Ladder) -> String {
    let tried = if ladder.attempted.is_empty() {
        "nothing available".to_string()
    } else {
        ladder.attempted.join(", ")
    };

    let mut message = format!("SSH authentication as {user} failed. Tried: {tried}.");

    if !ladder.blind {
        let offered: Vec<&str> = ladder.offered.iter().map(|m| m.into()).collect();

        if offered.is_empty() {
            message.push_str(" The server offered no further methods.");
        } else {
            message.push_str(&format!(" The server accepts: {}.", offered.join(", ")));
        }
    }

    for note in &ladder.notes {
        message.push_str(&format!(" {note}."));
    }

    if ladder.exhausted {
        message.push_str(&format!(
            " The server's limit of {MAX_AUTH_ATTEMPTS} authentication attempts was reached, so \
             any remaining method went untried."
        ));
    }

    message.push_str(
        " Add the key to your ssh-agent, set an IdentityFile in ~/.ssh/config, or set a private \
         key or password in Settings.",
    );

    message
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/u")
    }

    fn paths(candidates: &[KeyCandidate]) -> Vec<&str> {
        candidates.iter().map(|c| c.path.as_str()).collect()
    }

    #[test]
    fn an_explicit_key_path_is_tilde_expanded() {
        // The settings row's placeholder IS `~/.ssh/id_ed25519`, so this is the
        // expected input. Unexpanded it reached std::fs verbatim, failed to open,
        // and was dropped in silence — which is what made a supplied key look
        // ignored and sent the ladder on to a password prompt.
        let creds = Credentials {
            key_path: Some("~/.ssh/id_ed25519".into()),
            ..Default::default()
        };

        let out = key_file_candidates(&creds, Some(&home()));
        assert_eq!(out[0].path, "/home/u/.ssh/id_ed25519");
        assert!(out[0].explicit);
    }

    #[test]
    fn candidates_prefer_explicit_then_config_then_convention() {
        let creds = Credentials {
            key_path: Some("/keys/explicit".into()),
            identity_file: Some("/keys/from-config".into()),
            ..Default::default()
        };

        let out = key_file_candidates(&creds, Some(&home()));
        assert_eq!(paths(&out)[0], "/keys/explicit");
        assert_eq!(paths(&out)[1], "/keys/from-config");
        assert_eq!(
            paths(&out)[2],
            "/home/u/.ssh/id_ed25519",
            "ed25519 before rsa, as OpenSSH prefers"
        );

        // Only what the user (or their config) named may raise a passphrase
        // prompt; the four guesses must not, or one connect becomes five dialogs.
        assert!(out[0].explicit && out[1].explicit);
        assert!(out[2..].iter().all(|c| !c.explicit));
    }

    #[test]
    fn candidates_are_deduplicated_after_expansion() {
        // The settings form and ~/.ssh/config commonly name the same file, and
        // may spell it differently. Trying it twice burns an attempt against the
        // server's MaxAuthTries.
        let creds = Credentials {
            key_path: Some("~/.ssh/id_ed25519".into()),
            identity_file: Some("/home/u/.ssh/id_ed25519".into()),
            ..Default::default()
        };

        let out = key_file_candidates(&creds, Some(&home()));
        assert_eq!(
            out.iter()
                .filter(|c| c.path == "/home/u/.ssh/id_ed25519")
                .count(),
            1,
            "{:?}",
            paths(&out)
        );
    }

    #[test]
    fn candidates_ignore_blank_values() {
        let creds = Credentials {
            key_path: Some("   ".into()),
            identity_file: Some(String::new()),
            ..Default::default()
        };
        assert!(key_file_candidates(&creds, None).is_empty());
    }

    #[test]
    fn candidates_without_a_home_yield_only_explicit_paths() {
        // Mobile: no ~/.ssh to fall back on, so nothing is invented.
        let creds = Credentials {
            key_path: Some("/keys/explicit".into()),
            ..Default::default()
        };
        assert_eq!(
            paths(&key_file_candidates(&creds, None)),
            vec!["/keys/explicit"]
        );
        assert!(key_file_candidates(&Credentials::default(), None).is_empty());
    }

    #[test]
    fn a_blank_secret_is_normalized_away() {
        // The form sends "" for an untouched row. Some("") made russh attempt a
        // decrypt instead of reporting KeyIsEncrypted, so an encrypted key was
        // reported unreadable and dropped without ever raising a prompt.
        assert_eq!(nonempty(Some(String::new())), None);
        assert_eq!(nonempty(Some("   ".into())), None);
        assert_eq!(nonempty(Some("hunter2".into())), Some("hunter2".into()));
        assert_eq!(nonempty(None), None);
    }

    #[test]
    fn one_passphrase_answer_serves_every_candidate() {
        let mut seeded = Passphrases::seed(Some("from-settings"));
        assert_eq!(seeded.known, vec!["from-settings"]);

        seeded.remember("typed".into());
        seeded.remember("typed".into());
        assert_eq!(seeded.known, vec!["from-settings", "typed"]);

        // An empty stored passphrase is not a passphrase.
        assert!(Passphrases::seed(Some("")).known.is_empty());
        assert!(Passphrases::seed(None).known.is_empty());
    }

    #[test]
    fn the_budget_matches_the_servers_own_limit() {
        let mut ladder = Ladder::new();

        for _ in 0..MAX_AUTH_ATTEMPTS {
            assert!(ladder.charge());
        }

        assert!(!ladder.charge(), "must stop at the server's MaxAuthTries");
        assert!(ladder.exhausted);
        // Agent identities are the main consumer and must not be able to spend
        // the whole budget on their own.
        assert!(MAX_AGENT_IDENTITIES < MAX_AUTH_ATTEMPTS);
    }

    #[test]
    fn a_failure_refreshes_what_the_server_still_accepts() {
        let mut ladder = Ladder::new();

        let got_in = ladder.record(
            "key file",
            AuthResult::Failure {
                remaining_methods: MethodSet::from(&[MethodKind::Password][..]),
                partial_success: false,
            },
        );

        assert!(!got_in);
        assert!(ladder.offers(MethodKind::Password));
        // The whole point: a host that no longer offers publickey must not be
        // handed another key, and one that never offered password must never be
        // shown a password box.
        assert!(!ladder.offers(MethodKind::PublicKey));
    }

    #[test]
    fn the_failure_message_names_what_the_server_accepts() {
        let mut ladder = Ladder::new();
        ladder.record(
            "key file",
            AuthResult::Failure {
                remaining_methods: MethodSet::from(&[MethodKind::Password][..]),
                partial_success: false,
            },
        );
        ladder.note("no password was available to try");

        let message = auth_failure_message("xm", &ladder);

        assert!(message.contains("Tried: key file."), "{message}");
        assert!(
            message.contains("The server accepts: password."),
            "{message}"
        );
        assert!(message.contains("no password was available"), "{message}");
    }

    #[test]
    fn the_failure_message_says_when_the_attempt_limit_was_hit() {
        // Past MaxAuthTries the server hangs up, and every later rung fails for
        // reasons that have nothing to do with the credentials. Saying so is the
        // difference between "my password was ignored" and the truth.
        let mut ladder = Ladder::new();

        while ladder.charge() {}

        let message = auth_failure_message("xm", &ladder);
        assert!(
            message.contains("limit of 6 authentication attempts"),
            "{message}"
        );
    }

    #[test]
    fn a_silent_server_leaves_us_guessing_rather_than_skipping_everything() {
        // russh reports an empty method set both for "told us nothing" and for a
        // connection that dropped. Skipping every rung on that would be worse
        // than trying, so `blind` suppresses any claim about what is on offer.
        let mut ladder = Ladder::new();
        ladder.blind = true;

        let message = auth_failure_message("xm", &ladder);
        assert!(!message.contains("The server accepts"), "{message}");
        assert!(!message.contains("offered no further methods"), "{message}");
    }

    #[test]
    fn is_empty_reflects_whether_a_silent_connect_is_possible() {
        // Drives whether a boot restore may even attempt the dial.
        assert!(Credentials::default().is_empty());
        assert!(!Credentials {
            key_path: Some("/k".into()),
            ..Default::default()
        }
        .is_empty());
        assert!(!Credentials {
            private_key_pem: Some("pem".into()),
            ..Default::default()
        }
        .is_empty());
        assert!(!Credentials {
            password: Some("pw".into()),
            ..Default::default()
        }
        .is_empty());
        // A passphrase alone unlocks nothing — there is no key for it to open.
        assert!(Credentials {
            passphrase: Some("pp".into()),
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn a_keyboard_interactive_label_never_comes_out_empty() {
        // Some PAM stacks send an empty prompt string; a dialog with no question
        // in it is not answerable.
        assert_eq!(ki_label("", "", ""), "Password");
        assert_eq!(ki_label("", "", "Password: "), "Password:");
        assert_eq!(
            ki_label("PAM", "Enter your code", "Verification code:"),
            "PAM — Enter your code — Verification code:"
        );
    }
}
