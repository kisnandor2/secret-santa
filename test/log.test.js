import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, silentLog } from '../src/log.js';

const capture = (level) => {
  const lines = [];
  return { lines, log: createLogger(level, (l) => lines.push(l)) };
};

describe('log', () => {
  it('writes one JSON line with t, lvl, ev and fields', () => {
    const { lines, log } = capture('info');
    log.info('draw_done', { code: 'FROSTY-427', n: 10 });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('\n'));
    const o = JSON.parse(lines[0]);
    assert.equal(o.lvl, 'info');
    assert.equal(o.ev, 'draw_done');
    assert.equal(o.code, 'FROSTY-427');
    assert.equal(o.n, 10);
    assert.equal(new Date(o.t).toISOString(), o.t);
    assert.deepEqual(Object.keys(o).slice(0, 3), ['t', 'lvl', 'ev']);
  });
  it('fields default to {}', () => {
    const { lines, log } = capture('info');
    log.warn('x');
    assert.equal(JSON.parse(lines[0]).ev, 'x');
  });
  it('drops levels below the threshold', () => {
    const { lines, log } = capture('warn');
    log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
    assert.deepEqual(lines.map((l) => JSON.parse(l).ev), ['c', 'd']);
  });
  it('debug level passes everything', () => {
    const { lines, log } = capture('debug');
    log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
    assert.equal(lines.length, 4);
  });
  it('defaults to info', () => {
    const lines = [];
    const log = createLogger(undefined, (l) => lines.push(l));
    log.debug('a'); log.info('b');
    assert.equal(lines.length, 1);
  });
  it('drops sensitive keys', () => {
    const { lines, log } = capture('debug');
    const secret = 'SECRET-VALUE';
    log.info('x', {
      token: secret, hostToken: secret, name: secret, funFact: secret, assignedTo: secret,
      assignedName: secret, assignedFunFact: secret, body: secret, code: 'OK-123',
    });
    assert.ok(!lines[0].includes(secret));
    const o = JSON.parse(lines[0]);
    assert.equal(o.code, 'OK-123');
    assert.deepEqual(Object.keys(o).sort(), ['code', 'ev', 'lvl', 't']);
  });
  it('sensitive fields cannot override t, lvl, ev', () => {
    const { lines, log } = capture('info');
    log.info('real', { lvl: 'fake', ev: 'fake', t: 'fake' });
    const o = JSON.parse(lines[0]);
    assert.equal(o.lvl, 'info');
    assert.equal(o.ev, 'real');
    assert.notEqual(o.t, 'fake');
  });
  it('error logs err message and stack', () => {
    const { lines, log } = capture('info');
    const err = new Error('boom');
    log.error('crash', { err });
    const o = JSON.parse(lines[0]);
    assert.equal(o.err, undefined);
    assert.equal(o.message, 'boom');
    assert.equal(o.stack, err.stack);
  });
  it('error tolerates a non-Error err', () => {
    const { lines, log } = capture('info');
    log.error('crash', { err: 'oops' });
    assert.equal(JSON.parse(lines[0]).message, 'oops');
  });
  it('silentLog is a no-op', () => {
    for (const m of ['debug', 'info', 'warn', 'error']) assert.equal(silentLog[m]('x', { a: 1 }), undefined);
  });
  it('default writer goes to stdout', (t) => {
    const w = t.mock.method(process.stdout, 'write', () => true);
    createLogger('info').info('hello');
    assert.equal(w.mock.callCount(), 1);
    assert.match(w.mock.calls[0].arguments[0], /^\{.*"ev":"hello".*\}\n$/);
  });
});
