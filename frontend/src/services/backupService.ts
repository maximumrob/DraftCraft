/**
 * Reading and writing backup snapshots in the user's chosen folder.
 *
 * The folder is named by an absolute path, and each snapshot is a path too.
 * Filenames, retention, the project subfolders and the .dcraft payload are the
 * same on every desktop platform, so the Recover dialog can open a backup
 * written on a Mac from a Windows or Linux machine.
 *
 * Not available in the browser, where there is nothing that survives a reload.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';
import { useSettingsStore } from '../stores/settingsStore';
import {
  buildBackupFilename, buildProjectFolderName, parseBackupFilename, selectForPruning,
  type ParsedBackup,
} from '../utils/backupNaming';
import {
  serializeDCraft, parseDCraft,
  type ParsedDCraft, type BackupKind,
} from '../utils/dcraftFormat';
import { packScratchAssets } from './snapshotAssets';
import { collectScratchIds } from '../utils/scratchRefs';
import type { ScriptMeta } from '../utils/scriptMeta';

/** A slow or disconnected network share must not leave a promise pending forever. */
const WRITE_TIMEOUT_MS = 10_000;

export interface BackupEntry {
  /** The snapshot's path. */
  path: string;
  name: string;
  title: string;
  scriptKey: string;
  date: Date;
  /** 'external' = a .dcraft file in the folder that DraftCraft did not write. */
  kind: 'auto' | 'manual' | 'external';
  sizeBytes: number;
  /**
   * Project folder the snapshot sits in, relative to the backup folder. Empty
   * for the flat files older builds wrote straight into the root.
   */
  project: string;
}

interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
}

/** A file in the backup folder. */
interface RawBackupFile {
  name: string;
  path: string;
  project: string;
  sizeBytes: number;
  modifiedMs: number;
}

/** True where a backup folder can be chosen at all: the app, not a browser tab. */
export function backupsSupported(): boolean {
  return isTauri();
}

/** True where a snapshot can be shown to the user in a file manager. */
export function supportsRevealBackup(): boolean {
  return isTauri();
}

/** True when snapshots can actually be written right now. */
export function backupsAvailable(): boolean {
  if (!backupsSupported()) return false;
  return Boolean(useSettingsStore.getState().backupFolder);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
}

/**
 * Every `.dcraft` under the backup folder: the project subfolders, plus the
 * root itself for snapshots written before backups were grouped by project.
 *
 * Descends exactly one level. The folder belongs to the user, who may well have
 * a deep tree of their own in there, and walking it on every listing would cost
 * far more than it finds.
 */
async function collectSnapshotFiles(
  root: string,
): Promise<Array<DirEntryInfo & { project: string }>> {
  const top = await invoke<DirEntryInfo[]>('list_dir_entries', {
    path: root,
    extension: null,
  });

  const out: Array<DirEntryInfo & { project: string }> = [];
  for (const e of top) {
    if (!e.is_dir) {
      if (/\.dcraft$/i.test(e.name)) out.push({ ...e, project: '' });
      continue;
    }
    try {
      const inner = await invoke<DirEntryInfo[]>('list_dir_entries', {
        path: e.path,
        extension: 'dcraft',
      });
      for (const f of inner) {
        if (!f.is_dir) out.push({ ...f, project: e.name });
      }
    } catch (err) {
      // An unreadable subfolder must not make the rest of the backups vanish.
      console.warn('[backup] could not read', e.path, err);
    }
  }
  return out;
}

/** The backup folder's contents, in the one shape the rest of this file uses. */
async function listBackupFiles(): Promise<RawBackupFile[]> {
  const folder = useSettingsStore.getState().backupFolder;
  if (!folder || !isTauri()) return [];

  const entries = await collectSnapshotFiles(folder);
  return entries.map((e) => ({
    name: e.name, path: e.path, project: e.project,
    sizeBytes: e.size, modifiedMs: e.modified_ms,
  }));
}

/** Write one file into `<backup folder>/<project>/<filename>`. */
async function writeBackupFile(
  folder: string,
  project: string,
  filename: string,
  contents: string,
): Promise<string> {
  if (!isTauri()) throw new Error('Backups are not available in the browser.');

  const targetDir = joinPath(folder, project);
  await invoke('ensure_dir', { path: targetDir });
  const path = joinPath(targetDir, filename);
  await withTimeout(
    invoke('save_text_atomic', { path, contents }),
    WRITE_TIMEOUT_MS,
    'Writing the backup',
  );
  return path;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);
}

export interface WriteSnapshotOptions {
  content: Record<string, unknown>;
  title: string;
  projectId?: string | null;
  scriptId?: string | null;
  projectTitle?: string;
  kind: 'auto' | 'manual';
  /** Injectable for tests. */
  now?: Date;
}

export interface WriteSnapshotResult {
  path: string;
  filename: string;
  bytes: number;
  assetsOmitted: boolean;
}

/**
 * Write one snapshot, then prune old ones.
 *
 * The write is atomic (temp file + rename) because a snapshot truncated by a
 * crash or a yanked drive is worse than no snapshot. Pruning is
 * fire-and-forget: failing to delete an old file never deserves the user's
 * attention, and must not fail the backup that just succeeded.
 */
export async function writeSnapshot(opts: WriteSnapshotOptions): Promise<WriteSnapshotResult> {
  const { backupFolder, backupIncludeImages, backupRetentionCount } = useSettingsStore.getState();
  if (!backupsSupported()) throw new Error('Backups are only available in the DraftCraft app.');
  if (!backupFolder) throw new Error('No backup folder is configured.');

  // One folder per project inside the chosen folder, so a writer with a dozen
  // projects can find the right script in Finder without reading filenames.
  const projectFolder = buildProjectFolderName(opts.projectTitle);

  // Images live in the scratch store; pack them so a restored backup keeps its pictures.
  let assets: Awaited<ReturnType<typeof packScratchAssets>>['assets'] = [];
  let assetsOmitted = false;
  const scratchIds = collectScratchIds(opts.content);
  if (backupIncludeImages) {
    if (scratchIds.size > 0) {
      const packed = await packScratchAssets(opts.content);
      assets = packed.assets;
      assetsOmitted = packed.truncated;
    }
  } else {
    assetsOmitted = scratchIds.size > 0;
  }

  const meta: ScriptMeta = {
    id: opts.scriptId || '', title: opts.title, author: '', format: 'json',
    created_at: '', updated_at: '', page_count: 0,
    size_bytes: 0, color: '', pinned: false, sort_order: 0, preview: '',
  } as ScriptMeta;

  const text = serializeDCraft(meta, opts.content, {
    assets,
    assetsOmitted,
    backupKind: opts.kind as BackupKind,
    projectId: opts.projectId ?? null,
    scriptId: opts.scriptId ?? null,
    projectTitle: opts.projectTitle,
  });

  const filename = buildBackupFilename({
    title: opts.title,
    scriptId: opts.scriptId,
    date: opts.now || new Date(),
    kind: opts.kind,
  });

  const path = await writeBackupFile(backupFolder, projectFolder, filename, text);

  void pruneSnapshots(backupRetentionCount).catch((err) =>
    console.warn('[backup] prune failed', err),
  );

  return { path, filename, bytes: text.length, assetsOmitted };
}

/** Every .dcraft in the backup folder and its project folders, newest first. */
export async function listSnapshots(): Promise<BackupEntry[]> {
  if (!backupsAvailable()) return [];

  const entries = await listBackupFiles();

  const out: BackupEntry[] = [];
  for (const e of entries) {
    const parsed = parseBackupFilename(e.name);
    if (parsed) {
      out.push({
        path: e.path, name: e.name, title: parsed.title, scriptKey: parsed.scriptKey,
        date: parsed.timestamp, kind: parsed.kind, sizeBytes: e.sizeBytes, project: e.project,
      });
    } else {
      // A .dcraft the user put here themselves (an export, a copy). Listed so
      // it can be recovered, tagged 'external' so it is never pruned.
      out.push({
        path: e.path, name: e.name, title: e.name.replace(/\.dcraft$/i, ''),
        scriptKey: 'external',
        date: new Date(e.modifiedMs || 0), kind: 'external', sizeBytes: e.sizeBytes,
        project: e.project,
      });
    }
  }
  out.sort((a, b) => b.date.getTime() - a.date.getTime());
  return out;
}

/**
 * Delete automatic snapshots beyond the retention limit.
 * Returns how many were removed.
 */
export async function pruneSnapshots(keep?: number): Promise<number> {
  const state = useSettingsStore.getState();
  const limit = keep ?? state.backupRetentionCount;
  if (!backupsAvailable() || limit <= 0) return 0;

  const entries = await listBackupFiles();

  // Only files this module's naming scheme recognizes are candidates, a user
  // who points the setting at their Documents folder can never lose anything.
  const parsed: Array<ParsedBackup & { path: string }> = [];
  for (const e of entries) {
    const p = parseBackupFilename(e.name);
    if (p) parsed.push({ ...p, path: e.path });
  }

  const doomed = selectForPruning(parsed, limit) as Array<ParsedBackup & { path: string }>;
  let removed = 0;
  for (const f of doomed) {
    try {
      await deleteSnapshot(f.path);
      removed++;
    } catch (err) {
      console.warn('[backup] could not delete', f.path, err);
    }
  }
  return removed;
}

/** Read and parse one snapshot. Accepts legacy envelope-less backups. */
export async function readSnapshot(path: string): Promise<ParsedDCraft> {
  const text = await invoke<string>('read_text_file', { path });
  return parseDCraft(text);
}

export async function deleteSnapshot(path: string): Promise<void> {
  await invoke('delete_file', { path });
}

export async function revealSnapshot(path: string): Promise<void> {
  if (!supportsRevealBackup()) {
    throw new Error('Showing a backup in a file manager is only available in the app.');
  }
  await invoke('reveal_path', { path });
}

export interface PathProbe {
  exists: boolean;
  is_dir: boolean;
  writable: boolean;
  error: string | null;
}

export async function probeBackupFolder(handle: string): Promise<PathProbe> {
  return invoke<PathProbe>('probe_directory', { path: handle });
}

/**
 * The backup folder as the writer chose it.
 *
 * `handle` is what every command above takes; `label` is what to show.
 */
export interface PickedBackupFolder {
  handle: string;
  label: string;
}

/** Present the platform's folder picker. Null when the user cancelled. */
export async function pickBackupFolder(current?: string): Promise<PickedBackupFolder | null> {
  if (!isTauri()) {
    throw new Error('Choosing a backup folder is not available in the browser.');
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, defaultPath: current || undefined });
  if (typeof picked !== 'string' || !picked) return null;
  return { handle: picked, label: picked };
}
