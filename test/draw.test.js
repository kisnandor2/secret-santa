import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assign } from '../src/draw.js';
import { seededRandomInt } from './helpers/rng.js';

const SEEDS = 200;
const MAX_N = 30;

function makeIds(n) {
  return Array.from({ length: n }, (_, i) => `id${i}`);
}

/**
 * Shared property checker. Asserts: Map of n entries, keys == ids,
 * values are a permutation of ids, no fixed points, single n-cycle,
 * and no 2-cycles when n >= 3.
 */
function checkSingleCycle(ids, map) {
  const n = ids.length;
  assert.ok(map instanceof Map, 'result is a Map');
  assert.equal(map.size, n, 'n entries');
  assert.deepEqual([...map.keys()].sort(), [...ids].sort(), 'keys are the ids');
  assert.deepEqual([...map.values()].sort(), [...ids].sort(), 'values are a permutation of ids');
  for (const [giver, receiver] of map) {
    assert.notEqual(giver, receiver, `fixed point: ${giver}`);
  }
  // Follow the map from the first id: must visit all n before returning.
  const seen = new Set();
  let cur = ids[0];
  while (!seen.has(cur)) {
    seen.add(cur);
    cur = map.get(cur);
  }
  assert.equal(seen.size, n, 'single cycle visits all ids');
  assert.equal(cur, ids[0], 'cycle returns to start');
  if (n >= 3) {
    for (const [a, b] of map) {
      assert.notEqual(map.get(b), a, `2-cycle: ${a} <-> ${b}`);
    }
  }
}

// Deliberately broken: plain Fisher–Yates (randomInt(i + 1)) used directly as the
// permutation (ids[k] -> a[k]) permits fixed points.
function brokenAssign(ids, randomInt) {
  if (ids.length < 2) throw new RangeError('need at least 2 ids');
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return new Map(ids.map((id, k) => [id, a[k]]));
}

describe('draw', () => {
  it(`n=2..${MAX_N} x ${SEEDS} seeds: bijective, no fixed points, single cycle, no 2-cycles`, () => {
    for (let n = 2; n <= MAX_N; n++) {
      const ids = makeIds(n);
      for (let seed = 1; seed <= SEEDS; seed++) {
        checkSingleCycle(ids, assign(ids, seededRandomInt(seed)));
      }
    }
  });

  it('result is a Map with n entries keyed by the ids', () => {
    const ids = makeIds(7);
    const map = assign(ids, seededRandomInt(1));
    assert.ok(map instanceof Map);
    assert.equal(map.size, 7);
    assert.deepEqual(new Set(map.keys()), new Set(ids));
    assert.deepEqual(new Set(map.values()), new Set(ids));
  });

  it('n=2 swaps the two ids', () => {
    const map = assign(['a', 'b'], seededRandomInt(5));
    assert.equal(map.get('a'), 'b');
    assert.equal(map.get('b'), 'a');
  });

  it('same seed gives same output', () => {
    for (const n of [2, 3, 5, 12, 30]) {
      const ids = makeIds(n);
      for (let seed = 1; seed <= 20; seed++) {
        const m1 = assign(ids, seededRandomInt(seed));
        const m2 = assign(ids, seededRandomInt(seed));
        assert.deepEqual([...m1], [...m2]);
      }
    }
  });

  it('different seeds produce different outputs (rng is actually used)', () => {
    const ids = makeIds(10);
    const outs = new Set();
    for (let seed = 1; seed <= 20; seed++) {
      outs.add(JSON.stringify([...assign(ids, seededRandomInt(seed))]));
    }
    assert.ok(outs.size > 1);
  });

  it('uniformity for n=4 over 6000 runs: 6 cycles, each 1000 +/- 200', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const rnd = seededRandomInt(42);
    const counts = new Map();
    for (let run = 0; run < 6000; run++) {
      const map = assign(ids, rnd);
      checkSingleCycle(ids, map);
      const seq = [];
      let cur = 'a';
      do {
        seq.push(cur);
        cur = map.get(cur);
      } while (cur !== 'a');
      const key = seq.join('>');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert.equal(counts.size, 6, `distinct cycles: ${[...counts.keys()].join(', ')}`);
    for (const [key, count] of counts) {
      assert.ok(count >= 800 && count <= 1200, `${key} occurred ${count} times`);
    }
  });

  it('mutation check: checker detects fixed points in broken Fisher–Yates', () => {
    const ids = makeIds(6);
    let caught = 0;
    let fixedPointSeen = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const map = brokenAssign(ids, seededRandomInt(seed));
      if ([...map].some(([k, v]) => k === v)) fixedPointSeen++;
      try {
        checkSingleCycle(ids, map);
      } catch (err) {
        if (err instanceof assert.AssertionError) caught++;
        else throw err;
      }
    }
    assert.ok(fixedPointSeen > 0, 'broken impl produced fixed points');
    assert.ok(caught >= fixedPointSeen, 'checker flagged every draw with a fixed point');
    assert.throws(
      () => checkSingleCycle(['a', 'b'], new Map([['a', 'a'], ['b', 'b']])),
      assert.AssertionError,
    );
  });

  it('assign([]) and assign([x]) throw RangeError', () => {
    const rnd = seededRandomInt(1);
    assert.throws(() => assign([], rnd), RangeError);
    assert.throws(() => assign(['x'], rnd), RangeError);
  });

  it('does not mutate the input array', () => {
    const ids = makeIds(10);
    const copy = [...ids];
    assign(ids, seededRandomInt(3));
    assert.deepEqual(ids, copy);
    const frozen = Object.freeze(makeIds(5));
    assert.doesNotThrow(() => assign(frozen, seededRandomInt(3)));
  });
});
