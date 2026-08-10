//! VS Code Marketplace color-theme fetcher (native).
//!
//! Port of the desktop's `electron/vscode-marketplace.ts` onto Tauri/Rust: the
//! webview can't reach the Marketplace directly (CORS + it's a binary `.vsix`
//! download), so the fetch runs here like the rest of our networking. We resolve
//! an extension's latest version via the (undocumented but stable) gallery
//! ExtensionQuery API, download the `.vsix` (a plain zip), and extract the color
//! theme JSON files it contributes. No theme code is ever executed — we only read
//! `package.json` + the referenced `*.json` theme files and hand their text back
//! to the frontend to convert (`themes/vscode.ts`).

use std::io::Read;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::transport::TransportState;

const GALLERY_QUERY_URL: &str =
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const VSIX_ASSET_TYPE: &str = "Microsoft.VisualStudio.Services.VSIXPackage";
const MAX_VSIX_BYTES: u64 = 40 * 1024 * 1024; // 40 MB — themes are tiny; this is paranoia.
const USER_AGENT: &str = "Hermes-Universal";

/// A lightweight Marketplace card (no download) — mirrors the desktop shape.
#[derive(Serialize)]
pub struct MarketplaceSearchItem {
    #[serde(rename = "extensionId")]
    extension_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    publisher: String,
    description: String,
    installs: u64,
}

/// One color theme an extension contributes (raw JSONC text, converted client-side).
#[derive(Serialize)]
pub struct MarketplaceThemeFile {
    label: String,
    #[serde(rename = "uiTheme")]
    ui_theme: Option<String>,
    contents: String,
}

/// The themes a single extension contributes.
#[derive(Serialize)]
pub struct MarketplaceThemeResult {
    #[serde(rename = "extensionId")]
    extension_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    themes: Vec<MarketplaceThemeFile>,
}

/// `publisher.extension` — one dot, both sides `[\w-]+` (mirrors the desktop RE).
fn is_valid_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();

    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// POST an ExtensionQuery payload and return the parsed gallery response.
async fn query_gallery(client: &reqwest::Client, payload: &Value) -> Result<Value, String> {
    let resp = client
        .post(GALLERY_QUERY_URL)
        .header("Accept", "application/json;api-version=3.0-preview.1")
        .header("Content-Type", "application/json")
        .header("User-Agent", USER_AGENT)
        .json(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Marketplace query failed ({}).", resp.status()));
    }

    resp.json::<Value>().await.map_err(|e| e.to_string())
}

/// The "Themes" category also holds file-icon / product-icon themes (there's no
/// color-only category). Filter the obvious icon packs out by tag + name/desc —
/// same heuristic as the desktop fetcher.
fn looks_like_icon_theme(extension: &Value) -> bool {
    let tags: Vec<String> = extension
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_lowercase())
                .collect()
        })
        .unwrap_or_default();

    if tags
        .iter()
        .any(|t| t == "icon-theme" || t == "product-icon-theme")
    {
        return true;
    }

    let text = format!(
        "{} {}",
        extension
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        extension
            .get("shortDescription")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    )
    .to_lowercase();

    [
        "icon theme",
        "file icon",
        "product icon",
        "icon pack",
        "fileicons",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Search the Marketplace for color-theme extensions. An empty query returns the
/// most-installed themes; a query is a full-text search scoped to the Themes
/// category. Returns lightweight cards (no download).
#[tauri::command]
pub async fn marketplace_search(
    state: State<'_, TransportState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<MarketplaceSearchItem>, String> {
    let text = query.trim().to_string();
    let page_size = limit.unwrap_or(20).clamp(1, 50);

    // FilterType: 8=Target, 5=Category, 10=SearchText, 12=ExcludeWithFlags.
    let mut criteria = vec![
        json!({ "filterType": 8, "value": "Microsoft.VisualStudio.Code" }),
        json!({ "filterType": 5, "value": "Themes" }),
        json!({ "filterType": 12, "value": "4096" }), // Exclude unpublished.
    ];

    if !text.is_empty() {
        criteria.push(json!({ "filterType": 10, "value": text }));
    }

    let payload = json!({
        // Over-fetch so the icon-theme filter below still leaves a full page.
        "filters": [{
            "criteria": criteria,
            "pageNumber": 1,
            "pageSize": (page_size * 2).min(50),
            "sortBy": 4,
            "sortOrder": 0
        }],
        // IncludeStatistics | IncludeLatestVersionOnly | IncludeCategoryAndTags = 772.
        "flags": 772
    });

    let client = state.client().clone();
    let response = query_gallery(&client, &payload).await?;

    let extensions = response
        .get("results")
        .and_then(|r| r.get(0))
        .and_then(|r| r.get("extensions"))
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();

    for extension in extensions {
        if looks_like_icon_theme(&extension) {
            continue;
        }

        let publisher_name = extension
            .get("publisher")
            .and_then(|p| p.get("publisherName"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let extension_name = extension
            .get("extensionName")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let display_name = extension
            .get("displayName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(extension_name)
            .to_string();
        let publisher = extension
            .get("publisher")
            .and_then(|p| p.get("displayName"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(publisher_name)
            .to_string();
        let description = extension
            .get("shortDescription")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let installs = extension
            .get("statistics")
            .and_then(|s| s.as_array())
            .and_then(|arr| {
                arr.iter().find(|stat| {
                    stat.get("statisticName").and_then(|v| v.as_str()) == Some("install")
                })
            })
            .and_then(|stat| stat.get("value"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .round() as u64;

        out.push(MarketplaceSearchItem {
            extension_id: format!("{publisher_name}.{extension_name}"),
            display_name,
            publisher,
            description,
            installs,
        });

        if out.len() >= page_size as usize {
            break;
        }
    }

    Ok(out)
}

/// Resolve `(displayName, vsixUrl)` for the latest version of `id`.
async fn resolve_extension(client: &reqwest::Client, id: &str) -> Result<(String, String), String> {
    let payload = json!({
        // FilterType 7 = ExtensionName (the full publisher.extension id).
        "filters": [{ "criteria": [{ "filterType": 7, "value": id }], "pageNumber": 1, "pageSize": 1 }],
        // IncludeFiles | IncludeVersionProperties | IncludeAssetUri |
        // IncludeCategoryAndTags | IncludeLatestVersionOnly = 914.
        "flags": 914
    });

    let response = query_gallery(client, &payload).await?;

    let extension = response
        .get("results")
        .and_then(|r| r.get(0))
        .and_then(|r| r.get("extensions"))
        .and_then(|e| e.get(0))
        .ok_or_else(|| format!("Extension \"{id}\" was not found on the Marketplace."))?;

    let display_name = extension
        .get("displayName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(id)
        .to_string();

    let version = extension
        .get("versions")
        .and_then(|v| v.get(0))
        .ok_or_else(|| format!("Extension \"{id}\" has no published versions."))?;

    let vsix_url = version
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|files| {
            files.iter().find(|file| {
                file.get("assetType").and_then(|v| v.as_str()) == Some(VSIX_ASSET_TYPE)
            })
        })
        .and_then(|file| file.get("source"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Could not find a downloadable package for \"{id}\"."))?
        .to_string();

    Ok((display_name, vsix_url))
}

/// Download `url`, refusing anything larger than `max` bytes.
async fn download_capped(client: &reqwest::Client, url: &str, max: u64) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Download failed ({}).", resp.status()));
    }

    if resp.content_length().is_some_and(|len| len > max) {
        return Err("Response exceeded the size limit.".to_string());
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    if bytes.len() as u64 > max {
        return Err("Response exceeded the size limit.".to_string());
    }

    Ok(bytes.to_vec())
}

/// Normalize a package.json theme path to its zip entry name.
fn theme_entry_name(theme_path: &str) -> String {
    let clean = theme_path.trim_start_matches("./").trim_start_matches('/');

    format!("extension/{clean}")
}

/// Read one zip entry to a string, or `None` if it isn't present.
fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Option<String>, String> {
    let mut file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let mut buf = String::new();
    file.read_to_string(&mut buf).map_err(|e| e.to_string())?;

    Ok(Some(buf))
}

/// Extract every contributed color theme from a `.vsix` buffer.
fn extract_themes(vsix: &[u8]) -> Result<Vec<MarketplaceThemeFile>, String> {
    let cursor = std::io::Cursor::new(vsix);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let pkg_text = read_zip_entry(&mut archive, "extension/package.json")?
        .ok_or_else(|| "Package manifest missing from the extension.".to_string())?;
    let pkg: Value = serde_json::from_str(&pkg_text).map_err(|e| e.to_string())?;

    let contributed = pkg
        .get("contributes")
        .and_then(|c| c.get("themes"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let mut themes = Vec::new();

    for entry in contributed {
        let path = match entry.get("path").and_then(|v| v.as_str()) {
            Some(path) => path,
            None => continue,
        };

        // Skip an entry we can't read rather than failing the whole install.
        let contents = match read_zip_entry(&mut archive, &theme_entry_name(path)) {
            Ok(Some(contents)) => contents,
            _ => continue,
        };

        let label = entry
            .get("label")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("id").and_then(|v| v.as_str()))
            .or_else(|| pkg.get("displayName").and_then(|v| v.as_str()))
            .or_else(|| pkg.get("name").and_then(|v| v.as_str()))
            .unwrap_or("VS Code Theme")
            .to_string();
        let ui_theme = entry
            .get("uiTheme")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        themes.push(MarketplaceThemeFile {
            label,
            ui_theme,
            contents,
        });
    }

    Ok(themes)
}

/// Resolve, download, and extract color themes for `id` (`publisher.extension`).
#[tauri::command]
pub async fn marketplace_fetch(
    state: State<'_, TransportState>,
    id: String,
) -> Result<MarketplaceThemeResult, String> {
    let trimmed = id.trim().to_string();

    if !is_valid_id(&trimmed) {
        return Err("Expected a Marketplace id like \"publisher.extension\".".to_string());
    }

    let client = state.client().clone();
    let (display_name, vsix_url) = resolve_extension(&client, &trimmed).await?;
    let vsix = download_capped(&client, &vsix_url, MAX_VSIX_BYTES).await?;
    let themes = extract_themes(&vsix)?;

    Ok(MarketplaceThemeResult {
        extension_id: trimmed,
        display_name,
        themes,
    })
}
