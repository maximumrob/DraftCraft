import { describe, it, expect } from 'vitest';
import { isImportableExtension, importFormatLabel, SCREENPLAY_IMPORT_ACCEPT } from './importScreenplay';

describe('.dcraft is a first-class openable format', () => {
  it('is accepted by import, drag and drop and the file pickers', () => {
    expect(isImportableExtension('dcraft')).toBe(true);
    expect(SCREENPLAY_IMPORT_ACCEPT).toContain('.dcraft');
  });
  it('has a readable name', () => {
    expect(importFormatLabel('dcraft')).toBe('DraftCraft (.dcraft)');
  });
});
