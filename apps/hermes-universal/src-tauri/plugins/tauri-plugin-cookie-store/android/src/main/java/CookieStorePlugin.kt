package work.allr.plugin.cookiestore

import android.app.Activity
import android.webkit.CookieManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** One host to scrub. Jackson fills it from the Rust `ExpireTarget`; field names must match. */
@InvokeArg
class ExpireTarget {
    /** `https://<host>/` — the path is `/`, so only `Path=/` cookies are seen or expired. */
    lateinit var url: String

    /** `Domain=` values to expire each name under, besides host-only. */
    lateinit var domains: Array<String>
}

/** The `expireCookies` payload (Rust `ExpireCookiesArgs`). */
@InvokeArg
class ExpireCookiesArgs {
    lateinit var targets: Array<ExpireTarget>
}

/**
 * Android side of tauri-plugin-cookie-store.
 *
 * `CookieManager` is the one cookie store every WebView in the app shares, and it cannot
 * list cookies with their attributes: `getCookie(url)` returns only `name=value` pairs.
 * So Rust names the hosts, and for each one this reads the names and overwrites each
 * with an already-expired cookie of the same name — once host-only and once per
 * `Domain=` the caller gave — because the store keys a cookie by (name, domain, path)
 * and only an exact key match replaces it. `Path=/` only: a cookie set under another
 * path is invisible to `getCookie("https://<host>/")` and survives.
 *
 * Threading: Tauri runs `@Command` methods on the main thread (wry's main-looper pipe),
 * which is where the WebView expects `CookieManager` calls. The overwrites are
 * synchronous; `flush()` blocks briefly on disk I/O.
 *
 * Never logs or returns a cookie value, or even a name: the reply is two counts.
 */
@TauriPlugin
class CookieStorePlugin(activity: Activity) : Plugin(activity) {

    @Command
    fun expireCookies(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ExpireCookiesArgs::class.java)
            val cookieManager = CookieManager.getInstance()
            // URL -> the names expired there. A (host, name) pair is counted once even if
            // the same URL were listed twice.
            val expired = LinkedHashMap<String, MutableSet<String>>()

            for (target in args.targets) {
                val names = cookieNames(cookieManager.getCookie(target.url))

                for (name in names) {
                    cookieManager.setCookie(target.url, expiry(name, null))
                    for (domain in target.domains) {
                        cookieManager.setCookie(target.url, expiry(name, domain))
                    }
                }

                expired.getOrPut(target.url) { LinkedHashSet() }.addAll(names)
            }

            cookieManager.flush()

            // Re-read after the flush: anything still returned outlived its expiry (scoped
            // above the parent domain, or refused by the store). Reported as a count only.
            var cleared = 0
            var remaining = 0
            for ((url, names) in expired) {
                val still = cookieNames(cookieManager.getCookie(url))
                cleared += names.size
                remaining += names.count { it in still }
            }

            val ret = JSObject()
            ret.put("cleared", cleared)
            ret.put("remaining", remaining)
            invoke.resolve(ret)
        } catch (e: Exception) {
            // Fixed text plus the exception type: a message could quote the store's input.
            invoke.reject("CookieManager could not expire the cookies (${e.javaClass.simpleName})")
        }
    }

    /**
     * The cookie names in a `getCookie` reply (`a=1; b=2`). `null` means nothing is stored.
     * A cookie with no name (Chromium prints just its value) cannot be addressed and is skipped.
     */
    private fun cookieNames(header: String?): Set<String> {
        val names = LinkedHashSet<String>()
        if (header == null) {
            return names
        }

        for (pair in header.split(';')) {
            val eq = pair.indexOf('=')
            if (eq <= 0) {
                continue
            }

            val name = pair.substring(0, eq).trim()
            if (name.isNotEmpty()) {
                names.add(name)
            }
        }

        return names
    }

    /**
     * An already-expired `Set-Cookie` line for `name`. `Secure` because the URL is https and
     * a `__Secure-`/`__Host-` name is only accepted with it; a `Domain=` on a `__Host-` name is
     * rejected by the store, which is harmless — the host-only line already covers it.
     * `HttpOnly` because Pomerium's and Dex's session cookies are HttpOnly, and a store that
     * refuses to let a script-style cookie replace an HttpOnly one must not get the chance.
     */
    private fun expiry(name: String, domain: String?): String {
        val line = "$name=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly"
        return if (domain == null) line else "$line; Domain=$domain"
    }
}
