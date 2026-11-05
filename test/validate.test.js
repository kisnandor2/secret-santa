import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode, parseName, parseFunFact, parseCreateBody, parseJoinBody,
} from '../src/validate.js';

const invalid = (fn) => assert.throws(fn, { code: 'INVALID_INPUT', status: 400 });

describe('validate', () => {
  describe('names', () => {
    it('trim and collapse whitespace', () => {
      assert.deepEqual(parseName('  Ann \t\n  Lee  '), { name: 'Ann Lee', nameKey: 'ann lee' });
    });
    it('40 accepted, 41 rejected', () => {
      assert.equal(parseName('a'.repeat(40)).name.length, 40);
      invalid(() => parseName('a'.repeat(41)));
    });
    it('empty and whitespace-only rejected', () => {
      invalid(() => parseName(''));
      invalid(() => parseName('   '));
    });
    it('length counted in code points', () => {
      assert.equal(parseName('🎅'.repeat(40)).name, '🎅'.repeat(40));
      invalid(() => parseName('🎅'.repeat(41)));
    });
    it('NFC normalized', () => {
      assert.equal(parseName('Café').name, 'Café');
    });
    it('nameKey is locale-independent lowercase', () => {
      assert.equal(parseName('ALICE').nameKey, 'alice');
      assert.equal(parseName('I').nameKey, 'i');
    });
    it('control characters rejected', () => {
      invalid(() => parseName('a\u0000b'));
      invalid(() => parseName('a\u0007b'));
      invalid(() => parseName('a\u007Fb'));
      invalid(() => parseName('a\u0085b'));
      invalid(() => parseName('a\u009Fb'));
    });
    it('non-strings rejected', () => {
      for (const v of [undefined, null, 5, {}, [], true, ['a']]) invalid(() => parseName(v));
    });
  });

  describe('fun facts', () => {
    it('empty string and missing are ""', () => {
      assert.equal(parseFunFact(''), '');
      assert.equal(parseFunFact(undefined), '');
    });
    it('trim and collapse whitespace', () => {
      assert.equal(parseFunFact('  I  like\n\ncats '), 'I like cats');
    });
    it('200 accepted, 201 rejected, counted in code points', () => {
      assert.equal(parseFunFact('x'.repeat(200)).length, 200);
      invalid(() => parseFunFact('x'.repeat(201)));
      assert.equal(parseFunFact('🎄'.repeat(200)), '🎄'.repeat(200));
      invalid(() => parseFunFact('🎄'.repeat(201)));
    });
    it('control characters and non-strings rejected', () => {
      invalid(() => parseFunFact('a\u0001'));
      invalid(() => parseFunFact(null));
      invalid(() => parseFunFact(42));
    });
  });

  describe('codes', () => {
    it('frosty-427 normalizes to FROSTY-427', () => {
      assert.equal(normalizeCode('frosty-427'), 'FROSTY-427');
      assert.equal(normalizeCode('  Frosty-427 '), 'FROSTY-427');
    });
    it('FROSTY427, F-1 and empty rejected', () => {
      for (const v of ['FROSTY427', 'F-1', '', 'AB-123', 'ABCDEFGHIJK-123', 'FROSTY-4271', 'FROS1Y-427']) {
        invalid(() => normalizeCode(v));
      }
    });
    it('non-strings rejected', () => {
      for (const v of [undefined, null, 123, {}]) invalid(() => normalizeCode(v));
    });
  });

  describe('create body', () => {
    it('{} rejected (missing name)', () => {
      invalid(() => parseCreateBody({}));
    });
    it('participate defaults to true', () => {
      assert.deepEqual(parseCreateBody({ name: ' Ann ' }), {
        participate: true, name: 'Ann', nameKey: 'ann', funFact: '',
      });
      assert.deepEqual(parseCreateBody({ participate: true, name: 'Bo', funFact: 'hi' }), {
        participate: true, name: 'Bo', nameKey: 'bo', funFact: 'hi',
      });
    });
    it('participate false is OK and ignores name and funFact', () => {
      assert.deepEqual(parseCreateBody({ participate: false }), { participate: false });
      assert.deepEqual(parseCreateBody({ participate: false, name: '', funFact: 5 }), { participate: false });
    });
    it('participate "no" rejected', () => {
      invalid(() => parseCreateBody({ participate: 'no' }));
      invalid(() => parseCreateBody({ participate: 0, name: 'A' }));
      invalid(() => parseCreateBody({ participate: null, name: 'A' }));
    });
    it('non-object bodies rejected', () => {
      for (const v of [null, undefined, [], 'str', 5]) invalid(() => parseCreateBody(v));
    });
    it('bad funFact rejected', () => {
      invalid(() => parseCreateBody({ name: 'A', funFact: 'x'.repeat(201) }));
    });
  });

  describe('join body', () => {
    it('valid body', () => {
      assert.deepEqual(parseJoinBody({ name: 'Cy', funFact: 'x' }), { name: 'Cy', nameKey: 'cy', funFact: 'x' });
      assert.deepEqual(parseJoinBody({ name: 'Cy' }), { name: 'Cy', nameKey: 'cy', funFact: '' });
    });
    it('missing name rejected', () => {
      invalid(() => parseJoinBody({}));
    });
    it('non-object bodies rejected', () => {
      for (const v of [null, undefined, [], 'str', 5]) invalid(() => parseJoinBody(v));
    });
  });
});
