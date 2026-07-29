//! OpenSSH client-config reading.
//!
//! Ported from `apps/desktop/electron/ssh-config.ts`, but doing strictly more
//! work: desktop only listed `Host` aliases here and shelled out to `ssh -G` for
//! the actual resolution. We have no `ssh` binary, so resolution is ours.
//!
//! Scope, stated plainly because a *silent* divergence from the user's own `ssh`
//! would be a nasty failure mode:
//!   - Supported: `Host` patterns (`*`, `?`, negation), first-value-wins per
//!     keyword, `Include` (glob-free, depth-capped, cycle-safe), `~` expansion,
//!     and the HostName/User/Port/IdentityFile/ProxyJump/ProxyCommand keywords.
//!   - NOT supported: `Match` blocks and `CanonicalizeHostname`. Both are
//!     reported through `unsupported` so the UI can say so out loud rather than
//!     resolving differently from `ssh` behind the user's back.
//!   - `ProxyJump`/`ProxyCommand` are parsed but not honoured yet; the caller
//!     must refuse to connect rather than ignore them and reach a different host.
//!
//! On mobile there is no `~/.ssh` at all: every reader here treats a missing file
//! as "no config", never as an error.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// How deep `Include` may nest before we stop. Matches desktop's cap.
const MAX_INCLUDE_DEPTH: u32 = 8;

/// The subset of a resolved `Host` block that we act on.
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Present when the matched host routes through a jump host. Not honoured
    /// yet — the caller must fail rather than silently connect direct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_jump: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_command: Option<String>,
    /// Directives we saw but do not implement, for the UI to surface verbatim.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unsupported: Vec<String>,
}

impl ResolvedHost {
    /// True when connecting would reach somewhere other than what this config
    /// describes. The caller must refuse rather than ignore it.
    pub fn requires_unsupported_proxy(&self) -> bool {
        self.proxy_jump.is_some() || self.proxy_command.is_some()
    }
}

/// One `Host <patterns>` block and the keywords under it.
#[derive(Debug, Clone)]
struct HostBlock {
    patterns: Vec<String>,
    entries: Vec<(String, String)>,
}

/// Split a config line into `keyword`, `value`. OpenSSH accepts both
/// `Key value` and `Key=value`, and the keyword is case-insensitive.
fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();

    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    let (key, value) = match line.find(['=', ' ', '\t']) {
        Some(at) => (&line[..at], line[at + 1..].trim_start_matches(['=', ' ', '\t'])),
        None => return None,
    };

    let value = value.trim();

    if key.is_empty() || value.is_empty() {
        return None;
    }

    Some((key.to_ascii_lowercase(), value.to_string()))
}

/// Parse one file's text into blocks. Directives before any `Host` line belong
/// to an implicit block matching everything, which is how OpenSSH treats them.
fn parse_blocks(text: &str) -> Vec<HostBlock> {
    let mut blocks: Vec<HostBlock> = Vec::new();
    let mut current = HostBlock { patterns: vec!["*".to_string()], entries: Vec::new() };

    for raw in text.lines() {
        let Some((key, value)) = split_directive(raw) else {
            continue;
        };

        if key == "host" {
            blocks.push(current);
            current =
                HostBlock { patterns: value.split_whitespace().map(str::to_string).collect(), entries: Vec::new() };
            continue;
        }

        current.entries.push((key, value));
    }

    blocks.push(current);
    blocks
}

/// OpenSSH `Host` pattern matching: `*` (any run), `?` (one char), and a leading
/// `!` for negation (handled by the caller).
fn pattern_matches(pattern: &str, host: &str) -> bool {
    glob_matches(pattern.as_bytes(), host.as_bytes())
}

fn glob_matches(pattern: &[u8], value: &[u8]) -> bool {
    // Iterative backtracking rather than recursion: a pathological pattern like
    // `*a*a*a*...` from a hand-written config should not blow the stack.
    let (mut p, mut v) = (0usize, 0usize);
    let (mut star, mut resume) = (None, 0usize);

    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            resume = v;
            p += 1;
        } else if let Some(s) = star {
            // Backtrack: let the last `*` swallow one more character.
            p = s + 1;
            resume += 1;
            v = resume;
        } else {
            return false;
        }
    }

    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }

    p == pattern.len()
}

/// Does this block apply to `host`? A negated pattern that matches vetoes the
/// whole block, even if another pattern in the same block matched.
fn block_applies(block: &HostBlock, host: &str) -> bool {
    let mut matched = false;

    for pattern in &block.patterns {
        match pattern.strip_prefix('!') {
            Some(negated) if pattern_matches(negated, host) => return false,
            Some(_) => {}
            None if pattern_matches(pattern, host) => matched = true,
            None => {}
        }
    }

    matched
}

/// Expand a leading `~`. Returns the input unchanged when no home is known
/// (notably on mobile), rather than fabricating a path.
pub fn expand_tilde(path: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return path.to_string();
    };

    if path == "~" {
        return home.display().to_string();
    }

    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest).display().to_string(),
        None => path.to_string(),
    }
}

/// Resolve an `Include` token to a concrete path. Relative tokens are relative
/// to `~/.ssh`, per `ssh_config(5)`.
fn resolve_include(token: &str, home: Option<&Path>, ssh_dir: &Path) -> PathBuf {
    if token.starts_with("~/") || token == "~" {
        return PathBuf::from(expand_tilde(token, home));
    }

    let path = Path::new(token);

    if path.is_absolute() {
        path.to_path_buf()
    } else {
        ssh_dir.join(path)
    }
}

/// Reads a config file. A missing file is `None`, not an error — that is the
/// normal state on a fresh install and on every mobile device.
pub trait ConfigReader {
    fn read(&self, path: &Path) -> Option<String>;
}

/// Reads from the real filesystem.
pub struct FsConfigReader;

impl ConfigReader for FsConfigReader {
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

/// Walk the config graph from `root`, collecting every block in file order with
/// `Include`d files spliced in where the directive appeared.
fn collect_blocks(
    root: &Path,
    home: Option<&Path>,
    ssh_dir: &Path,
    reader: &dyn ConfigReader,
    depth: u32,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<HostBlock>,
) {
    if depth > MAX_INCLUDE_DEPTH || !visited.insert(root.to_path_buf()) {
        // Depth cap and cycle guard: `Include` can trivially be made circular,
        // and a config file is user-editable input.
        return;
    }

    let Some(text) = reader.read(root) else {
        return;
    };

    for block in parse_blocks(&text) {
        let includes: Vec<String> = block
            .entries
            .iter()
            .filter(|(k, _)| k == "include")
            .flat_map(|(_, v)| v.split_whitespace().map(str::to_string).collect::<Vec<_>>())
            .collect();

        out.push(block);

        for token in includes {
            let target = resolve_include(&token, home, ssh_dir);
            collect_blocks(&target, home, ssh_dir, reader, depth + 1, visited, out);
        }
    }
}

/// Every non-wildcard `Host` alias, in file order, deduplicated.
///
/// Wildcards and negations are skipped: they are rules, not hosts a user could
/// pick from a list. Ported from `ssh-config.ts:14-44`.
pub fn list_host_aliases(root: &Path, home: Option<&Path>, reader: &dyn ConfigReader) -> Vec<String> {
    let ssh_dir = ssh_dir_for(home);
    let mut blocks = Vec::new();
    collect_blocks(root, home, &ssh_dir, reader, 0, &mut HashSet::new(), &mut blocks);

    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for block in blocks {
        for pattern in block.patterns {
            if pattern.contains('*') || pattern.contains('?') || pattern.starts_with('!') {
                continue;
            }

            if seen.insert(pattern.clone()) {
                out.push(pattern);
            }
        }
    }

    out
}

/// Resolve the effective settings for `host`.
///
/// **First value wins**, per keyword, across the whole file graph — that is
/// OpenSSH's rule and it is the opposite of most config formats, so a later
/// `Host *` block cannot override an earlier specific one.
pub fn resolve_host(host: &str, root: &Path, home: Option<&Path>, reader: &dyn ConfigReader) -> ResolvedHost {
    let ssh_dir = ssh_dir_for(home);
    let mut blocks = Vec::new();
    collect_blocks(root, home, &ssh_dir, reader, 0, &mut HashSet::new(), &mut blocks);

    let mut out = ResolvedHost::default();
    let mut saw_match = false;

    for block in blocks.iter().filter(|b| block_applies(b, host)) {
        for (key, value) in &block.entries {
            match key.as_str() {
                "hostname" if out.hostname.is_none() => out.hostname = Some(value.clone()),
                "user" if out.user.is_none() => out.user = Some(value.clone()),
                "port" if out.port.is_none() => out.port = value.parse::<u16>().ok().filter(|p| *p > 0),
                "identityfile" if out.identity_file.is_none() => {
                    out.identity_file = Some(expand_tilde(value, home));
                }
                "proxyjump" if out.proxy_jump.is_none() => out.proxy_jump = Some(value.clone()),
                "proxycommand" if out.proxy_command.is_none() => out.proxy_command = Some(value.clone()),
                "match" | "canonicalizehostname" => saw_match = true,
                _ => {}
            }
        }
    }

    // `Match` can change any of the above, so its mere presence means our answer
    // may differ from `ssh`'s. Say so rather than quietly being wrong.
    if saw_match {
        out.unsupported.push("Match".to_string());
    }

    out
}

/// `~/.ssh`, or a relative fallback when no home is known.
fn ssh_dir_for(home: Option<&Path>) -> PathBuf {
    home.map_or_else(|| PathBuf::from(".ssh"), |h| h.join(".ssh"))
}

/// The default config location, or `None` on a platform with no home directory.
pub fn default_config_path(home: Option<&Path>) -> Option<PathBuf> {
    home.map(|h| h.join(".ssh").join("config"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// An in-memory filesystem so the parser tests touch no real files.
    struct MapReader(HashMap<PathBuf, String>);

    impl MapReader {
        fn new(files: &[(&str, &str)]) -> Self {
            Self(files.iter().map(|(p, t)| (PathBuf::from(p), (*t).to_string())).collect())
        }
    }

    impl ConfigReader for MapReader {
        fn read(&self, path: &Path) -> Option<String> {
            self.0.get(path).cloned()
        }
    }

    const HOME: &str = "/home/u";

    fn home() -> Option<&'static Path> {
        Some(Path::new(HOME))
    }

    fn resolve(files: &[(&str, &str)], host: &str) -> ResolvedHost {
        resolve_host(host, Path::new("/home/u/.ssh/config"), home(), &MapReader::new(files))
    }

    fn aliases(files: &[(&str, &str)]) -> Vec<String> {
        list_host_aliases(Path::new("/home/u/.ssh/config"), home(), &MapReader::new(files))
    }

    #[test]
    fn missing_config_is_empty_not_an_error() {
        // The normal state on a fresh install, and on every phone.
        assert!(aliases(&[]).is_empty());
        assert_eq!(resolve(&[], "box"), ResolvedHost::default());
    }

    #[test]
    fn lists_concrete_aliases_only() {
        let cfg = "Host alpha beta\n  User u\nHost *.internal\nHost !skip\nHost gam?a\nHost alpha\n";
        assert_eq!(aliases(&[("/home/u/.ssh/config", cfg)]), vec!["alpha", "beta"]);
    }

    #[test]
    fn resolves_the_documented_keywords() {
        let cfg = "Host box\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_box\n";
        let r = resolve(&[("/home/u/.ssh/config", cfg)], "box");
        assert_eq!(r.hostname.as_deref(), Some("10.0.0.5"));
        assert_eq!(r.user.as_deref(), Some("deploy"));
        assert_eq!(r.port, Some(2222));
        assert_eq!(r.identity_file.as_deref(), Some("/home/u/.ssh/id_box"), "~ must expand");
    }

    #[test]
    fn accepts_equals_and_mixed_case_keywords() {
        let cfg = "Host box\n  hostname=10.0.0.5\n  USER = deploy\n\tPort\t2222\n";
        let r = resolve(&[("/home/u/.ssh/config", cfg)], "box");
        assert_eq!(r.hostname.as_deref(), Some("10.0.0.5"));
        assert_eq!(r.user.as_deref(), Some("deploy"));
        assert_eq!(r.port, Some(2222));
    }

    #[test]
    fn first_value_wins_per_keyword() {
        // OpenSSH's rule, and the opposite of most config formats: a later
        // `Host *` must NOT override an earlier specific block.
        let cfg = "Host box\n  User specific\nHost *\n  User fallback\n  Port 2200\n";
        let r = resolve(&[("/home/u/.ssh/config", cfg)], "box");
        assert_eq!(r.user.as_deref(), Some("specific"));
        // ...but a keyword the specific block never set still falls through.
        assert_eq!(r.port, Some(2200));
    }

    #[test]
    fn directives_before_any_host_line_apply_to_everything() {
        let cfg = "User global\nHost box\n  Port 2222\n";
        assert_eq!(resolve(&[("/home/u/.ssh/config", cfg)], "box").user.as_deref(), Some("global"));
        assert_eq!(resolve(&[("/home/u/.ssh/config", cfg)], "other").user.as_deref(), Some("global"));
    }

    #[test]
    fn wildcard_and_question_patterns_match() {
        let cfg = "Host *.internal\n  User wild\nHost gam?a\n  User single\n";
        let files = [("/home/u/.ssh/config", cfg)];
        assert_eq!(resolve(&files, "web.internal").user.as_deref(), Some("wild"));
        assert_eq!(resolve(&files, "gamma").user.as_deref(), Some("single"));
        assert_eq!(resolve(&files, "gammma").user, None, "? matches exactly one char");
        assert_eq!(resolve(&files, "web.external").user, None);
    }

    #[test]
    fn negation_vetoes_the_whole_block() {
        let cfg = "Host *.internal !secret.internal\n  User wild\n";
        let files = [("/home/u/.ssh/config", cfg)];
        assert_eq!(resolve(&files, "web.internal").user.as_deref(), Some("wild"));
        assert_eq!(resolve(&files, "secret.internal").user, None, "negation must veto");
    }

    #[test]
    fn glob_backtracks_correctly() {
        assert!(pattern_matches("*", "anything"));
        assert!(pattern_matches("*.a.b", "x.y.a.b"));
        assert!(pattern_matches("a*b*c", "axxbyyc"));
        assert!(!pattern_matches("a*b*c", "axxbyy"));
        assert!(pattern_matches("*a", "aaa"));
        assert!(!pattern_matches("a?c", "ac"));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let cfg = "# a comment\n\n   \nHost box\n  # another\n  User deploy\n";
        assert_eq!(resolve(&[("/home/u/.ssh/config", cfg)], "box").user.as_deref(), Some("deploy"));
    }

    #[test]
    fn include_is_traversed_for_aliases_and_resolution() {
        let files = [
            ("/home/u/.ssh/config", "Include conf.d/extra\nHost local\n  User l\n"),
            ("/home/u/.ssh/conf.d/extra", "Host remote\n  User r\n  Port 2222\n"),
        ];
        assert_eq!(aliases(&files), vec!["remote", "local"], "included blocks splice in where the directive was");
        assert_eq!(resolve(&files, "remote").user.as_deref(), Some("r"));
        assert_eq!(resolve(&files, "local").user.as_deref(), Some("l"));
    }

    #[test]
    fn include_resolves_tilde_and_absolute_tokens() {
        let files = [
            ("/home/u/.ssh/config", "Include ~/other/inc\nInclude /etc/ssh/global\n"),
            ("/home/u/other/inc", "Host viatilde\n"),
            ("/etc/ssh/global", "Host viaabsolute\n"),
        ];
        assert_eq!(aliases(&files), vec!["viatilde", "viaabsolute"]);
    }

    #[test]
    fn include_cycles_terminate() {
        // A user-editable file can trivially be made circular.
        let files = [
            ("/home/u/.ssh/config", "Include a\nHost root\n"),
            ("/home/u/.ssh/a", "Include b\nHost ay\n"),
            ("/home/u/.ssh/b", "Include a\nHost bee\n"),
        ];
        let out = aliases(&files);
        assert!(out.contains(&"root".to_string()));
        assert!(out.contains(&"ay".to_string()));
        assert!(out.contains(&"bee".to_string()));
    }

    #[test]
    fn include_depth_is_capped() {
        let mut files: Vec<(String, String)> = Vec::new();
        files.push(("/home/u/.ssh/config".into(), "Include d0\n".into()));
        for i in 0..20 {
            files.push((format!("/home/u/.ssh/d{i}"), format!("Include d{}\nHost h{i}\n", i + 1)));
        }
        let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let out = aliases(&refs);
        assert!(out.len() <= MAX_INCLUDE_DEPTH as usize, "depth cap must bound the walk, got {}", out.len());
    }

    #[test]
    fn proxy_directives_are_surfaced_not_ignored() {
        // Silently ignoring these would connect direct to a host the user expects
        // to be reachable only through a jump — a wrong-host bug, not a missing
        // feature. The caller must refuse.
        let jump = resolve(&[("/home/u/.ssh/config", "Host box\n  ProxyJump bastion\n")], "box");
        assert_eq!(jump.proxy_jump.as_deref(), Some("bastion"));
        assert!(jump.requires_unsupported_proxy());

        let cmd = resolve(&[("/home/u/.ssh/config", "Host box\n  ProxyCommand nc %h %p\n")], "box");
        assert_eq!(cmd.proxy_command.as_deref(), Some("nc %h %p"));
        assert!(cmd.requires_unsupported_proxy());

        assert!(!resolve(&[("/home/u/.ssh/config", "Host box\n  User u\n")], "box").requires_unsupported_proxy());
    }

    #[test]
    fn match_blocks_are_reported_as_unsupported() {
        let r = resolve(&[("/home/u/.ssh/config", "Host box\n  User u\nMatch host box\n  User other\n")], "box");
        assert!(r.unsupported.contains(&"Match".to_string()), "a Match block must be surfaced");
        // We still return our best effort rather than nothing.
        assert_eq!(r.user.as_deref(), Some("u"));
    }

    #[test]
    fn invalid_port_is_dropped_rather_than_defaulted() {
        assert_eq!(resolve(&[("/home/u/.ssh/config", "Host box\n  Port notaport\n")], "box").port, None);
        assert_eq!(resolve(&[("/home/u/.ssh/config", "Host box\n  Port 0\n")], "box").port, None);
        assert_eq!(resolve(&[("/home/u/.ssh/config", "Host box\n  Port 99999\n")], "box").port, None);
    }

    #[test]
    fn tilde_expansion_without_a_home_is_a_no_op() {
        // Mobile has no home directory; fabricating one would be worse than
        // leaving the token alone.
        assert_eq!(expand_tilde("~/.ssh/id", None), "~/.ssh/id");
        assert_eq!(expand_tilde("~/.ssh/id", home()), "/home/u/.ssh/id");
        assert_eq!(expand_tilde("~", home()), HOME);
        assert_eq!(expand_tilde("/abs/path", home()), "/abs/path");
        assert_eq!(expand_tilde("~notauser/x", home()), "~notauser/x", "only ~/ and bare ~ expand");
    }

    #[test]
    fn default_config_path_follows_home() {
        assert_eq!(default_config_path(home()).unwrap(), PathBuf::from("/home/u/.ssh/config"));
        assert!(default_config_path(None).is_none());
    }
}
