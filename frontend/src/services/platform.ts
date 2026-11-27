/**
 * Platform detection utilities.
 *
 * Determines whether we are running as a plain web app in the browser or as
 * the Tauri desktop app (macOS / Windows / Linux).
 */

/** True when running inside the Tauri WebView (the desktop app). */
export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

/**
 * Opens a URL outside the app, in the system browser.
 *
 * `window.open` is only right in a browser tab; inside the desktop app the
 * opener plugin hands the URL to the system's default browser.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** True when running as the Tauri desktop app. */
export function isDesktopTauri(): boolean {
  return isTauri();
}

/** True when running as a plain browser web app (no Tauri). */
export function isWeb(): boolean {
  return !isTauri();
}

/** Detects the OS from the user agent. */
export function getOS(): 'macos' | 'windows' | 'linux' | 'unknown' {
  const ua = navigator.userAgent || '';
  if (/macintosh|mac os x/i.test(ua)) return 'macos';
  if (/windows/i.test(ua)) return 'windows';
  if (/linux/i.test(ua)) return 'linux';
  return 'unknown';
}

/** True when the window uses a custom titlebar (decorations: false).
 *  In the desktop app the MenuBar acts as the titlebar with window controls. */
export function hasCustomTitlebar(): boolean {
  return isDesktopTauri();
}

/**
 * Read a header value from any of the three shapes RequestInit.headers can
 * take: Headers, Record<string,string>, or [name,value][]. The previous
 * implementation only handled the plain-object form, which silently dropped
 * the Authorization header that authedFetch attaches via `new Headers()`,
 * resulting in a 401 storm on every authed request from Tauri.
 */
function pickHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === lower);
    return hit ? hit[1] : undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Flatten any of the three RequestInit.headers shapes into a plain object.
 *
 * Content-Type and Authorization keep their dedicated invoke parameters, so
 * they are left out here; every other header used to be silently dropped on
 * the way through the Rust side, which is how `X-Device-Id` went missing.
 */
function collectExtraHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const skip = new Set(['content-type', 'authorization']);
  const add = (k: string, v: string) => {
    if (!skip.has(String(k).toLowerCase())) out[String(k)] = String(v);
  };
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((v, k) => add(k, v));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) add(k, v);
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) add(k, v);
  }
  return out;
}

/**
 * Platform-aware fetch that works around Tauri's mixed-content restriction.
 *
 * The Tauri WebView loads from https://tauri.localhost, so browser fetch()
 * to plain http:// addresses (collab server, local backends) is blocked by
 * WKWebView as mixed content.  In the desktop app we route through a Rust
 * command; in a browser we use standard fetch().
 */
export async function platformFetch(url: string, options?: RequestInit): Promise<Response> {
  if (!isTauri()) return fetch(url, options);

  const method = options?.method || 'GET';
  console.log(`[platformFetch] ${method} ${url} (via Tauri invoke)`);

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ status: number; body: string }>('http_fetch', {
      url,
      method,
      body: typeof options?.body === 'string' ? options.body : undefined,
      contentType: pickHeader(options?.headers, 'Content-Type'),
      authorization: pickHeader(options?.headers, 'Authorization'),
      headers: collectExtraHeaders(options?.headers),
    });

    console.log(`[platformFetch] ${method} ${url} → ${result.status} (${result.body.length} bytes)`);

    return new Response(result.body, {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`[platformFetch] ${method} ${url} → invoke FAILED:`, err);
    throw err;
  }
}
