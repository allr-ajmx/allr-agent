//! Python payloads that run on the remote host.
//!
//! Ported **verbatim** from `apps/desktop/electron/remote-lifecycle.ts`
//! (`:136-144` launcher resolver, `:378-396` ownership proof, `:527-555` token
//! upload). These are the security boundary of the whole SSH lifecycle — the
//! only things that decide whether a secret is written safely and whether a
//! process may be killed — so they are transcribed rather than rewritten, and
//! every value reaches them through `shq` and nothing else.
//!
//! Python rather than shell because each one needs a syscall that `sh` cannot
//! express: `O_EXCL|O_NOFOLLOW` with a directory fd, `fstat` on that fd, and
//! `/proc/<pid>/cmdline` parsing that survives arguments containing spaces.

use super::error::SshError;
use super::remote_paths::{shq, validate_spawn_nonce};

/// Follow a launcher shim to the binary it actually runs.
///
/// A `hermes` on `PATH` is often a two-line `sh` wrapper ending in `exec
/// /real/path/hermes`. The ownership proof compares `/proc/<pid>/cmdline`
/// against the path we spawned, and the kernel records the *target*, not the
/// wrapper — so without this every ownership check would read "not ours" and we
/// would respawn on every connect and never clean up.
pub fn resolve_launcher(candidate: &str) -> String {
    let script = format!(
        "import os,shlex,sys\n\
         p=os.path.expanduser({candidate})\n\
         out=p\n\
         try:\n\
         \x20data=open(p,\"r\",encoding=\"utf-8\",errors=\"ignore\").read(4096)\n\
         \x20for line in data.splitlines():\n\
         \x20\x20words=shlex.split(line)\n\
         \x20\x20if len(words)>1 and words[0]==\"exec\":\n\
         \x20\x20\x20target=os.path.expanduser(words[1])\n\
         \x20\x20\x20if os.path.isabs(target) and os.access(target,os.X_OK):out=target\n\
         \x20\x20\x20break\n\
         except (OSError,ValueError):pass\n\
         print(out)",
        candidate = shq(candidate)
    );

    format!("python3 -c {}", shq(&script))
}

/// Prove a pid is *our* dashboard before anything may kill it.
///
/// Liveness is not identity: pids are reused, and a `kill` aimed at a recycled
/// pid destroys an unrelated process. Ownership therefore requires all three of
/// argv[0] being the exact binary we spawned (or a `python` entry point running
/// it), `--isolated` present, and our own spawn nonce echoed back.
///
/// Reads `/proc/<pid>/cmdline` and falls back to `ps` on macOS, which has no
/// procfs.
pub fn pid_is_our_dashboard(pid: i64, spawn_nonce: &str, hermes_path: &str) -> Result<String, SshError> {
    validate_spawn_nonce(spawn_nonce)?;

    let script = format!(
        "import os,shlex,subprocess,sys\n\
         pid={pid}\n\
         expected=os.path.expanduser({expected})\n\
         nonce={nonce}\n\
         try:\n\
         \x20raw=open(f\"/proc/{{pid}}/cmdline\",\"rb\").read()\n\
         \x20args=[x.decode(\"utf-8\",\"surrogateescape\") for x in raw.split(b\"\\0\") if x]\n\
         except OSError:\n\
         \x20line=subprocess.check_output([\"ps\",\"-o\",\"command=\",\"-p\",str(pid)],text=True).strip()\n\
         \x20args=shlex.split(line)\n\
         ok=False\n\
         try:\n\
         \x20serve=args.index(\"serve\")\n\
         \x20owner=args.index(\"--ssh-owner-nonce\",serve+1)\n\
         \x20direct=args[0]==expected\n\
         \x20python_entry=len(args)>1 and args[1]==expected and os.path.basename(args[0]).startswith(\"python\")\n\
         \x20ok=(direct or python_entry) and \"--isolated\" in args[serve+1:] and args[owner+1]==nonce\n\
         except (ValueError,IndexError):pass\n\
         print(\"OWNED\" if ok else \"FOREIGN\")",
        pid = pid,
        expected = shq(hermes_path),
        nonce = shq(spawn_nonce)
    );

    Ok(format!("python3 -c {}", shq(&script)))
}

/// Write the session token to the remote, reading it from **stdin**.
///
/// The secret never appears in argv, so it is invisible to `ps` and to anyone
/// else's shell history on that host. The file is created with
/// `O_CREAT|O_EXCL|O_NOFOLLOW` at mode 0600 relative to a directory fd that has
/// been `fstat`-ed for owner and mode — which is what closes the symlink-swap
/// and directory-replacement races that a plain `>` redirect leaves open.
///
/// Also reaps `.token` files older than an hour, so an interrupted connect does
/// not leave credentials lying around indefinitely.
pub fn upload_token(token_file_path: &str) -> String {
    let script = format!(
        "import os,sys,stat\n\
         p=os.path.expanduser({path})\n\
         d=os.path.dirname(p)\n\
         n=os.path.basename(p)\n\
         os.makedirs(d,mode=0o700,exist_ok=True)\n\
         df=os.O_RDONLY|getattr(os,\"O_DIRECTORY\",0)|getattr(os,\"O_NOFOLLOW\",0)\n\
         dd=os.open(d,df)\n\
         try:\n\
         \x20s=os.fstat(dd)\n\
         \x20if not stat.S_ISDIR(s.st_mode):raise SystemExit(\"unsafe token directory\")\n\
         \x20if hasattr(os,\"getuid\") and s.st_uid!=os.getuid():raise SystemExit(\"token directory owner mismatch\")\n\
         \x20if (s.st_mode&0o777)!=0o700:os.fchmod(dd,0o700)\n\
         \x20fl=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,\"O_NOFOLLOW\",0)\n\
         \x20now=__import__(\"time\").time()\n\
         \x20for stale in os.listdir(dd):\n\
         \x20\x20if stale.endswith(\".token\") and len(stale)==22:\n\
         \x20\x20\x20try:\n\
         \x20\x20\x20\x20ss=os.stat(stale,dir_fd=dd,follow_symlinks=False)\n\
         \x20\x20\x20\x20if stat.S_ISREG(ss.st_mode) and now-ss.st_mtime>3600:os.unlink(stale,dir_fd=dd)\n\
         \x20\x20\x20except OSError:pass\n\
         \x20fd=os.open(n,fl,0o600,dir_fd=dd)\n\
         \x20try:os.write(fd,sys.stdin.buffer.read())\n\
         \x20except BaseException:\n\
         \x20\x20try:os.unlink(n,dir_fd=dd)\n\
         \x20\x20except OSError:pass\n\
         \x20\x20raise\n\
         \x20finally:os.close(fd)\n\
         finally:os.close(dd)",
        path = shq(token_file_path)
    );

    format!("python3 -c {}", shq(&script))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reverse `shq` so the embedded script can be inspected as the remote sees it.
    fn unshq(quoted: &str) -> String {
        let inner = quoted.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).expect("one shell word");

        inner.replace("'\\''", "'")
    }

    fn script_of(command: &str) -> String {
        unshq(command.strip_prefix("python3 -c ").expect("a python3 -c invocation"))
    }

    #[test]
    fn every_payload_is_a_single_quoted_python_invocation() {
        // If any of these stopped being one shell word, the interpolated values
        // would become separate arguments — the exact injection these guard.
        for command in [
            resolve_launcher("/usr/local/bin/hermes"),
            pid_is_our_dashboard(42, "0123456789abcdef", "/usr/local/bin/hermes").unwrap(),
            upload_token("~/.hermes/desktop-ssh/o/n.token"),
        ] {
            assert!(command.starts_with("python3 -c '"), "{command}");
            assert!(command.ends_with('\''), "{command}");
        }
    }

    #[test]
    fn resolve_launcher_follows_an_exec_shim() {
        // A `hermes` on PATH is often a wrapper ending in `exec /real/path`.
        // /proc records the target, so ownership proofs compare against it.
        let script = script_of(&resolve_launcher("/usr/local/bin/hermes"));
        assert!(script.contains("words[0]==\"exec\""), "{script}");
        assert!(script.contains("os.access(target,os.X_OK)"), "{script}");
        assert!(script.contains("os.path.isabs(target)"), "only an absolute target is followed: {script}");
        // Falls back to the candidate itself rather than failing.
        assert!(script.contains("out=p"), "{script}");
    }

    #[test]
    fn ownership_proof_requires_all_three_signals() {
        // Liveness is not identity: pids get reused, so a kill aimed at a
        // recycled pid destroys something unrelated. All three must hold.
        let script = script_of(&pid_is_our_dashboard(42, "0123456789abcdef", "/usr/local/bin/hermes").unwrap());

        assert!(script.contains("args.index(\"serve\")"), "{script}");
        assert!(script.contains("\"--isolated\" in args[serve+1:]"), "{script}");
        assert!(script.contains("args[owner+1]==nonce"), "{script}");
        assert!(script.contains("direct or python_entry"), "{script}");
        // macOS has no procfs.
        assert!(script.contains("/proc/{pid}/cmdline"), "{script}");
        assert!(script.contains("ps\",\"-o\",\"command=\""), "{script}");
        // Anything unparseable must read as FOREIGN, never as OWNED.
        assert!(script.contains("ok=False"), "{script}");
        assert!(script.contains("except (ValueError,IndexError):pass"), "{script}");
    }

    #[test]
    fn ownership_proof_embeds_the_exact_pid_and_nonce() {
        let script = script_of(&pid_is_our_dashboard(4242, "0123456789abcdef", "/usr/local/bin/hermes").unwrap());
        assert!(script.contains("pid=4242"), "{script}");
        assert!(script.contains("nonce='0123456789abcdef'"), "{script}");
        assert!(script.contains("expected=os.path.expanduser('/usr/local/bin/hermes')"), "{script}");
    }

    #[test]
    fn ownership_proof_rejects_a_malformed_nonce() {
        // The nonce is the identity anchor; a bad one must fail before it can be
        // interpolated into a command that decides whether to kill something.
        assert!(pid_is_our_dashboard(42, "not-a-nonce", "/usr/local/bin/hermes").is_err());
        assert!(pid_is_our_dashboard(42, "", "/usr/local/bin/hermes").is_err());
    }

    #[test]
    fn ownership_proof_quotes_a_hostile_hermes_path() {
        let script = script_of(&pid_is_our_dashboard(42, "0123456789abcdef", "/x'; rm -rf /; #").unwrap());
        assert!(script.contains(r#"expected=os.path.expanduser('/x'\''; rm -rf /; #')"#), "{script}");
    }

    #[test]
    fn token_upload_creates_the_file_exclusively_and_privately() {
        // A plain `>` redirect leaves symlink-swap and directory-replacement
        // races open; these flags are what close them.
        let script = script_of(&upload_token("~/.hermes/desktop-ssh/o/n.token"));

        assert!(script.contains("os.O_CREAT|os.O_EXCL"), "{script}");
        assert!(script.contains("O_NOFOLLOW"), "{script}");
        assert!(script.contains("0o600"), "the token must not be world-readable: {script}");
        assert!(script.contains("os.makedirs(d,mode=0o700"), "{script}");
        // fstat on the directory FD, not a path — that is what makes it a race.
        assert!(script.contains("s=os.fstat(dd)"), "{script}");
        assert!(script.contains("s.st_uid!=os.getuid()"), "{script}");
        assert!(script.contains("dir_fd=dd"), "{script}");
    }

    #[test]
    fn token_upload_reads_the_secret_from_stdin() {
        // The whole point: never in argv, so it is invisible to `ps` and to
        // anyone else's shell history on that host.
        let script = script_of(&upload_token("~/x.token"));

        assert!(script.contains("sys.stdin.buffer.read()"), "{script}");
        assert!(!script.contains("HERMES_DASHBOARD_SESSION_TOKEN"), "{script}");
    }

    #[test]
    fn token_upload_cleans_up_after_itself() {
        let script = script_of(&upload_token("~/x.token"));

        // A failed write must not leave a partial credential behind.
        assert!(script.contains("os.unlink(n,dir_fd=dd)"), "{script}");
        // And an interrupted connect must not leave one lying around for good.
        assert!(script.contains("now-ss.st_mtime>3600"), "{script}");
        assert!(script.contains("follow_symlinks=False"), "{script}");
    }

    #[test]
    fn token_upload_quotes_a_hostile_path() {
        let script = script_of(&upload_token("~/a'; rm -rf /; #.token"));
        assert!(script.contains(r#"p=os.path.expanduser('~/a'\''; rm -rf /; #.token')"#), "{script}");
    }
}
