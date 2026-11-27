import { describe, it, expect } from 'vitest';
import {
  applyLocationNotes,
  foldLocationNote,
  isLocationNote,
  locationNoteTexts,
  parseLocationNote,
} from './locationNotes';
import { newLocationEntry } from './locations';

const kitchen = {
  ...newLocationEntry('KITCHEN', 'interior'),
  id: 'k',
  fullName: 'The Smith kitchen',
  address: '12 Elm Street',
  contact: 'Pat, 555 0100',
  availability: 'Weekends',
  tags: ['practical', 'night shoot'],
  aliases: ['THE KITCHEN'],
  notes: 'The window sticks.\nNo sound after six.',
};

describe('location notes', () => {
  it('writes nothing for a location with only a name and type', () => {
    expect(foldLocationNote(newLocationEntry('PARK', 'exterior'))).toBeNull();
  });

  it('round trips every field', () => {
    const text = foldLocationNote(kitchen)!;
    expect(text.split('\n')[0]).toBe('[DraftCraft: Location] KITCHEN');
    expect(isLocationNote(text)).toBe(true);
    expect(parseLocationNote(text)).toEqual({
      name: 'KITCHEN',
      fields: {
        fullName: 'The Smith kitchen',
        type: 'interior',
        address: '12 Elm Street',
        contact: 'Pat, 555 0100',
        availability: 'Weekends',
        tags: ['practical', 'night shoot'],
        aliases: ['THE KITCHEN'],
        notes: 'The window sticks.\nNo sound after six.',
      },
    });
  });

  it('is not fooled by other notes', () => {
    expect(isLocationNote('1. A footnote')).toBe(false);
    expect(parseLocationNote('[DraftCraft: Backstory]\nx')).toBeNull();
    expect(parseLocationNote('[DraftCraft: Location]')).toBeNull();
  });

  it('keeps words typed into the note elsewhere', () => {
    const text = '[DraftCraft: Location] PARK\nAddress: 1 Main\nCall ahead for permits\nNotes:\nBenches';
    const parsed = parseLocationNote(text)!;
    expect(parsed.fields.address).toBe('1 Main');
    expect(parsed.fields.notes).toBe('Call ahead for permits\nBenches');
  });

  it('fills a known location and adds an unknown one', () => {
    const existing = [{ ...newLocationEntry('KITCHEN', 'both'), id: 'k' }];
    const notes = [
      foldLocationNote(kitchen)!,
      foldLocationNote({ ...newLocationEntry('GARAGE', 'exterior'), id: 'g', address: '9 Back Lane' })!,
    ];
    const out = applyLocationNotes(existing, notes);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('k');
    expect(out[0].address).toBe('12 Elm Street');
    expect(out[1].name).toBe('GARAGE');
    expect(out[1].type).toBe('exterior');
    expect(existing[0].address).toBe('');
  });

  it('puts each note on the first heading that names the location', () => {
    const garage = { ...newLocationEntry('GARAGE', 'exterior'), id: 'g', address: '9 Back Lane' };
    const out = locationNoteTexts([kitchen, garage], [
      { index: 0, heading: 'INT. HALL - DAY' },
      { index: 1, heading: null },
      { index: 2, heading: 'INT. THE KITCHEN - NIGHT' },
      { index: 3, heading: 'EXT. GARAGE - DAY' },
      { index: 4, heading: 'INT. KITCHEN - DAY' },
    ]);
    expect([...out.keys()].sort()).toEqual([2, 3]);
    expect(out.get(2)![0]).toContain('KITCHEN');
    expect(out.get(3)![0]).toContain('GARAGE');
  });

  it('puts a location no heading names on the first scene heading', () => {
    const out = locationNoteTexts([kitchen], [
      { index: 0, heading: null },
      { index: 1, heading: 'INT. HALL - DAY' },
    ]);
    expect([...out.keys()]).toEqual([1]);
  });

  it('falls back to the first block when there are no scene headings', () => {
    const out = locationNoteTexts([kitchen], [{ index: 3, heading: null }]);
    expect([...out.keys()]).toEqual([3]);
  });

  it('writes nothing for locations with no details', () => {
    expect(locationNoteTexts([newLocationEntry('PARK')], [{ index: 0, heading: 'EXT. PARK - DAY' }]).size).toBe(0);
    expect(locationNoteTexts(undefined, [{ index: 0, heading: null }]).size).toBe(0);
  });
});
