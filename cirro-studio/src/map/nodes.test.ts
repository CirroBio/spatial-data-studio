import { describe, expect, it } from 'vitest';
import { labelLines } from './nodes';

describe('labelLines', () => {
  it('keeps the words that tell two names apart', () => {
    expect(labelLines('Visium CytAssist mouse brain', 13, 3)).toEqual(['Visium', 'CytAssist', 'mouse brain']);
    expect(labelLines('Visium CytAssist human colon', 13, 3)).toEqual(['Visium', 'CytAssist', 'human colon']);
  });
  it('cuts what is left after the last line', () => {
    expect(labelLines('Xenium human lung (raw counts)', 11, 2)).toEqual(['Xenium', 'human lung…']);
    expect(labelLines('a b c d e f', 3, 2)).toEqual(['a b', 'c…']);
  });
  it('cuts a word too long for its line and carries on', () => {
    expect(labelLines('Supercalifragilistic run', 10, 2)).toEqual(['Supercali…', 'run']);
  });
  it('leaves a name that fits', () => {
    expect(labelLines('Xenium human pancreas', 22, 3)).toEqual(['Xenium human pancreas']);
  });
});
