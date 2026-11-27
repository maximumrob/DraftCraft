/**
 * DraftCraft native format (.dcraft) import/export utilities.
 *
 * A .dcraft file is a JSON document holding the script, its metadata and
 * everything that goes with it, designed for lossless round-tripping. It is
 * also the format automatic backups are written in, which is why fidelity
 * matters here: a snapshot that can't be fully restored is not a backup.
 *
 * `content` is the full buildSaveContent() payload (the document plus every
 * `_`-prefixed store key), `meta` carries provenance, and `assets` may embed
 * the images the document references. Images live outside the document as
 * `assetId` references, so without embedding them a restored script comes
 * back with every image broken.
 *
 * Only files carrying this format's own tags are accepted. There is no reader
 * for any earlier format.
 */

import type { ScriptMeta } from './scriptMeta';

export const DCRAFT_VERSION = 1;

export type BackupKind = 'auto' | 'manual' | 'crash';

export interface DCraftAsset {
  id: string;
  filename: string;
  mime_type: string;
  /** Base64-encoded bytes (no data: prefix). */
  data_base64: string;
}

export interface DCraftMeta {
  title: string;
  author: string;
  color: string;
  page_count: number;
  /** Provenance — lets a restore offer "put it back where it came from". */
  project_id?: string | null;
  script_id?: string | null;
  project_title?: string;
  app_version?: string;
  backup_kind?: BackupKind;
  /** True when images were deliberately left out (disabled, or over the cap). */
  assets_omitted?: boolean;
}

interface DCraftFile {
  dcraft_version: number;
  format: 'dcraft-script';
  exported_at: string;
  meta: DCraftMeta;
  content: Record<string, unknown>;
  assets?: DCraftAsset[];
}

export interface ParsedDCraft {
  meta: DCraftMeta;
  content: Record<string, unknown>;
  assets: DCraftAsset[];
  /** Format version the file declared. */
  version: number;
}

export interface ExportDCraftOptions {
  assets?: DCraftAsset[];
  backupKind?: BackupKind;
  projectId?: string | null;
  scriptId?: string | null;
  projectTitle?: string;
  appVersion?: string;
  assetsOmitted?: boolean;
  /** Injectable for tests; defaults to now. */
  exportedAt?: string;
}

/** Build a .dcraft JSON blob from script metadata and content. */
export function exportDCraft(
  meta: ScriptMeta,
  content: Record<string, unknown>,
  options: ExportDCraftOptions = {},
): Blob {
  return new Blob([serializeDCraft(meta, content, options)], {
    type: 'application/json',
  });
}

/** The .dcraft JSON text. Separated from the Blob so callers that write to a
 *  file (backups) don't have to round-trip through Blob.text(). */
export function serializeDCraft(
  meta: ScriptMeta,
  content: Record<string, unknown>,
  options: ExportDCraftOptions = {},
): string {
  const data: DCraftFile = {
    dcraft_version: DCRAFT_VERSION,
    format: 'dcraft-script',
    exported_at: options.exportedAt || new Date().toISOString(),
    meta: {
      title: meta.title,
      author: meta.author,
      color: meta.color,
      page_count: meta.page_count,
      ...(options.projectId !== undefined ? { project_id: options.projectId } : {}),
      ...(options.scriptId !== undefined ? { script_id: options.scriptId } : {}),
      ...(options.projectTitle ? { project_title: options.projectTitle } : {}),
      ...(options.appVersion ? { app_version: options.appVersion } : {}),
      ...(options.backupKind ? { backup_kind: options.backupKind } : {}),
      ...(options.assetsOmitted ? { assets_omitted: true } : {}),
    },
    content,
    ...(options.assets && options.assets.length > 0 ? { assets: options.assets } : {}),
  };
  return JSON.stringify(data, null, 2);
}

/** Download a script as a .dcraft file. */
export async function downloadDCraft(
  meta: ScriptMeta,
  content: Record<string, unknown>,
  options: ExportDCraftOptions = {},
): Promise<void> {
  const text = serializeDCraft(meta, content, options);
  const filename = `${meta.title || 'Untitled'}.dcraft`;
  const { saveFile } = await import('./fileOps');
  await saveFile(text, filename, [{ name: 'DraftCraft', extensions: ['dcraft'] }]);
}

/** Parse a .dcraft JSON string back into meta + content. */
export function parseDCraft(jsonText: string): ParsedDCraft {
  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('Invalid .dcraft file: not valid JSON');
  }

  if (data?.format !== 'dcraft-script') {
    throw new Error('Invalid .dcraft file: unrecognized format');
  }
  if (typeof data.dcraft_version !== 'number') {
    throw new Error('Invalid .dcraft file: missing version');
  }
  if (data.dcraft_version > DCRAFT_VERSION) {
    throw new Error(
      `This .dcraft file was created by a newer version of DraftCraft (format v${data.dcraft_version}). Update DraftCraft to open it.`,
    );
  }

  return {
    version: data.dcraft_version,
    meta: {
      title: data.meta?.title || 'Untitled',
      author: data.meta?.author || '',
      color: data.meta?.color || '',
      page_count: data.meta?.page_count || 0,
      project_id: data.meta?.project_id ?? null,
      script_id: data.meta?.script_id ?? null,
      project_title: data.meta?.project_title,
      app_version: data.meta?.app_version,
      backup_kind: data.meta?.backup_kind,
      assets_omitted: data.meta?.assets_omitted === true,
    },
    content: data.content || {},
    assets: Array.isArray(data.assets) ? data.assets : [],
  };
}
