import { describe, it } from 'node:test';

describe('ws', () => {
  it.todo('auth: timeout closes 4001');
  it.todo('auth: bad token 4001');
  it.todo('auth: unknown code 4004');
  it.todo('auth: first message not auth 4001');
  it.todo('auth: /other fails to upgrade');
  it.todo('presence: connected true then false');
  it.todo('authz: participant gets FORBIDDEN');
  it.todo('happy path: host participating');
  it.todo('happy path: host opted out');
  it.todo('privacy sweep');
  it.todo('race: draw happens exactly once');
  it.todo('reconnect after draw');
  it.todo('offline at draw time');
  it.todo('host reconnect before and after draw');
  it.todo('two tabs');
  it.todo('remove: 4011');
  it.todo('close: 4010 and later join 404');
  it.todo('TTL over the wire');
  it.todo('heartbeat terminates dead socket');
  it.todo('bad frames give INVALID_INPUT');
});
