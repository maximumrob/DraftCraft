import { describe, it, expect } from 'vitest';
import { exportFDX } from './fdxExporter';
import { newLocationEntry } from './locations';

const doc = {
  type: 'doc',
  content: [
    { type: 'sceneHeading', content: [{ type: 'text', text: 'INT. KITCHEN - DAY' }] },
    { type: 'action', content: [{ type: 'text', text: 'Ansa waits.' }] },
  ],
};

const withDetails = { ...newLocationEntry('KITCHEN'), address: '12 Elm Street' };

const write = (locations?: unknown): string =>
  exportFDX(doc, 'T', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { locations });

describe('location notes in an .fdx', () => {
  it('writes a location with details as a Script Note', () => {
    const xml = write([withDetails]);
    expect(xml).toContain('<ScriptNote>');
    expect(xml).toContain('[DraftCraft: Location] KITCHEN');
    expect(xml).toContain('Address: 12 Elm Street');
  });

  it('writes nothing for a location with only a name', () => {
    expect(write([newLocationEntry('KITCHEN')])).not.toContain('[DraftCraft: Location]');
  });

  it('writes nothing when no locations are given', () => {
    expect(write(undefined)).not.toContain('[DraftCraft: Location]');
  });
});
