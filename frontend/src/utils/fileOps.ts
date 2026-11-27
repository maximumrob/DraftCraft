/**
 * Cross-platform file operations.
 *
 * In the desktop app: native OS dialogs (via @tauri-apps/plugin-dialog) and
 * custom Tauri commands for reading and writing outside the fs scope.
 *
 * In a browser: standard browser APIs (anchor download for save,
 * <input type="file"> for open).
 */
import { isTauri } from '../services/platform';

interface FileFilter {
  name: string;
  extensions: string[];
}

// ── Save ────────────────────────────────────────────────────────────────────

/**
 * Save data to a file.
 * Desktop app → native "Save As" dialog.
 * Web → browser download to Downloads folder.
 * Returns true if saved, false if user cancelled.
 */
export async function saveFile(
  data: Uint8Array | string,
  defaultFilename: string,
  filters?: FileFilter[],
): Promise<boolean> {
  if (isTauri()) {
    return saveFileTauri(data, defaultFilename, filters);
  }
  return saveFileBrowser(data, defaultFilename);
}

/**
 * Where the save dialog should open: beside the file being edited, or in
 * Documents when the document has no file. A bare filename leaves the dialog
 * to open wherever it last was, which is the home folder.
 */
async function saveDialogPath(filename: string): Promise<string> {
  try {
    if (!isTauri()) return filename;
    const { useEditorStore } = await import('../stores/editorStore');
    const lf = await import('./paths');
    const origin = useEditorStore.getState().documentOrigin;
    let dir: string | null = origin ? lf.dirnameOf(origin.bookmark) : null;
    if (!dir) {
      const { documentDir } = await import('@tauri-apps/api/path');
      dir = await documentDir();
    }
    return dir ? lf.joinPath(dir, filename) : filename;
  } catch {
    return filename;
  }
}

async function saveFileTauri(
  data: Uint8Array | string,
  defaultFilename: string,
  filters?: FileFilter[],
): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { invoke } = await import('@tauri-apps/api/core');

  const path = await save({ defaultPath: await saveDialogPath(defaultFilename), filters });
  if (!path) return false;

  if (typeof data === 'string') {
    await invoke('save_text_to_path', { path, contents: data });
  } else {
    await invoke('save_binary_to_path', { path, contents: Array.from(data) });
  }
  return true;
}

function saveFileBrowser(
  data: Uint8Array | string,
  defaultFilename: string,
): boolean {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: 'text/plain' })
      : new Blob([data] as BlobPart[]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Delay revoke so the browser has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

// ── Open (text) ─────────────────────────────────────────────────────────────

/**
 * Open a text file.
 * Desktop app → native "Open" dialog.
 * Web → <input type="file"> picker.
 * Returns { name, content } or null if user cancelled.
 */
export async function openTextFile(
  filters?: FileFilter[],
): Promise<{ name: string; content: string } | null> {
  if (isTauri()) {
    return openTextFileTauri(filters);
  }
  return openTextFileBrowser(filters);
}

async function openTextFileTauri(
  filters?: FileFilter[],
): Promise<{ name: string; content: string } | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { invoke } = await import('@tauri-apps/api/core');

  const selected = await open({ multiple: false, filters });
  if (!selected) return null;

  const path = selected as string;
  const content: string = await invoke('read_text_file', { path });
  const name = path.split(/[/\\]/).pop() || 'file';
  return { name, content };
}

function openTextFileBrowser(
  filters?: FileFilter[],
): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (filters) {
      input.accept = filters
        .flatMap((f) => f.extensions.map((e) => `.${e}`))
        .join(',');
    }
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({ name: file.name, content: reader.result as string });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

// ── Open (text or binary, chosen by extension) ──────────────────────────────

export interface OpenedFile {
  name: string;
  /** Set for text formats. */
  text: string | null;
  /** Set for the formats listed in `binaryExtensions` (archives). */
  bytes: ArrayBuffer | null;
}

function extensionOf(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Open a file whose reading mode depends on its extension.
 *
 * Screenplay import accepts both plain-text formats (.fountain, .fdx) and
 * archives (.fadein), but which one the user picks isn't known until the
 * dialog closes, so the read mode has to be decided from the chosen name.
 */
export async function openTextOrBinaryFile(
  filters: FileFilter[] | undefined,
  binaryExtensions: string[],
): Promise<OpenedFile | null> {
  const isBinary = (name: string) => binaryExtensions.includes(extensionOf(name));

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');

    const selected = await open({ multiple: false, filters });
    if (!selected) return null;

    const path = selected as string;
    const name = path.split(/[/\\]/).pop() || 'file';
    if (isBinary(name)) {
      const data: number[] = await invoke('read_binary_file', { path });
      return { name, text: null, bytes: new Uint8Array(data).buffer };
    }
    const text: string = await invoke('read_text_file', { path });
    return { name, text, bytes: null };
  }

  return openTextOrBinaryFileBrowser(filters, isBinary);
}

function openTextOrBinaryFileBrowser(
  filters: FileFilter[] | undefined,
  isBinary: (name: string) => boolean,
): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (filters) {
      input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    }
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      const binary = isBinary(file.name);
      reader.onload = () =>
        resolve(
          binary
            ? { name: file.name, text: null, bytes: reader.result as ArrayBuffer }
            : { name: file.name, text: reader.result as string, bytes: null },
        );
      reader.onerror = () => resolve(null);
      if (binary) reader.readAsArrayBuffer(file);
      else reader.readAsText(file);
    };
    input.click();
  });
}

// ── Open (font files) ───────────────────────────────────────────────────────

export interface PickedFontFile {
  name: string;
  bytes: ArrayBuffer;
}

/** The font containers a writer can install. */
export const FONT_FILE_EXTENSIONS = ['ttf', 'otf', 'ttc', 'woff', 'woff2'];

/**
 * Pick one or more font files to install.
 *
 *   desktop  the native dialog, because WKWebView and WebView2 do not give a
 *            file input a usable panel from a `tauri://` page, the same
 *            reason `openTextOrBinaryFile` uses the dialog plugin.
 *   web      a file input, filtered.
 */
export async function pickFontFiles(): Promise<PickedFontFile[]> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Fonts', extensions: FONT_FILE_EXTENSIONS }],
    });
    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected as string];
    const out: PickedFontFile[] = [];
    for (const path of paths) {
      const name = path.split(/[/\\]/).pop() || 'font';
      const data: number[] = await invoke('read_binary_file', { path });
      out.push({ name, bytes: new Uint8Array(data).buffer });
    }
    return out;
  }

  return pickFontFilesBrowser();
}

function pickFontFilesBrowser(): Promise<PickedFontFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = FONT_FILE_EXTENSIONS.map((e) => `.${e}`).join(',');
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      try {
        resolve(await Promise.all(files.map(async (file) => ({
          name: file.name,
          bytes: await file.arrayBuffer(),
        }))));
      } catch {
        resolve([]);
      }
    };
    input.click();
  });
}

// ── Open in place ───────────────────────────────────────────────────────────

/**
 * A document being edited where it lives, rather than as an imported copy.
 *
 * `bookmark` is an opaque handle, never something to show a person. On the
 * desktop it is the file's path: there is no sandbox to satisfy, and a path is
 * already durable, so the same file can be opened on Monday and saved on
 * Tuesday.
 */
export interface InPlaceDocument {
  name: string;
  /** Set for the text formats. */
  text: string | null;
  /** Set for the archive formats, .fadein is a zip. */
  bytes: ArrayBuffer | null;
  bookmark: string;
}

/**
 * What came back from the picker.
 *
 * `unsupported` is a real outcome rather than an error: the check happens after
 * the choice, and it has to happen *before* the read, or an unsupported file
 * surfaces as "could not open the file", which reads as if it were missing
 * rather than simply not a screenplay.
 */
export type OpenInPlaceOutcome =
  | { status: 'cancelled' }
  | { status: 'unsupported'; name: string; extension: string }
  | { status: 'opened'; document: InPlaceDocument };

/** What the desktop dialog offers. */
const SCREENPLAY_IN_PLACE_FILTERS: FileFilter[] = [
  { name: 'Screenplay', extensions: ['dcraft', 'fdx', 'fountain', 'fadein', 'osf', 'txt'] },
];

/** True where {@link openDocumentInPlace} can be used, everywhere but the web. */
export function supportsOpenInPlace(): boolean {
  return isTauri();
}

/**
 * Present the document picker and open the chosen file in place.
 *
 * The chosen file is validated before it is read: `editable` lists what the
 * caller can write back, `binary` says which of those are containers rather
 * than text. Throws with a user-facing message when a supported file could not
 * be read, a network share may be offline, or the document may have been
 * moved since.
 */
export async function openDocumentInPlace(
  editable: string[],
  binary: string[] = [],
): Promise<OpenInPlaceOutcome> {
  const picked = await pickInPlaceDocument();
  if (!picked) return { status: 'cancelled' };

  const extension = extensionOf(picked.name);
  if (!editable.includes(extension)) {
    return { status: 'unsupported', name: picked.name, extension };
  }

  const document = await readInPlaceDocument(picked, binary.includes(extension));
  return { status: 'opened', document };
}

interface PickedFile {
  name: string;
  bookmark: string;
}

/** The picker. Returns null when the writer cancelled. */
async function pickInPlaceDocument(): Promise<PickedFile | null> {
  if (isTauri()) {
    // The path is the handle, and the native dialog can filter by extension
    // properly, so an unsupported file is hard to pick in the first place, the
    // check still runs, for a path typed by hand.
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ multiple: false, filters: SCREENPLAY_IN_PLACE_FILTERS });
    if (!selected) return null;
    const path = selected as string;
    return { name: path.split(/[/\\]/).pop() || 'Untitled', bookmark: path };
  }

  throw new Error('Opening a file in place is not available in the browser.');
}

/** Read a picked file, as bytes for the archive formats and text otherwise. */
async function readInPlaceDocument(
  picked: PickedFile,
  asBytes: boolean,
): Promise<InPlaceDocument> {
  const { invoke } = await import('@tauri-apps/api/core');

  if (asBytes) {
    const data = await invoke<number[]>('read_binary_file', { path: picked.bookmark });
    return {
      name: picked.name,
      text: null,
      bytes: new Uint8Array(data).buffer,
      bookmark: picked.bookmark,
    };
  }
  const text = await invoke<string>('read_text_file', { path: picked.bookmark });
  return { name: picked.name, text, bytes: null, bookmark: picked.bookmark };
}

/** Paths whose original contents were already kept during this session. */
const originalKept = new Set<string>();

/**
 * Keep a copy of the file as it is now before the first overwrite. If the copy
 * cannot be made the save is refused: the original may be the only one.
 */
async function keepOriginalOnce(path: string): Promise<void> {
  if (originalKept.has(path)) return;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('keep_original_copy', { path });
  } catch (err) {
    throw new Error(
      `Could not keep a safety copy of the original file, so it was left unchanged (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  originalKept.add(path);
}

/**
 * Write text back over the document the user opened.
 *
 * Throws with a user-facing message on failure. Callers must treat that as
 * "not saved" and keep the editor dirty, silently swallowing it would tell
 * the writer their work is safe on a file that never received it.
 */
export async function saveDocumentInPlace(
  bookmark: string,
  contents: string | Uint8Array,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  // Tauri's IPC carries a byte array as a plain number array.
  const bytes = typeof contents === 'string' ? null : Array.from(contents);

  if (!isTauri()) {
    throw new Error('Saving a file in place is not available in the browser.');
  }

  await keepOriginalOnce(bookmark);

  // The bookmark is the path. save_text_atomic writes through a temporary file,
  // which is what keeps a half-written screenplay from replacing a whole one if
  // the machine gives up mid-save.
  if (bytes) {
    await invoke('save_binary_to_path', { path: bookmark, contents: bytes });
  } else {
    await invoke('save_text_atomic', { path: bookmark, contents });
  }
}

// ── Open (binary) ───────────────────────────────────────────────────────────

/**
 * Open a binary file.
 * Desktop app → native "Open" dialog.
 * Web → <input type="file"> picker.
 * Returns { name, content: ArrayBuffer } or null if user cancelled.
 */
export async function openBinaryFile(
  filters?: FileFilter[],
): Promise<{ name: string; content: ArrayBuffer } | null> {
  if (isTauri()) {
    return openBinaryFileTauri(filters);
  }
  return openBinaryFileBrowser(filters);
}

async function openBinaryFileTauri(
  filters?: FileFilter[],
): Promise<{ name: string; content: ArrayBuffer } | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { invoke } = await import('@tauri-apps/api/core');

  const selected = await open({ multiple: false, filters });
  if (!selected) return null;

  const path = selected as string;
  const data: number[] = await invoke('read_binary_file', { path });
  const name = path.split(/[/\\]/).pop() || 'file';
  return { name, content: new Uint8Array(data).buffer };
}

function openBinaryFileBrowser(
  filters?: FileFilter[],
): Promise<{ name: string; content: ArrayBuffer } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (filters) {
      input.accept = filters
        .flatMap((f) => f.extensions.map((e) => `.${e}`))
        .join(',');
    }
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({ name: file.name, content: reader.result as ArrayBuffer });
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}
