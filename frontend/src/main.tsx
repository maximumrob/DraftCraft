import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { initScratchAssets } from './services/scratchAssets';
import { scheduleScratchSweep } from './services/scratchSweep';
import { initCustomFonts } from './services/customFonts';
import { detectDeviceFonts } from './utils/deviceFonts';
import { applyAppearance, applyNativeTheme, readAppearance } from './utils/appearance';

async function init() {
  // Apply the remembered appearance before first render to avoid a flash.
  applyAppearance(readAppearance());
  // Not awaited: the native popups only need it by the time one is opened.
  void applyNativeTheme(readAppearance());

  // Track the visual viewport height as a CSS variable so dialogs and overlays
  // can follow it.
  const updateViewportHeight = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vv-height', `${h}px`);
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportHeight);
    window.visualViewport.addEventListener('scroll', updateViewportHeight);
  }
  window.addEventListener('resize', updateViewportHeight);
  updateViewportHeight();

  // Where images go for a document that has no project yet, so the bytes never
  // sit inside the document (and never inside a recovery snapshot). Awaited:
  // once it resolves, image URLs resolve synchronously on Tauri.
  await initScratchAssets();
  // Housekeeping for images left behind by abandoned documents. Deliberately
  // late and idle — a delayed sweep costs disk, a hasty one costs a picture.
  scheduleScratchSweep();

  // Bring back the writer's own TTF/OTF fonts, and work out which of the
  // registry's system faces this machine actually has, before the first
  // document renders — otherwise a script written in an installed font shows
  // Courier for a frame. Neither can stop the app starting.
  initCustomFonts().catch((err) => console.warn('[fonts] custom fonts unavailable:', err));

  // Measuring a few hundred families is a few hundred canvas calls on the main
  // thread — nothing next to a document, but no reason to make first paint wait
  // for it either.
  const findDeviceFonts = () => {
    try {
      detectDeviceFonts();
    } catch (err) {
      console.warn('[fonts] device font detection failed:', err);
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(findDeviceFonts, { timeout: 4000 });
  else setTimeout(findDeviceFonts, 1200);

  // Set initial native window title on desktop (for macOS Window menu)
  import('./services/platform').then(({ isDesktopTauri }) => {
    if (!isDesktopTauri()) return;
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('set_window_title', { title: 'Untitled Screenplay' }).catch(() => {});
    });
  });

  // Clear the loading-timeout diagnostic (and remove overlay if it fired early)
  if ((window as any)._renderTimeout) clearTimeout((window as any)._renderTimeout);
  const fatalOverlay = document.getElementById('_fatal');
  if (fatalOverlay) fatalOverlay.remove();

  // Retire the "DraftCraft failed to start" overlay for the rest of the
  // session: from here on a stray error or rejection is a fault inside a
  // running app, and a full-screen overlay with no way out of it would strand
  // the writer in their document. See the flag's note in index.html.
  (window as any).__odBooted = true;

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

init().catch((err) => {
  console.error('Fatal init error:', err);
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:99999;background:#1a1a2e;color:#ff6b6b;font:14px/1.6 monospace;padding:40px;white-space:pre-wrap;';
  d.textContent = 'DraftCraft failed to start:\n\n' + (err?.stack || err?.message || String(err));
  document.body.appendChild(d);
});
