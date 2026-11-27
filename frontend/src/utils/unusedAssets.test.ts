import { describe, it, expect } from 'vitest';
import { unusedAssets } from './dcraftOnly';

const asset = (id: string, original = `${id}.png`) => ({
  id, filename: `${id}.png`, original_name: original, mime_type: 'image/png', size_bytes: 1, tags: [],
});

describe('unused assets', () => {
  it('finds nothing in a script with no assets', () => {
    expect(unusedAssets({ type: 'doc' })).toEqual({ unused: [], total: 0 });
    expect(unusedAssets(null)).toEqual({ unused: [], total: 0 });
  });

  it('lists a picture that only the asset list mentions', () => {
    const out = unusedAssets({ _assets: [asset('a1', 'Hero.png')], _characterProfiles: [] });
    expect(out.total).toBe(1);
    expect(out.unused).toEqual([{ id: 'a1', name: 'Hero.png' }]);
  });

  it('keeps a picture a character still uses', () => {
    const out = unusedAssets({ _assets: [asset('a1')], _characterProfiles: [{ name: 'ANN', images: ['a1'] }] });
    expect(out.unused).toEqual([]);
  });

  it('keeps a picture used in the script body, by id', () => {
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { assetId: 'a1' } }] };
    expect(unusedAssets({ ...doc, _assets: [asset('a1')] }).unused).toEqual([]);
  });

  it('keeps a picture used somewhere unexpected, by its file name', () => {
    const out = unusedAssets({ _assets: [asset('a1')], _beats: [{ imageUrl: 'asset://x/a1.png' }] });
    expect(out.unused).toEqual([]);
  });

  it('separates used from unused', () => {
    const out = unusedAssets({
      _assets: [asset('a1'), asset('b2')],
      _characterProfiles: [{ name: 'ANN', images: ['a1'] }],
    });
    expect(out.total).toBe(2);
    expect(out.unused.map((u) => u.id)).toEqual(['b2']);
  });
});
