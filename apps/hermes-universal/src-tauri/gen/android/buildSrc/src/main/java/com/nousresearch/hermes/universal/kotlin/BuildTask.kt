import java.io.File
import java.nio.file.Files
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """npm""";
        try {
            runTauriCli(executable)
            patchGetCookies()
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        patchGetCookies()
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    // wry 0.55's generated RustWebView.getCookies returns CookieManager.getCookie(url)
    // through a non-null String, and getCookie is null until the URL has a cookie —
    // Kotlin's implicit null check then throws on the main looper and kills the app on
    // the first cookie poll of every sign-in. Patched HERE, after cargo, rather than in
    // build.rs: wry's build script has rerun-if-changed on this very file, so a patch
    // that bumps its mtime makes wry regenerate (revert) it next build, and cargo gives
    // no ordering between wry's script and ours. Keeping the mtime hides the edit from
    // cargo (mtime-based); Gradle still re-hashes it because the length changed.
    fun patchGetCookies() {
        val re = Regex("""return cookieManager\.getCookie\(url\)$""", RegexOption.MULTILINE)
        project.fileTree("src/main/java") { include("**/generated/RustWebView.kt") }.forEach { f ->
            val src = f.readText()
            val patched = re.replace(src, """return cookieManager.getCookie(url) ?: """"")
            if (patched != src) {
                val mtime = Files.getLastModifiedTime(f.toPath())
                f.writeText(patched)
                Files.setLastModifiedTime(f.toPath(), mtime)
                logger.lifecycle("patched ${f.name}: getCookies null-safe (wry 0.55 Android crash workaround)")
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        // `npm run tauri -- …` rather than a bare `tauri …`: npm has no
        // package-runner subcommand of its own, so the CLI is reached through
        // the package's own `tauri` script. Everything appended below lands
        // after the `--` and is forwarded to the CLI untouched.
        val args = listOf("run", "tauri", "--", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}