//! Native link-title fetcher.
//!
//! The webview can't fetch cross-origin pages (CORS), so resolving an external
//! link's page title runs here like the rest of our networking. We GET the URL
//! over the shared transport client, then extract `<title>` (falling back to the
//! OpenGraph `og:title`) from the returned HTML. This is the Tauri analog of the
//! desktop `window.hermesDesktop.fetchLinkTitle` bridge (which used an offscreen
//! BrowserWindow); a static-HTML parse can't see JS-rendered titles, but it
//! covers the common case and is portable across desktop + mobile.
//!
//! Best-effort throughout: any failure (network, non-HTML, no title) returns an
//! empty string and the frontend falls back to the link's label / URL slug.

use std::time::Duration;

use tauri::State;

use crate::transport::TransportState;

// A realistic UA — some sites serve an error/blank <title> to unknown agents.
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Hermes-Universal/1.0)";
const REQUEST_TIMEOUT_SECS: u64 = 8;
const MAX_TITLE_CHARS: usize = 300;

#[tauri::command]
pub async fn fetch_link_title(
    state: State<'_, TransportState>,
    url: String,
) -> Result<String, String> {
    let trimmed = url.trim();

    // Only http(s). The frontend already guards (isTitleFetchable), but the
    // native boundary shouldn't trust the caller.
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Ok(String::new());
    }

    let resp = match state
        .client()
        .get(trimmed)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => return Ok(String::new()),
    };

    // Only parse HTML documents (skip images/pdf/json/etc). Default to trying
    // when the header is absent.
    let is_html = resp
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(|ct| ct.to_ascii_lowercase().contains("html"))
        .unwrap_or(true);

    if !is_html {
        return Ok(String::new());
    }

    match resp.text().await {
        Ok(body) => Ok(extract_title(&body)),
        Err(_) => Ok(String::new()),
    }
}

fn extract_title(html: &str) -> String {
    if let Some(raw) = tag_title(html) {
        let title = truncate(&decode_entities(&raw));

        if !title.is_empty() {
            return title;
        }
    }

    if let Some(raw) = og_title(html) {
        return truncate(&decode_entities(&raw));
    }

    String::new()
}

/// `<title>…</title>`. `to_ascii_lowercase` preserves byte length (only A–Z
/// bytes change), so indices into the lowercased copy align with the original.
fn tag_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let content_start = lower[open..].find('>')? + open + 1;
    let content_end = lower[content_start..].find("</title")? + content_start;

    Some(html[content_start..content_end].trim().to_string())
}

/// OpenGraph `<meta property="og:title" content="…">` (property/content in any
/// order; single- or double-quoted).
fn og_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;

    while let Some(rel) = lower[from..].find("og:title") {
        let pos = from + rel;
        let tag_start = lower[..pos].rfind('<').unwrap_or(0);
        let tag_end = lower[pos..].find('>').map(|end| pos + end).unwrap_or(lower.len());

        if let Some(content) = attr_value(&lower[tag_start..tag_end], &html[tag_start..tag_end], "content") {
            let value = content.trim();

            if !value.is_empty() {
                return Some(value.to_string());
            }
        }

        from = tag_end;
    }

    None
}

/// Read `name="value"` / `name='value'` / bare `name=value` from a single tag.
/// `tag_lower`/`tag_orig` are the same byte-length (ASCII lowercasing), so the
/// index found in the lowercased tag slices the original correctly.
fn attr_value(tag_lower: &str, tag_orig: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let start = tag_lower.find(&needle)? + needle.len();
    let bytes = tag_orig.as_bytes();

    if start >= bytes.len() {
        return None;
    }

    let quote = bytes[start];

    if quote == b'"' || quote == b'\'' {
        let value_start = start + 1;
        let end_rel = tag_orig[value_start..].find(quote as char)?;

        Some(tag_orig[value_start..value_start + end_rel].to_string())
    } else {
        let rest = &tag_orig[start..];
        let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());

        Some(rest[..end].to_string())
    }
}

/// Decode the handful of HTML entities that show up in titles. `&amp;` is
/// decoded LAST so a literal `&amp;lt;` doesn't collapse into `<`.
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn truncate(s: &str) -> String {
    let trimmed = s.trim();

    if trimmed.chars().count() <= MAX_TITLE_CHARS {
        trimmed.to_string()
    } else {
        trimmed.chars().take(MAX_TITLE_CHARS).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_title_tag() {
        assert_eq!(extract_title("<html><head><TITLE>Hello  World</TITLE></head>"), "Hello  World");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(extract_title("<title>Tom &amp; Jerry &lt;3</title>"), "Tom & Jerry <3");
    }

    #[test]
    fn falls_back_to_og_title() {
        let html = r#"<head><meta content="OG Name" property="og:title"><title></title></head>"#;
        assert_eq!(extract_title(html), "OG Name");
    }

    #[test]
    fn empty_when_no_title() {
        assert_eq!(extract_title("<html><body>no title here</body></html>"), "");
    }
}
