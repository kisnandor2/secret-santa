import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestServer } from './helpers/server.js';

// Process-level wiring in src/app.js (upgrade routing must never throw)
describe('app', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(() => srv.close());

  function rawUpgrade(path) {
    const { port } = new URL(srv.base);
    return new Promise((resolve) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => {
        sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      });
      sock.on('data', () => {});
      sock.on('error', () => resolve());
      sock.on('close', () => resolve());
    });
  }

  for (const path of ['//', 'http://', '/other']) {
    it(`a malformed or foreign upgrade (${path}) is dropped and the server stays up`, async () => {
      await rawUpgrade(path);
      const res = await fetch(`${srv.base}/healthz`);
      assert.equal(res.status, 200);
    });
  }
});
