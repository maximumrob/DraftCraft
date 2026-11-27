import { describe, it, expect } from 'vitest';
import { dcraftOnlyContent } from './dcraftOnly';

describe('location text and the .dcraft prompt', () => {
  it('does not need a .dcraft: location text travels in the .fdx as a note', () => {
    const content = { _locations: [{ name: 'KITCHEN', notes: 'The window sticks.', address: '12 Elm Street', tags: ['practical'] }] };
    expect(dcraftOnlyContent(content)).toEqual([]);
  });
});
