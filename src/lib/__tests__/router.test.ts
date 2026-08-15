/**
 * The address bar now selects the document, so getting an id out of a path is
 * load-bearing: read it wrong and someone opens the wrong notebook, or none.
 */
import { describe, it, expect } from 'vitest';
import { docIdFromPath, pathForDoc } from '../router';

describe('docIdFromPath', () => {
  it('reads the id out of a normal path', () => {
    expect(docIdFromPath('/8f2c1a9e-0b3d-4c7a-9e21-5f6d7a8b9c01'))
      .toBe('8f2c1a9e-0b3d-4c7a-9e21-5f6d7a8b9c01');
  });

  it('treats the root as no document', () => {
    expect(docIdFromPath('/')).toBeNull();
    expect(docIdFromPath('')).toBeNull();
  });

  it('ignores a trailing slash', () => {
    expect(docIdFromPath('/default/')).toBe('default');
  });

  it('takes only the first segment', () => {
    // Degrading to the document beats degrading to nothing if a deeper path
    // ever shows up — a stale bookmark should still open something.
    expect(docIdFromPath('/default/anything/else')).toBe('default');
  });

  it('decodes an escaped id', () => {
    expect(docIdFromPath('/__weekly-planner__')).toBe('__weekly-planner__');
    expect(docIdFromPath(`/${encodeURIComponent('a b')}`)).toBe('a b');
  });

  it('returns the raw segment when it is not valid encoding', () => {
    // decodeURIComponent throws on a lone '%'. Falling back to the raw text
    // means a malformed link resolves to "no such document" rather than
    // crashing the render before anything is on screen.
    expect(docIdFromPath('/100%')).toBe('100%');
  });
});

describe('pathForDoc', () => {
  it('round-trips through docIdFromPath', () => {
    for (const id of ['default', 'a b', '__memory__', 'ü-ñ', '8f2c1a9e-0b3d']) {
      expect(docIdFromPath(pathForDoc(id))).toBe(id);
    }
  });
});
