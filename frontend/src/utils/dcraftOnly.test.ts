import { describe, it, expect } from 'vitest';
import { dcraftOnlyContent } from './dcraftOnly';

describe('dcraftOnlyContent', () => {
  it('is empty for a plain script', () => {
    expect(dcraftOnlyContent({ type: 'doc', content: [] })).toEqual([]);
    expect(dcraftOnlyContent(null)).toEqual([]);
  });

  it('flags assets', () => {
    expect(dcraftOnlyContent({ _assets: [{ id: 'abc' }] })).toContain('pictures and assets');
  });

  it('flags character relationships', () => {
    expect(dcraftOnlyContent({ '_characterRelationships': [{ id: 'r1' }] })).toContain('character relationships');
  });

  it('flags version history', () => {
    expect(dcraftOnlyContent({ _versions: [{ id: 'v1' }] })).toContain('version history');
    expect(dcraftOnlyContent({ _versions: [] })).toEqual([]);
  });
});
