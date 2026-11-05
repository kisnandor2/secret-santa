import { describe, it } from 'node:test';

describe('validate', () => {
  it.todo('names: trim and collapse whitespace');
  it.todo('names: 40 accepted, 41 rejected');
  it.todo('names: length counted in code points');
  it.todo('names: control characters rejected');
  it.todo('names: non-strings rejected');
  it.todo('codes: frosty-427 normalizes to FROSTY-427');
  it.todo('codes: FROSTY427, F-1 and empty rejected');
  it.todo('create body: {} rejected (missing name)');
  it.todo('create body: participate false is OK');
  it.todo('create body: participate "no" rejected');
  it.todo('static guard: no innerHTML/outerHTML/insertAdjacentHTML/document.write in public/js');
  it.todo('static guard: index.html has no inline script or style attribute');
});
