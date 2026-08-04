//! Repo-first project discovery: crawl bounded roots for git repositories,
//! desktop-only [GATE].
//!
//! Port of the desktop (Electron) `apps/desktop/electron/git-repo-scan.ts`, which
//! owns the same machine-local capability in its main process. No git binary is
//! involved — a directory *is* a repo when `.git/` exists and `.git/HEAD` is
//! readable, and descent stops there.
//!
//! The renderer supplies the profile-scoped policy (`enabled` / `roots` /
//! `exclude_paths`) read from Hermes config; results are POSTed to the gateway's
//! `projects.record_repos`, which caches them so later reads never re-walk disk.
//!
//! Gating: this walks the *Tauri host's* filesystem, so `store/projects.ts` only
//! calls it when the backend was spawned locally (gateway mode `local`). A remote
//! gateway owns a different disk and Android has no crawlable one — that case
//! needs a backend-side endpoint, tracked as MJX-207.

use serde::Serialize;

/// One discovered repository. `label` is the directory basename, matching
/// desktop's `{ root, label }` shape (consumed by `projects.record_repos`).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub root: String,
    pub label: String,
}

// --------------------------------------------------------------------------
// Desktop: real implementation.
// --------------------------------------------------------------------------
#[cfg(desktop)]
pub mod imp {
    use super::RepoEntry;
    use std::collections::HashMap;
    use std::path::{Component, Path, PathBuf};

    /// Mirrors desktop's `DEFAULT_MAX_DEPTH` — repos nested deeper than this are
    /// intentionally invisible, so a home-directory scan stays bounded.
    const DEFAULT_MAX_DEPTH: u32 = 3;
    /// Mirrors desktop's `MAX_CONCURRENCY`: how many directories we stat at once.
    const MAX_CONCURRENCY: usize = 32;
    /// Mirrors desktop's `JUNK_DIRS` — big trees that never hold a user's repos.
    const JUNK_DIRS: [&str; 6] = [
        "Applications",
        "Library",
        "node_modules",
        "site-packages",
        "vendor",
        "venv",
    ];

    /// `$HOME` / `%USERPROFILE%`, falling back to the current directory so a
    /// missing env var can't turn a relative root into a filesystem-root crawl.
    pub fn home_dir() -> PathBuf {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }

    /// Lexical normalization (no symlink resolution, no disk access) — the Rust
    /// equivalent of Node's `path.normalize`: collapse `.`, pop `..`, drop
    /// redundant separators.
    fn normalize_lexically(path: &Path) -> PathBuf {
        let mut out = PathBuf::new();

        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    if matches!(
                        out.components().next_back(),
                        Some(Component::Normal(_)) | None
                    ) && !out.pop()
                    {
                        out.push("..");
                    }
                }
                other => out.push(other.as_os_str()),
            }
        }

        out
    }

    /// A normalized scan path: `value` is what we walk/report, `key` is the
    /// comparison form (case-folded on Windows, where paths are insensitive).
    #[derive(Clone, Debug)]
    pub struct NormalizedScanPath {
        pub key: String,
        pub value: PathBuf,
    }

    /// Expand `~`, absolutize against `home`, then normalize. Blank input yields
    /// `None` so empty config entries are skipped rather than scanning `/`.
    pub fn normalize_repo_scan_path(raw: &str, home: &Path) -> Option<NormalizedScanPath> {
        let raw = raw.trim();

        if raw.is_empty() {
            return None;
        }

        let expanded: PathBuf = if raw == "~" {
            home.to_path_buf()
        } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            home.join(rest)
        } else {
            PathBuf::from(raw)
        };

        let absolute = if expanded.is_absolute() {
            expanded
        } else {
            home.join(expanded)
        };

        let value = normalize_lexically(&absolute);
        let display = value.to_string_lossy().to_string();
        let key = if cfg!(windows) {
            display.to_lowercase()
        } else {
            display
        };

        Some(NormalizedScanPath { key, value })
    }

    /// Whether `candidate` is `parent` or lives underneath it. Used for the
    /// exclusion check, so excluding a folder also excludes its descendants.
    pub fn repo_scan_path_is_within(candidate: &str, parent: &str, home: &Path) -> bool {
        let (Some(candidate), Some(parent)) = (
            normalize_repo_scan_path(candidate, home),
            normalize_repo_scan_path(parent, home),
        ) else {
            return false;
        };

        Path::new(&candidate.key).starts_with(Path::new(&parent.key))
    }

    /// A directory is a repo when `.git/` is a directory whose `HEAD` we can
    /// read. The readability probe skips half-initialized / permission-denied
    /// `.git` folders that would otherwise show up as broken projects.
    fn git_repo_here(dir: &Path) -> bool {
        let git_dir = dir.join(".git");

        git_dir.is_dir() && std::fs::File::open(git_dir.join("HEAD")).is_ok()
    }

    /// Visit one directory: either record it as a repo (and stop descending) or
    /// return the child directories worth walking next.
    fn visit(dir: &Path) -> (bool, Vec<PathBuf>) {
        if git_repo_here(dir) {
            return (true, Vec::new());
        }

        let Ok(entries) = std::fs::read_dir(dir) else {
            return (false, Vec::new());
        };

        let mut children = Vec::new();

        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();

            if name.starts_with('.') || JUNK_DIRS.contains(&name.as_ref()) {
                continue;
            }

            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                children.push(entry.path());
            }
        }

        (false, children)
    }

    /// Scan `roots` for git repositories.
    ///
    /// Disabled discovery returns before resolving home or touching the disk. An
    /// empty root list preserves desktop's historical home-directory scan. The
    /// walk is breadth-first by depth level, with each level fanned out over at
    /// most `MAX_CONCURRENCY` threads (desktop's `mapLimit` equivalent).
    pub fn scan_git_repos(
        roots: &[String],
        max_depth: Option<u32>,
        enabled: Option<bool>,
        exclude_paths: &[String],
    ) -> Vec<RepoEntry> {
        if enabled == Some(false) {
            return Vec::new();
        }

        let home = home_dir();
        let max_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH);

        let requested: Vec<String> = if roots.iter().any(|root| !root.trim().is_empty()) {
            roots.to_vec()
        } else {
            vec![home.to_string_lossy().to_string()]
        };

        // Dedupe roots by comparison key so nested/duplicate config entries don't
        // walk the same tree twice.
        let mut seen_roots = HashMap::new();
        let mut level: Vec<PathBuf> = Vec::new();

        for root in &requested {
            if let Some(path) = normalize_repo_scan_path(root, &home) {
                if seen_roots.insert(path.key.clone(), ()).is_none() {
                    level.push(path.value);
                }
            }
        }

        let exclusions: Vec<String> = exclude_paths
            .iter()
            .filter_map(|excluded| normalize_repo_scan_path(excluded, &home))
            .map(|excluded| excluded.value.to_string_lossy().to_string())
            .collect();

        let is_excluded = |candidate: &Path| {
            let candidate = candidate.to_string_lossy().to_string();

            exclusions
                .iter()
                .any(|excluded| repo_scan_path_is_within(&candidate, excluded, &home))
        };

        let mut found: HashMap<String, RepoEntry> = HashMap::new();
        let mut depth = 0;

        while !level.is_empty() && depth <= max_depth {
            level.retain(|dir| !is_excluded(dir));

            let mut next: Vec<PathBuf> = Vec::new();
            let chunk_size = level.len().div_ceil(MAX_CONCURRENCY).max(1);

            // One scoped thread per chunk — bounded by MAX_CONCURRENCY, and the
            // scope joins before we move on to the next depth level.
            let results: Vec<(PathBuf, bool, Vec<PathBuf>)> = std::thread::scope(|scope| {
                let handles: Vec<_> = level
                    .chunks(chunk_size)
                    .map(|chunk| {
                        scope.spawn(move || {
                            chunk
                                .iter()
                                .map(|dir| {
                                    let (is_repo, children) = visit(dir);
                                    (dir.clone(), is_repo, children)
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .collect();

                handles
                    .into_iter()
                    .filter_map(|handle| handle.join().ok())
                    .flatten()
                    .collect()
            });

            for (dir, is_repo, children) in results {
                if is_repo {
                    if let Some(path) = normalize_repo_scan_path(&dir.to_string_lossy(), &home) {
                        let label = path
                            .value
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string())
                            .filter(|name| !name.is_empty())
                            .unwrap_or_else(|| path.value.to_string_lossy().to_string());

                        found.entry(path.key).or_insert(RepoEntry {
                            root: path.value.to_string_lossy().to_string(),
                            label,
                        });
                    }

                    continue;
                }

                next.extend(children);
            }

            level = next;
            depth += 1;
        }

        let mut out: Vec<RepoEntry> = found.into_values().collect();
        // Deterministic order — the map iteration order is not.
        out.sort_by(|a, b| a.root.cmp(&b.root));

        out
    }
}

// --------------------------------------------------------------------------
// Mobile: no crawlable local filesystem. Discovery has to happen backend-side
// (MJX-207); the TS caller gates on gateway mode and never reaches this.
// --------------------------------------------------------------------------
#[cfg(mobile)]
pub mod imp {
    use super::RepoEntry;

    pub fn scan_git_repos(
        _roots: &[String],
        _max_depth: Option<u32>,
        _enabled: Option<bool>,
        _exclude_paths: &[String],
    ) -> Vec<RepoEntry> {
        Vec::new()
    }
}

/// Crawl `roots` for git repositories on this machine's disk.
///
/// Runs on a blocking thread — a home-directory walk is disk-bound and would
/// otherwise stall the async runtime that also serves HTTP/WS traffic.
#[tauri::command]
pub async fn repo_scan_git_repos(
    roots: Vec<String>,
    max_depth: Option<u32>,
    enabled: Option<bool>,
    exclude_paths: Option<Vec<String>>,
) -> Result<Vec<RepoEntry>, String> {
    #[cfg(mobile)]
    {
        let _ = (&roots, max_depth, enabled, &exclude_paths);

        return Err("unsupported_platform".to_string());
    }

    #[cfg(desktop)]
    {
        let exclude_paths = exclude_paths.unwrap_or_default();

        tokio::task::spawn_blocking(move || {
            imp::scan_git_repos(&roots, max_depth, enabled, &exclude_paths)
        })
        .await
        .map_err(|err| err.to_string())
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::imp::{normalize_repo_scan_path, repo_scan_path_is_within, scan_git_repos};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Unique scratch directory — no `tempfile` dependency in this crate.
    fn scratch(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "hermes-repo-scan-{}-{name}-{id}",
            std::process::id()
        ));

        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        dir
    }

    fn make_repo(dir: &Path) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn roots_of(entries: &[super::RepoEntry]) -> Vec<String> {
        entries.iter().map(|entry| entry.root.clone()).collect()
    }

    #[test]
    fn disabled_policy_scans_nothing() {
        let root = scratch("disabled");
        make_repo(&root.join("alpha"));

        let found = scan_git_repos(
            &[root.to_string_lossy().to_string()],
            None,
            Some(false),
            &[],
        );

        assert!(found.is_empty());
    }

    #[test]
    fn finds_repos_and_stops_descending_at_a_hit() {
        let root = scratch("basic");
        make_repo(&root.join("alpha"));
        // A nested repo inside a repo must not be reported — descent stops at the
        // outer hit, exactly like desktop's walk.
        make_repo(&root.join("alpha").join("inner"));
        make_repo(&root.join("nested").join("beta"));
        std::fs::create_dir_all(root.join("plain")).unwrap();

        let found = scan_git_repos(&[root.to_string_lossy().to_string()], None, None, &[]);
        let roots = roots_of(&found);

        assert!(roots.contains(&root.join("alpha").to_string_lossy().to_string()));
        assert!(roots.contains(
            &root
                .join("nested")
                .join("beta")
                .to_string_lossy()
                .to_string()
        ));
        assert!(!roots.contains(
            &root
                .join("alpha")
                .join("inner")
                .to_string_lossy()
                .to_string()
        ));
        assert_eq!(roots.len(), 2);
    }

    #[test]
    fn unreadable_git_head_is_not_a_repo() {
        let root = scratch("head");
        std::fs::create_dir_all(root.join("broken").join(".git")).unwrap();

        let found = scan_git_repos(&[root.to_string_lossy().to_string()], None, None, &[]);

        assert!(found.is_empty());
    }

    #[test]
    fn max_depth_is_honoured() {
        let root = scratch("depth");
        make_repo(&root.join("a").join("b").join("c").join("deep"));

        let shallow = scan_git_repos(&[root.to_string_lossy().to_string()], Some(1), None, &[]);
        assert!(shallow.is_empty());

        let deep = scan_git_repos(&[root.to_string_lossy().to_string()], Some(4), None, &[]);
        assert_eq!(deep.len(), 1);
    }

    #[test]
    fn dotdirs_and_junk_dirs_are_skipped() {
        let root = scratch("junk");
        make_repo(&root.join("node_modules").join("pkg"));
        make_repo(&root.join(".cache").join("thing"));
        make_repo(&root.join("keep"));

        let found = scan_git_repos(&[root.to_string_lossy().to_string()], None, None, &[]);

        assert_eq!(roots_of(&found), vec![root.join("keep").to_string_lossy()]);
    }

    #[test]
    fn exclusions_cover_descendants() {
        let root = scratch("exclude");
        make_repo(&root.join("skipped").join("alpha"));
        make_repo(&root.join("kept"));

        let found = scan_git_repos(
            &[root.to_string_lossy().to_string()],
            None,
            None,
            &[root.join("skipped").to_string_lossy().to_string()],
        );

        assert_eq!(roots_of(&found), vec![root.join("kept").to_string_lossy()]);
    }

    #[test]
    fn duplicate_and_nested_roots_are_deduped() {
        let root = scratch("dedupe");
        make_repo(&root.join("alpha"));

        let found = scan_git_repos(
            &[
                root.to_string_lossy().to_string(),
                format!("{}/", root.to_string_lossy()),
                root.join("alpha").to_string_lossy().to_string(),
            ],
            None,
            None,
            &[],
        );

        assert_eq!(found.len(), 1);
    }

    #[test]
    fn empty_roots_fall_back_to_home() {
        let home = scratch("home");
        make_repo(&home.join("alpha"));

        // `home_dir()` reads $HOME, so point it at the scratch tree for this test.
        let previous = std::env::var("HOME").ok();
        std::env::set_var("HOME", &home);

        let found = scan_git_repos(&[], None, None, &[]);

        match previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        assert_eq!(roots_of(&found), vec![home.join("alpha").to_string_lossy()]);
    }

    #[test]
    fn tilde_and_relative_paths_expand_against_home() {
        let home = Path::new("/home/tester");

        assert_eq!(
            normalize_repo_scan_path("~/code", home).unwrap().value,
            PathBuf::from("/home/tester/code")
        );
        assert_eq!(
            normalize_repo_scan_path("code/../work", home).unwrap().value,
            PathBuf::from("/home/tester/work")
        );
        assert!(normalize_repo_scan_path("   ", home).is_none());
    }

    #[test]
    fn containment_check_matches_descendants_only() {
        let home = Path::new("/home/tester");

        assert!(repo_scan_path_is_within("~/code/app", "~/code", home));
        assert!(repo_scan_path_is_within("~/code", "~/code", home));
        assert!(!repo_scan_path_is_within("~/coder", "~/code", home));
        assert!(!repo_scan_path_is_within("~/other", "~/code", home));
    }
}
