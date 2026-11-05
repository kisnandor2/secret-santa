import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, createCodeGen, newToken, newId, tokenEquals } from '../src/codes.js';
import { seededRandomInt } from './helpers/rng.js';

describe('codes', () => {
  it('WORDS has 32 unique upper-case words of 3-10 letters', () => {
    assert.equal(WORDS.length, 32);
    assert.equal(new Set(WORDS).size, 32);
    for (const w of WORDS) assert.match(w, /^[A-Z]{3,10}$/);
  });

  it('generated codes match the format', () => {
    const gen = createCodeGen(seededRandomInt(7));
    for (let i = 0; i < 500; i++) {
      const code = gen();
      assert.match(code, /^[A-Z]{3,10}-\d{3}$/);
      assert.ok(Number(code.slice(-3)) >= 100);
    }
  });

  it('default generator works with crypto.randomInt', () => {
    assert.match(createCodeGen()(), /^[A-Z]{3,10}-\d{3}$/);
  });

  it('tokens are 22 base64url chars and unique over 1000 calls', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const t = newToken();
      assert.match(t, /^[A-Za-z0-9_-]{22}$/);
      seen.add(t);
    }
    assert.equal(seen.size, 1000);
  });

  it('newId returns distinct uuids', () => {
    const a = newId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, newId());
  });

  it('tokenEquals handles equal, unequal, different-length and non-string input', () => {
    const t = newToken();
    assert.equal(tokenEquals(t, t), true);
    assert.equal(tokenEquals(t, newToken()), false);
    assert.equal(tokenEquals('abc', 'abcd'), false);
    assert.equal(tokenEquals('', ''), true);
    assert.equal(tokenEquals(undefined, t), false);
    assert.equal(tokenEquals(t, null), false);
    assert.equal(tokenEquals(123, 123), false);
    assert.equal(tokenEquals({}, {}), false);
  });
});
