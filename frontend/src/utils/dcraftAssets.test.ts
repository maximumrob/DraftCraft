import { describe, it, expect } from 'vitest';
import { serializeContentForFormat } from './linkedFileFormat';
import { parseDCraft } from './dcraftFormat';

const CONTENT = { type: 'doc', content: [] };
const PIC = { id: 'pic1', filename: 'pic1.png', mime_type: 'image/png', data_base64: 'AAEC' };

describe('a .dcraft file carries its own pictures', () => {
  it('writes the pictures into the file and reads them back', () => {
    const text = serializeContentForFormat('dcraft', CONTENT, 'Test', { assets: [PIC] });
    const parsed = parseDCraft(text);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets?.[0].id).toBe('pic1');
    expect(parsed.assets?.[0].data_base64).toBe('AAEC');
  });
  it('writes no assets list when there are no pictures', () => {
    const text = serializeContentForFormat('dcraft', CONTENT, 'Test', {});
    expect(JSON.parse(text).assets).toBeUndefined();
  });
});
