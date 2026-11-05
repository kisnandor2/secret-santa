// Deterministic setTimeout/clearTimeout/now — see plan-impl.md §11.1
export function fakeTimers() { throw new Error('not implemented'); }
// returns { setTimeout, clearTimeout, now, advance(ms), pending() }
