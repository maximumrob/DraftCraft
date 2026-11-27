import type { LocationEntry } from '../stores/locationStore';
import { locationHasDetails, newLocationEntry, parseLocationFromHeading, sanitizeLocations } from './locations';

/**
 * Location details Final Draft has no field for, carried as a Script Note.
 *
 * Final Draft's own location list holds names and nothing else, so a
 * location's address, contact, notes and the rest travel as plain text on the
 * first scene heading that uses it:
 *
 *   [DraftCraft: Location] KITCHEN
 *   Type: interior
 *   Address: 12 Elm Street
 *   Tags: practical; night shoot
 *   Notes:
 *   The window sticks.
 *
 * Opened in Final Draft it reads as an ordinary note. Opened here, each line
 * goes back to its own field. Text we do not recognise stays in the location's
 * notes, so an edit made elsewhere can never lose words.
 */
const TAG_LINE = /^\s*\[DraftCraft:\s*Location\s*\]\s*(.*?)\s*$/i;
const FIELD_LINE = /^\s*(Full name|Type|Address|Contact|Availability|Tags|Aliases)\s*:\s*(.*?)\s*$/i;
const NOTES_LINE = /^\s*Notes\s*:\s*$/i;

const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
const joinList = (items: string[]): string => items.map(oneLine).filter(Boolean).join('; ');
const splitList = (s: string): string[] => s.split(';').map((x) => x.trim()).filter(Boolean);

/** True when a Script Note's text is one of ours for a location. */
export function isLocationNote(text: string): boolean {
  return TAG_LINE.test(String(text ?? '').split(/\r?\n/)[0] ?? '');
}

/** The note text for one location, or null when it has nothing beyond a name and type. */
export function foldLocationNote(l: LocationEntry): string | null {
  if (!locationHasDetails(l)) return null;
  const lines = [`[DraftCraft: Location] ${oneLine(l.name)}`];
  const add = (label: string, value: string): void => {
    const text = oneLine(value);
    if (text) lines.push(`${label}: ${text}`);
  };
  add('Full name', l.fullName);
  lines.push(`Type: ${l.type}`);
  add('Address', l.address);
  add('Contact', l.contact);
  add('Availability', l.availability);
  const tags = joinList(l.tags);
  if (tags) lines.push(`Tags: ${tags}`);
  const aliases = joinList(l.aliases);
  if (aliases) lines.push(`Aliases: ${aliases}`);
  const notes = l.notes.trim();
  if (notes) lines.push('Notes:', notes);
  return lines.join('\n');
}

export interface ParsedLocationNote {
  name: string;
  fields: Partial<Omit<LocationEntry, 'id' | 'name'>>;
}

/** The reverse: a note's text back into a location's fields; null if it is not ours. */
export function parseLocationNote(text: string): ParsedLocationNote | null {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = TAG_LINE.exec(lines[0] ?? '');
  if (!head) return null;
  const name = head[1].trim().toUpperCase();
  if (!name) return null;

  const fields: ParsedLocationNote['fields'] = {};
  const noteLines: string[] = [];
  let inNotes = false;
  for (const line of lines.slice(1)) {
    if (inNotes) {
      noteLines.push(line);
      continue;
    }
    if (NOTES_LINE.test(line)) {
      inNotes = true;
      continue;
    }
    const m = FIELD_LINE.exec(line);
    if (!m) {
      noteLines.push(line);
      continue;
    }
    const value = m[2];
    switch (m[1].toLowerCase()) {
      case 'full name': fields.fullName = value; break;
      case 'type': {
        const t = value.toLowerCase();
        if (t === 'interior' || t === 'exterior' || t === 'both') fields.type = t;
        break;
      }
      case 'address': fields.address = value; break;
      case 'contact': fields.contact = value; break;
      case 'availability': fields.availability = value; break;
      case 'tags': fields.tags = splitList(value); break;
      case 'aliases': fields.aliases = splitList(value); break;
    }
  }
  const notes = noteLines.join('\n').trim();
  if (notes) fields.notes = notes;
  return { name, fields };
}

/**
 * The locations with the notes from an opened file folded in. A location the
 * list already knows (by name or alias) gets the note's fields; any other
 * becomes a new entry.
 */
export function applyLocationNotes(existing: LocationEntry[], notes: readonly string[]): LocationEntry[] {
  const out = existing.map((l) => ({ ...l }));
  for (const text of notes) {
    const parsed = parseLocationNote(text);
    if (!parsed) continue;
    let entry = out.find((l) => l.name === parsed.name)
      ?? out.find((l) => l.aliases.some((a) => a.trim().toUpperCase() === parsed.name));
    if (!entry) {
      entry = newLocationEntry(parsed.name, parsed.fields.type ?? 'interior');
      out.push(entry);
    }
    Object.assign(entry, parsed.fields);
  }
  return out;
}

/** A block of the script that can carry a note, and its heading if it is a scene heading. */
export interface NoteCarrier {
  index: number;
  heading: string | null;
}

/**
 * Which note text goes on which block. Each location with details rides on the
 * first scene heading that names it; one no heading names goes on the first
 * scene heading, or on the first block when there are none.
 */
export function locationNoteTexts(rawLocations: unknown, carriers: readonly NoteCarrier[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (carriers.length === 0) return out;
  const locations = sanitizeLocations(rawLocations).filter(locationHasDetails);
  if (locations.length === 0) return out;

  const byKey = new Map<string, LocationEntry>();
  for (const l of locations) byKey.set(l.name, l);
  for (const l of locations) {
    for (const a of l.aliases) {
      const key = a.trim().toUpperCase();
      if (key && !byKey.has(key)) byKey.set(key, l);
    }
  }

  const placed = new Set<LocationEntry>();
  const put = (index: number, l: LocationEntry): void => {
    const text = foldLocationNote(l);
    if (!text) return;
    const list = out.get(index);
    if (list) list.push(text);
    else out.set(index, [text]);
    placed.add(l);
  };

  for (const c of carriers) {
    if (c.heading === null) continue;
    const l = byKey.get(parseLocationFromHeading(c.heading));
    if (l && !placed.has(l)) put(c.index, l);
  }
  const fallback = (carriers.find((c) => c.heading !== null) ?? carriers[0]).index;
  for (const l of locations) {
    if (!placed.has(l)) put(fallback, l);
  }
  return out;
}
