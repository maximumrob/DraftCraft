import { collectScratchIds } from './scratchRefs';

/**
 * What a script holds that a Final Draft file cannot.
 *
 * The one list behind both directions of the save flow: an .fdx with any of
 * this must not be overwritten (the save would quietly drop it), and a .dcraft
 * with none of it can be offered as a plain .fdx. Each entry is a short phrase
 * for the dialog.
 */
export function dcraftOnlyContent(content: Record<string, unknown> | null | undefined): string[] {
  if (!content) return [];
  const reasons: string[] = [];
  if (collectScratchIds(content).size > 0) reasons.push('pictures and assets');
  const relationships = content['_characterRelationships'];
  if (Array.isArray(relationships) && relationships.length > 0) reasons.push('character relationships');
  const versions = content['_versions'];
  if (Array.isArray(versions) && versions.length > 0) reasons.push('version history');
  return reasons;
}

/**
 * Pictures in the script's asset list that nothing in the script refers to.
 *
 * Deliberately cautious: a picture counts as unused only when neither its id
 * nor its stored file name appears anywhere else in the saved script (the
 * script body, character portraits, notes, beats, locations, anything). That
 * way a place this code has never heard of can still keep a picture safe.
 */
export function unusedAssets(
  content: Record<string, unknown> | null | undefined,
): { unused: Array<{ id: string; name: string }>; total: number } {
  if (!content) return { unused: [], total: 0 };
  const assets = content['_assets'];
  if (!Array.isArray(assets) || assets.length === 0) return { unused: [], total: 0 };
  const rest: Record<string, unknown> = { ...content };
  delete rest['_assets'];
  const text = JSON.stringify(rest);
  const unused: Array<{ id: string; name: string }> = [];
  for (const a of assets) {
    const rec = (a ?? {}) as { id?: unknown; filename?: unknown; original_name?: unknown };
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (!id) continue;
    const filename = typeof rec.filename === 'string' ? rec.filename : '';
    if (text.includes(id)) continue;
    if (filename && text.includes(filename)) continue;
    const name = typeof rec.original_name === 'string' && rec.original_name ? rec.original_name : filename || id;
    unused.push({ id, name });
  }
  return { unused, total: assets.length };
}
