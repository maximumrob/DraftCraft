use std::sync::Mutex;

/// Serverless live co-editing sessions.
mod live;
use percent_encoding::percent_decode_str;
#[allow(unused_imports)]
use tauri::{Emitter, Manager};
#[cfg(desktop)]
#[allow(unused_imports)]
use tauri::menu::{Menu, Submenu, PredefinedMenuItem, MenuItem};

// ── Pending file state ────────────────────────────────────────────────────
// Stores the file path when the OS opens a screenplay file with DraftCraft.
// The frontend retrieves it on startup via the get_opened_file command.
struct PendingFile(Mutex<Option<String>>);

/// Extensions that DraftCraft can open via file association.
/// Before the app first overwrites an existing document, keep a copy of what
/// is there now in the app's own data folder. The copy's name carries a
/// fingerprint of its contents, so an unchanged file is never copied twice.
/// Returns the path of the copy, or None when there was nothing to keep.
#[tauri::command]
fn keep_original_copy(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    use std::hash::{Hash, Hasher};
    let src = std::path::Path::new(&path);
    if !src.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(src).map_err(|e| format!("could not read {}: {}", path, e))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("originals");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("document");
    let dest = dir.join(format!("{:016x}-{}", hasher.finish(), name));
    if !dest.exists() {
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(Some(dest.to_string_lossy().into_owned()))
}

const OPENABLE_EXTENSIONS: &[&str] = &["dcraft", "fdx", "fountain", "fadein", "osf", "txt"];

fn is_openable_file(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("");
    OPENABLE_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

/// The file the OS asked DraftCraft to open, if one is waiting.
///
/// Taken rather than copied. Every window polls this as it mounts, so leaving
/// the path in place would make a second window open a duplicate of whatever
/// document the first one was launched with — which is exactly what "New
/// Window" is not for. The frontend already de-duplicates against the
/// `open-file` event, which carries the same path.
#[tauri::command]
fn get_opened_file(state: tauri::State<PendingFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

// ── File I/O commands ──────────────────────────────────────────────────────
// These bypass the fs plugin scope so the user can save/open files anywhere
// via the native dialog.

#[tauri::command]
fn save_text_to_path(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn save_binary_to_path(path: String, contents: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

// ── Backup folder commands ────────────────────────────────────────────────
// The automatic-backup feature writes timestamped .dcraft snapshots to a folder
// the user picks, which is outside the fs plugin scope in
// capabilities/default.json. Like the commands above, these go through Rust
// deliberately rather than widening that scope.

#[derive(serde::Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// Milliseconds since the Unix epoch; 0 when the platform won't say.
    modified_ms: u64,
}

/// List a directory, without recursing.
///
/// Entries whose metadata can't be read (a broken symlink, a file that vanished
/// mid-listing, a stale handle on a network share) are skipped rather than
/// failing the whole call — a single bad entry must not make the backup folder
/// look empty.
// The folder commands below run on the async thread pool, not the main thread
// (`async` in the attribute). They are pointed at network shares — the backup
// folder, project folders — and a share that has gone away can
// block a filesystem call for a long time. On the main thread that froze the
// whole window; off it, the caller's own timeout gets to report the problem.
#[tauri::command(async)]
fn list_dir_entries(path: String, extension: Option<String>) -> Result<Vec<DirEntryInfo>, String> {
    let want_ext = extension.map(|e| e.trim_start_matches('.').to_lowercase());
    let read = std::fs::read_dir(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let mut out = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();

        if let Some(ref ext) = want_ext {
            let matches = std::path::Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase() == *ext)
                .unwrap_or(false);
            if !matches {
                continue;
            }
        }

        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        out.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified_ms,
        });
    }
    Ok(out)
}

#[tauri::command(async)]
fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create {}: {}", path, e))
}

/// Delete a single file. Refuses directories outright — the pruner runs
/// unattended against a user-chosen folder, so it must never be able to remove
/// a directory tree.
#[tauri::command(async)]
fn delete_file(path: String) -> Result<(), String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat {}: {}", path, e))?;
    if meta.is_dir() {
        return Err(format!("Refusing to delete directory {}", path));
    }
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path, e))
}

/// Write a text file atomically: write a sibling temp file, flush it to disk,
/// then rename over the target.
///
/// Used for snapshots instead of `save_text_to_path`. A backup truncated by a
/// crash, a full disk, or a yanked USB drive is worse than no backup at all —
/// the rename means a reader sees either the old snapshot or the new one, never
/// a half-written file. The temp file is created in the same directory so the
/// rename stays within one filesystem.
#[tauri::command(async)]
fn save_text_atomic(path: String, contents: String) -> Result<(), String> {
    use std::io::Write;

    let target = std::path::Path::new(&path);
    let dir = target
        .parent()
        .ok_or_else(|| format!("Invalid path: {}", path))?;
    let tmp = target.with_extension(format!(
        "{}.tmp",
        target.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));

    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    let write_result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()
    })();

    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to write {}: {}", tmp.display(), e));
    }

    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to finalize {}: {}", path, e));
    }
    Ok(())
}

/// Read a text file off the main thread, for files in a linked project folder.
/// `read_text_file` is the same read, run on the main thread for one-off opens.
#[tauri::command(async)]
fn read_text_path(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[derive(serde::Serialize)]
struct PathStat {
    exists: bool,
    is_dir: bool,
    size: u64,
    /// Milliseconds since the Unix epoch; 0 when the platform won't say.
    modified_ms: u64,
}

/// Size and modification time of one path, for noticing that a file linked to
/// a script was changed by something other than DraftCraft.
///
/// A path that does not exist is data, not an error: a project folder on a
/// network drive that is offline right now is an everyday state the caller has
/// to describe, not a failure.
#[tauri::command(async)]
fn stat_path(path: String) -> Result<PathStat, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(PathStat { exists: true, is_dir: meta.is_dir(), size: meta.len(), modified_ms })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(PathStat { exists: false, is_dir: false, size: 0, modified_ms: 0 })
        }
        Err(e) => Err(format!("Failed to stat {}: {}", path, e)),
    }
}

/// Rename a file, used when a script in a folder-linked project is renamed.
///
/// Refuses to replace an existing file: the target is in the writer's own
/// folder, and silently overwriting something of theirs that happens to share
/// the new name would destroy it. A change of letter case only is allowed,
/// since on macOS and Windows that "existing file" is the source itself.
/// Refuses directories for the same reason `delete_file` does.
#[tauri::command(async)]
fn rename_path(from: String, to: String) -> Result<(), String> {
    let src = std::path::Path::new(&from);
    let dst = std::path::Path::new(&to);
    let meta = std::fs::metadata(src).map_err(|e| format!("Failed to stat {}: {}", from, e))?;
    if meta.is_dir() {
        return Err(format!("Refusing to rename directory {}", from));
    }
    let case_only = from != to && from.to_lowercase() == to.to_lowercase();
    if dst.exists() && !case_only {
        return Err(format!("A file named {} already exists", to));
    }
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }
    std::fs::rename(src, dst).map_err(|e| format!("Failed to rename {} to {}: {}", from, to, e))
}

#[derive(serde::Serialize)]
struct PathProbe {
    exists: bool,
    is_dir: bool,
    writable: bool,
    error: Option<String>,
}

/// Report whether a directory exists and can actually be written to.
///
/// Writability is determined by writing and deleting a probe file rather than
/// by inspecting permission bits, which lie on network mounts and under macOS
/// TCC. A missing or unwritable folder is *data*, not an error — the settings
/// UI needs to describe the problem, so `Err` is reserved for genuinely
/// unexpected failures.
#[tauri::command(async)]
fn probe_directory(path: String) -> Result<PathProbe, String> {
    let p = std::path::Path::new(&path);
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(e) => {
            return Ok(PathProbe {
                exists: false,
                is_dir: false,
                writable: false,
                error: Some(e.to_string()),
            })
        }
    };

    if !meta.is_dir() {
        return Ok(PathProbe {
            exists: true,
            is_dir: false,
            writable: false,
            error: Some("Not a folder".into()),
        });
    }

    let probe = p.join(format!(".draftcraft-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(PathProbe { exists: true, is_dir: true, writable: true, error: None })
        }
        Err(e) => Ok(PathProbe {
            exists: true,
            is_dir: true,
            writable: false,
            error: Some(e.to_string()),
        }),
    }
}

/// Reveal a file or folder in the OS file manager.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    // Same sanitation as open_url: reject control characters, and always pass
    // the path as a separate argument so nothing reaches a shell.
    if path.is_empty() || path.chars().any(|c| c.is_control()) {
        return Err("Invalid path".into());
    }

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(&path).spawn();

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };

    result
        .map(|_| ())
        .map_err(|e| format!("Failed to reveal {}: {}", path, e))
}

// ── Generic HTTP fetch command ────────────────────────────────────────────
// Makes HTTP requests from Rust, bypassing WebView mixed-content restrictions.
// The Tauri WebView loads from https://tauri.localhost, so browser fetch() to
// plain http:// addresses (collab server, local backends) is blocked.

/// Wall-clock budget for a single `http_fetch` call.
const HTTP_FETCH_TIMEOUT_SECS: u64 = 10;

#[derive(serde::Serialize)]
struct HttpFetchResponse {
    status: u16,
    body: String,
}

/// Render a reqwest error with its full `source()` chain.
///
/// reqwest's own `Display` stops at the top frame — a DNS failure, a refused
/// connection, a rejected certificate and a hit timeout all render as the
/// identical, useless `error sending request for url (...)`. The cause that
/// actually names the problem lives further down the chain, so walk it.
fn describe_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    if err.is_timeout() {
        parts.push(format!("timed out after {}s", HTTP_FETCH_TIMEOUT_SECS));
    }
    if err.is_connect() {
        parts.push("could not establish a connection".to_string());
    }
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        let text = cause.to_string();
        // hyper re-wraps the same string at several levels; skip repeats so the
        // message stays readable.
        if !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
        source = cause.source();
    }
    parts.join(": ")
}

#[tauri::command]
async fn http_fetch(
    url: String,
    method: Option<String>,
    body: Option<String>,
    content_type: Option<String>,
    authorization: Option<String>,
    // Everything other than Content-Type and Authorization. Those two keep
    // their own parameters so older callers keep working, but anything else the
    // caller set used to be dropped on the floor here, `X-Device-Id` among them.
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<HttpFetchResponse, String> {
    let method_str = method.as_deref().unwrap_or("GET");
    eprintln!("[http_fetch] {} {}", method_str, url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| {
            eprintln!("[http_fetch] Client build error: {}", e);
            format!("HTTP client error: {}", e)
        })?;

    let req_method = method_str.parse::<reqwest::Method>()
        .map_err(|e| format!("Invalid method '{}': {}", method_str, e))?;

    let mut req = client.request(req_method, &url);

    if let Some(ct) = &content_type {
        req = req.header("Content-Type", ct.as_str());
    }

    if let Some(auth) = &authorization {
        req = req.header("Authorization", auth.as_str());
    }

    if let Some(extra) = &headers {
        for (name, value) in extra {
            // Skip the two that have dedicated parameters so a caller passing
            // both cannot set a duplicate header.
            let lower = name.to_ascii_lowercase();
            if lower == "content-type" || lower == "authorization" {
                continue;
            }
            req = req.header(name.as_str(), value.as_str());
        }
    }

    if let Some(b) = &body {
        req = req.body(b.clone());
    }

    let resp = req.send().await
        .map_err(|e| {
            let detail = describe_reqwest_error(&e);
            eprintln!("[http_fetch] {} {} → FAILED: {}", method_str, url, detail);
            format!("Request to {} failed: {}", url, detail)
        })?;

    let status = resp.status().as_u16();
    let body_text = resp.text().await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    eprintln!("[http_fetch] {} {} → {} ({} bytes)", method_str, url, status, body_text.len());

    Ok(HttpFetchResponse {
        status,
        body: body_text,
    })
}

// ── Link preview command ───────────────────────────────────────────────────
// Fetches a URL and extracts Open Graph metadata. Used by the editor's link
// preview feature. Runs in Rust to avoid CORS issues that browser fetch has.

#[derive(serde::Serialize)]
struct LinkPreview {
    url: String,
    title: String,
    description: String,
    image: String,
    site_name: String,
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    let html = fetch_url_body(&url).await.map_err(|e| format!("Failed to fetch {}: {}", url, e))?;

    let title = extract_og_tag(&html, "og:title")
        .or_else(|| extract_html_title(&html))
        .unwrap_or_default();
    let description = extract_og_tag(&html, "og:description")
        .or_else(|| extract_meta_description(&html))
        .unwrap_or_default();
    let image = extract_og_tag(&html, "og:image").unwrap_or_default();
    let site_name = extract_og_tag(&html, "og:site_name").unwrap_or_default();

    Ok(LinkPreview { url, title, description, image, site_name })
}

/// Fetch URL body using reqwest (works on every platform).
/// Times out after 5 seconds.
async fn fetch_url_body(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("Mozilla/5.0 (compatible; DraftCraft/1.0)")
        .build()?;

    let resp = client.get(url).send().await?;
    let body = resp.text().await?;
    Ok(body)
}

/// Extract an Open Graph meta tag value from HTML.
fn extract_og_tag(html: &str, property: &str) -> Option<String> {
    // Match: <meta property="og:title" content="...">
    // Also match: <meta content="..." property="og:title">
    let lower = html.to_lowercase();
    let prop_pattern = format!("property=\"{}\"", property);

    // Find the meta tag containing this property
    let mut search_from = 0;
    while let Some(meta_start) = lower[search_from..].find("<meta ") {
        let abs_start = search_from + meta_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(pos) => abs_start + pos,
            None => break,
        };
        let tag = &html[abs_start..=tag_end];
        let tag_lower = &lower[abs_start..=tag_end];

        if tag_lower.contains(&prop_pattern) {
            if let Some(content) = extract_attr(tag, "content") {
                return Some(decode_html_entities(&content));
            }
        }
        search_from = tag_end + 1;
    }
    None
}

/// Extract the <title> tag content.
fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?.checked_add(lower[lower.find("<title")?..].find('>')?)?;
    let content_start = start + 1;
    let end = lower[content_start..].find("</title>")?;
    let title = html[content_start..content_start + end].trim();
    if title.is_empty() { None } else { Some(decode_html_entities(title)) }
}

/// Extract <meta name="description" content="...">.
fn extract_meta_description(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut search_from = 0;
    while let Some(meta_start) = lower[search_from..].find("<meta ") {
        let abs_start = search_from + meta_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(pos) => abs_start + pos,
            None => break,
        };
        let tag = &html[abs_start..=tag_end];
        let tag_lower = &lower[abs_start..=tag_end];

        if tag_lower.contains("name=\"description\"") {
            if let Some(content) = extract_attr(tag, "content") {
                return Some(decode_html_entities(&content));
            }
        }
        search_from = tag_end + 1;
    }
    None
}

/// Extract an HTML attribute value (case-insensitive attribute name).
fn extract_attr(tag: &str, attr_name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let pattern = format!("{}=\"", attr_name);
    let start = lower.find(&pattern)? + pattern.len();
    let end = lower[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

/// Decode common HTML entities.
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

/// Guess MIME type from file extension.
fn guess_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("pdf") => "application/pdf",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("json") => "application/json",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

// ── New window command (for multi-instance support) ──────────────────────
// Each WebviewWindow gets its own JS context, so editor state is independent.
use std::sync::atomic::{AtomicU32, AtomicBool, Ordering};
static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(1);
/// Set to true once the main window has finished loading.
/// Used to distinguish cold-start file opens (load into main window)
/// from warm-start file opens (open in a new window).
static APP_READY: AtomicBool = AtomicBool::new(false);

/// Update the native window title and refresh the Window menu list.
/// Called from the frontend whenever the document title changes.
#[tauri::command]
async fn set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let display_title = if title.is_empty() { "DraftCraft".to_string() } else { format!("{} — DraftCraft", title) };
        window.set_title(&display_title).map_err(|e| format!("{}", e))?;
        // Rebuild the Window menu to reflect current window titles
        let app = window.app_handle();
        if let Some(menu) = app.menu() {
            rebuild_window_menu(app, &menu);
        }
    }
    Ok(())
}

/// Open a URL in the user's default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Only allow http/https URLs
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http and https URLs are allowed".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}

/// Rebuild the Window menu: standard items + list of all open windows.
#[cfg(desktop)]
#[allow(unused_variables)]
fn rebuild_window_menu(app: &tauri::AppHandle, _menu: &Menu<tauri::Wry>) {
    #[cfg(not(target_os = "macos"))]
    return;

    #[cfg(target_os = "macos")]
    {
        // Build a fresh Window submenu with standard items + window list
        let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![
            Box::new(PredefinedMenuItem::minimize(app, None).unwrap()),
            Box::new(PredefinedMenuItem::maximize(app, None).unwrap()),
            Box::new(PredefinedMenuItem::separator(app).unwrap()),
            Box::new(PredefinedMenuItem::close_window(app, None).unwrap()),
        ];

        // Add all open windows
        let windows = app.webview_windows();
        let mut win_entries: Vec<_> = windows.iter()
            .filter(|(label, _)| *label != "splashscreen")
            .collect();
        win_entries.sort_by_key(|(label, _)| label.clone());

        if !win_entries.is_empty() {
            items.push(Box::new(PredefinedMenuItem::separator(app).unwrap()));
            for (label, win) in &win_entries {
                let title = win.title().unwrap_or_else(|_| (*label).clone());
                let item_id = format!("window-list-{}", label);
                if let Ok(mi) = MenuItem::with_id(app, &item_id, &title, true, None::<&str>) {
                    items.push(Box::new(mi));
                }
            }
        }

        // Convert to references for Submenu::with_items
        let item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter()
            .map(|b| b.as_ref())
            .collect();

        if let Ok(new_window_sub) = Submenu::with_items(app, "Window", true, &item_refs) {
            // Replace the Window submenu in the app menu
            if let Some(menu) = app.menu() {
                // Remove old Window submenu and append new one
                if let Ok(menu_items) = menu.items() {
                    for item in &menu_items {
                        if let tauri::menu::MenuItemKind::Submenu(sub) = item {
                            if sub.text().unwrap_or_default() == "Window" {
                                let _ = menu.remove(item);
                                break;
                            }
                        }
                    }
                }
                let _ = menu.append(&new_window_sub);
            }
        }
    }
}

/// One of the app's open windows, for the "already open over there" prompt.
#[derive(serde::Serialize)]
struct WindowInfo {
    label: String,
    title: String,
}

/// The windows that exist right now.
///
/// The frontend keeps its own note of which document each window is showing,
/// but it cannot tell a window that closed from one that is still open — that
/// answer only exists here. Anything not in this list is a stale note.
#[tauri::command]
async fn list_windows(app: tauri::AppHandle) -> Vec<WindowInfo> {
    app.webview_windows()
        .iter()
        .filter(|(label, _)| *label != "splashscreen")
        .map(|(label, window)| WindowInfo {
            label: label.clone(),
            title: window.title().unwrap_or_else(|_| label.clone()),
        })
        .collect()
}

/// Bring a window to the front.
///
/// The answer to "this screenplay is already open in another window" — the one
/// that avoids a second editor autosaving over the first.
#[tauri::command]
async fn focus_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "That window has since been closed.".to_string())?;

    let _ = window.unminimize();
    let _ = window.show();
    window
        .set_focus()
        .map_err(|e| format!("Could not switch windows: {}", e))
}

#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("main-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));

    // Use "/" so BrowserRouter matches the root route (not "/index.html")
    let url = tauri::WebviewUrl::App("/".into());
    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title("DraftCraft")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;
    // Refresh window list in the Window menu
    if let Some(menu) = app.menu() {
        rebuild_window_menu(&app, &menu);
    }
    Ok(())
}

/// WebKitGTK renders the window on the GPU, and some Linux drivers can't take it.
/// Its DMA-BUF renderer leaves a blank window on a range of drivers, and nouveau
/// (old NVIDIA cards the proprietary driver no longer supports) can lock the GPU
/// outright, freezing the whole desktop. Both are WebKit's own
/// switches, so a variable the user has already set, `=0` included, is left alone.
#[cfg(target_os = "linux")]
fn webkit_env_for_drivers(drivers: &[String]) -> Vec<(&'static str, &'static str)> {
    let mut vars = vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")];
    if drivers.iter().any(|d| d == "nouveau") {
        vars.push(("WEBKIT_DISABLE_COMPOSITING_MODE", "1"));
    }
    vars
}

/// Kernel drivers bound to the machine's DRM cards, e.g. ["nouveau"] or ["i915", "nvidia"].
#[cfg(target_os = "linux")]
fn drm_drivers() -> Vec<String> {
    let entries = match std::fs::read_dir("/sys/class/drm") {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("[gpu] Could not read /sys/class/drm: {}", e);
            return Vec::new();
        }
    };
    let mut drivers: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            // card0, card1… — not the connectors (card0-HDMI-A-1) or render nodes
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("card") || name.contains('-') {
                return None;
            }
            let target = std::fs::read_link(entry.path().join("device/driver")).ok()?;
            Some(target.file_name()?.to_string_lossy().into_owned())
        })
        .collect();
    drivers.sort();
    drivers.dedup();
    drivers
}

#[cfg(target_os = "linux")]
fn configure_webkit_rendering() {
    let drivers = drm_drivers();
    eprintln!("[gpu] DRM drivers: {:?}", drivers);
    for (key, value) in webkit_env_for_drivers(&drivers) {
        match std::env::var_os(key) {
            Some(existing) => eprintln!("[gpu] {} already set to {:?}, leaving it", key, existing),
            None => {
                // Runs first thing in run(), before Tauri or WebKit start any threads.
                std::env::set_var(key, value);
                eprintln!("[gpu] Set {}={}", key, value);
            }
        }
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_webkit_rendering();

    let builder = tauri::Builder::default()
        // ── Plugins (available on all platforms) ────────────────────────
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(live::LiveState::default())
        // ── Asset protocol: serve local files for convertFileSrc() URLs ──
        .register_uri_scheme_protocol("asset", |_app, request| {
            let uri = request.uri();
            let raw_path = uri.path();
            // Decode the percent-encoded path. The URL's own leading slash is
            // dropped, then the root slash is put back for macOS and Linux
            // paths (/Users/..., /home/...). Windows drive paths (C:\...)
            // and network paths (\\server\...) are used as they are.
            let decoded = percent_decode_str(raw_path).decode_utf8_lossy();
            let trimmed = decoded.trim_start_matches('/');
            let tb = trimmed.as_bytes();
            let has_drive = tb.len() >= 2 && tb[0].is_ascii_alphabetic() && tb[1] == b':';
            let is_network = trimmed.starts_with('\\');
            let rooted: String = if has_drive || is_network {
                trimmed.to_string()
            } else {
                format!("/{}", trimmed)
            };
            let file_path_str: &str = rooted.as_str();
            let file_path = std::path::Path::new(file_path_str);

            // Build a Response without unwrapping — a panic here aborts the
            // whole process because [profile.release] panic = "abort".
            let build_response = |status: u16, mime: &str, body: Vec<u8>| {
                tauri::http::Response::builder()
                    .status(status)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(body)
                    .unwrap_or_else(|_| {
                        tauri::http::Response::new(Vec::new())
                    })
            };
            match std::fs::read(file_path) {
                Ok(data) => build_response(200, guess_mime(file_path), data),
                Err(e) => {
                    eprintln!("[asset] Failed to read {}: {}", file_path_str, e);
                    build_response(404, "text/plain", Vec::new())
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            live::live_host_prepare,
            live::live_host_accept,
            live::live_join_prepare,
            live::live_join_connect,
            live::live_send,
            live::live_close,
            keep_original_copy,
            save_text_to_path,
            save_binary_to_path,
            read_text_file,
            read_binary_file,
            list_dir_entries,
            ensure_dir,
            delete_file,
            save_text_atomic,
            probe_directory,
            stat_path,
            rename_path,
            read_text_path,
            reveal_path,
            http_fetch,
            fetch_link_preview,
            get_opened_file,
            open_new_window,
            list_windows,
            focus_window,
            set_window_title,
            open_url,
        ]);

        // ── Native menu (desktop only) ────────────────────────────────
        // macOS: App menu + Edit menu (Cmd+C/V/X/A/Z) + Window menu.
        //        The Edit menu is required for clipboard & undo shortcuts
        //        to reach the webview on macOS.
        // Windows/Linux: empty menu — no native menu bar shown.
        #[cfg(desktop)]
        let builder = builder.menu(|app_handle| {
            #[cfg(target_os = "macos")]
            {
                let app_submenu = Submenu::with_items(
                    app_handle,
                    "DraftCraft",
                    true,
                    &[
                        &PredefinedMenuItem::about(app_handle, Some("About DraftCraft"), None)?,
                        &PredefinedMenuItem::separator(app_handle)?,
                        &PredefinedMenuItem::services(app_handle, None)?,
                        &PredefinedMenuItem::separator(app_handle)?,
                        &PredefinedMenuItem::hide(app_handle, None)?,
                        &PredefinedMenuItem::hide_others(app_handle, None)?,
                        &PredefinedMenuItem::show_all(app_handle, None)?,
                        &PredefinedMenuItem::separator(app_handle)?,
                        &PredefinedMenuItem::quit(app_handle, None)?,
                    ],
                )?;
                let edit_submenu = Submenu::with_items(
                    app_handle,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app_handle, None)?,
                        &PredefinedMenuItem::redo(app_handle, None)?,
                        &PredefinedMenuItem::separator(app_handle)?,
                        &PredefinedMenuItem::cut(app_handle, None)?,
                        &PredefinedMenuItem::copy(app_handle, None)?,
                        &PredefinedMenuItem::paste(app_handle, None)?,
                        &PredefinedMenuItem::select_all(app_handle, None)?,
                    ],
                )?;
                let window_submenu = Submenu::with_items(
                    app_handle,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app_handle, None)?,
                        &PredefinedMenuItem::maximize(app_handle, None)?,
                        &PredefinedMenuItem::separator(app_handle)?,
                        &PredefinedMenuItem::close_window(app_handle, None)?,
                    ],
                )?;
                Menu::with_items(app_handle, &[&app_submenu, &edit_submenu, &window_submenu])
            }
            #[cfg(not(target_os = "macos"))]
            {
                Menu::new(app_handle)
            }
        });

    let builder = builder.setup(|app| {
            // Ensure user data directory exists
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");
            std::fs::create_dir_all(&app_data_dir).ok();

            eprintln!("DraftCraft starting");
            eprintln!("Data dir: {}", app_data_dir.display());

            // ── Check for file association launch ──────────────────────────
            let mut pending: Option<String> = None;

            // Windows/Linux: check CLI args
            {
                let args: Vec<String> = std::env::args().collect();
                if args.len() > 1 {
                    let path = &args[1];
                    if is_openable_file(path) && std::path::Path::new(path).is_file() {
                        eprintln!("File association launch: {}", path);
                        pending = Some(path.clone());
                    }
                }
            }

            app.manage(PendingFile(Mutex::new(pending)));

            // ── Desktop: show splash then transition to main window ───
            {
                let splash = app.get_webview_window("splashscreen");
                let main_window = app.get_webview_window("main");

                std::thread::spawn(move || {
                    // Splash display: long enough for its fade-ins to finish
                    std::thread::sleep(std::time::Duration::from_millis(2500));

                    if let Some(main) = main_window {
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                    if let Some(sp) = splash {
                        let _ = sp.close();
                    }
                    // Mark app as ready — subsequent file opens go to new windows
                    APP_READY.store(true, Ordering::Release);
                });
            }

            Ok(())
        });

    // Handle Window menu clicks to focus the selected window
    #[cfg(desktop)]
    let builder = builder.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if let Some(label) = id.strip_prefix("window-list-") {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    })
    .on_window_event(|window, event| {
        if let tauri::WindowEvent::Destroyed = event {
            let app = window.app_handle();
            if let Some(menu) = app.menu() {
                rebuild_window_menu(app, &menu);
            }
        }
    });

    let app = builder
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            let msg = format!("FATAL: Failed to build Tauri app: {}", e);
            eprintln!("{}", msg);
            let _ = std::fs::write("/tmp/draftcraft_crash.log", &msg);
            panic!("{}", msg);
        });

    app.run(|_app_handle, _event| {
        // ── Handle file association open events (macOS) ────────────
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let path_str = path.to_string_lossy().to_string();
                    if !is_openable_file(&path_str) {
                        continue;
                    }

                    eprintln!("[file-assoc] RunEvent::Opened: {}", path_str);

                    // Desktop warm start: open file in a new window
                    #[cfg(desktop)]
                    if APP_READY.load(Ordering::Acquire) {
                        eprintln!("[file-assoc] App already running — opening in new window");
                        let count = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
                        let label = format!("main-{}", count);
                        let url = tauri::WebviewUrl::App("/".into());
                        match tauri::WebviewWindowBuilder::new(_app_handle, &label, url)
                            .title("DraftCraft")
                            .inner_size(1280.0, 800.0)
                            .min_inner_size(800.0, 600.0)
                            .resizable(true)
                            .build()
                        {
                            Ok(_new_win) => {
                                // Use emit_to with the label to target ONLY the new window.
                                // WebviewWindow::emit() broadcasts to all windows.
                                let handle = _app_handle.clone();
                                let target_label = label.clone();
                                let path_for_emit = path_str.clone();
                                std::thread::spawn(move || {
                                    for delay_ms in [500, 1500, 3000] {
                                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                                        let _ = handle.emit_to(&target_label, "open-file", &path_for_emit);
                                    }
                                });
                                continue; // skip the old broadcast path
                            }
                            Err(e) => {
                                eprintln!("[file-assoc] Failed to create new window: {}", e);
                                // Fall through to old behavior
                            }
                        }
                    }

                    // Cold start / fallback: load into the main window
                    // Store in pending state so frontend can retrieve it
                    if let Some(state) = _app_handle.try_state::<PendingFile>() {
                        *state.0.lock().unwrap() = Some(path_str.clone());
                    }

                    // Emit to the main window only (not all windows)
                    let _ = _app_handle.emit_to("main", "open-file", &path_str);

                    // Re-emit after delays to handle cold-start timing
                    // The WebView may not have loaded JS listeners yet
                    let handle = _app_handle.clone();
                    let path_for_retry = path_str.clone();
                    std::thread::spawn(move || {
                        for delay_ms in [500, 1500, 3000] {
                            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                            eprintln!("[file-assoc] re-emit open-file after {}ms", delay_ms);
                            let _ = handle.emit_to("main", "open-file", &path_for_retry);
                        }
                    });
                }
            }
        }
    });
}

#[cfg(all(test, target_os = "linux"))]
mod webkit_env_tests {
    use super::webkit_env_for_drivers;

    fn drivers(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn dmabuf_renderer_is_always_disabled() {
        assert_eq!(
            webkit_env_for_drivers(&drivers(&["i915"])),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        assert_eq!(
            webkit_env_for_drivers(&[]),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }

    #[test]
    fn nouveau_also_disables_compositing() {
        let vars = webkit_env_for_drivers(&drivers(&["i915", "nouveau"]));
        assert!(vars.contains(&("WEBKIT_DISABLE_COMPOSITING_MODE", "1")));
        assert!(vars.contains(&("WEBKIT_DISABLE_DMABUF_RENDERER", "1")));
    }
}
