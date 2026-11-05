import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('defaults', () => {
    assert.deepEqual(loadConfig({}), {
      PORT: 3000, SESSION_TTL_MIN: 120, MAX_SESSIONS: 20, MAX_PARTICIPANTS: 50,
      HEARTBEAT_MS: 30000, AUTH_TIMEOUT_MS: 5000, LOG_LEVEL: 'info', DB_PATH: null,
    });
  });
  it('is frozen', () => {
    assert.ok(Object.isFrozen(loadConfig({})));
  });
  it('parses overrides', () => {
    const c = loadConfig({ PORT: '8080', MAX_SESSIONS: '3', LOG_LEVEL: 'debug', HEARTBEAT_MS: 200 });
    assert.equal(c.PORT, 8080);
    assert.equal(c.MAX_SESSIONS, 3);
    assert.equal(c.HEARTBEAT_MS, 200);
    assert.equal(c.LOG_LEVEL, 'debug');
  });
  it('PORT may be 0', () => {
    assert.equal(loadConfig({ PORT: '0' }).PORT, 0);
  });
  it('rejects invalid integers and names the variable', () => {
    for (const key of ['SESSION_TTL_MIN', 'MAX_SESSIONS', 'MAX_PARTICIPANTS', 'HEARTBEAT_MS', 'AUTH_TIMEOUT_MS']) {
      for (const bad of ['0', '-1', '1.5', 'abc', '', '12px']) {
        assert.throws(() => loadConfig({ [key]: bad }), (e) => e instanceof Error && e.message.includes(key), `${key}=${bad}`);
      }
    }
    for (const bad of ['-1', 'x', '1.5', '', '65536']) {
      assert.throws(() => loadConfig({ PORT: bad }), /PORT/);
    }
  });
  it('rejects invalid LOG_LEVEL', () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
    assert.throws(() => loadConfig({ LOG_LEVEL: '' }), /LOG_LEVEL/);
  });
  it('reads process.env by default', () => {
    assert.equal(typeof loadConfig().PORT, 'number');
  });
  it('DB_PATH is null unless set, otherwise passed through as a string', () => {
    assert.equal(loadConfig({}).DB_PATH, null);
    assert.equal(loadConfig({ DB_PATH: '/data/sessions.db' }).DB_PATH, '/data/sessions.db');
  });
});
