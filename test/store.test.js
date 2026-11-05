import { describe, it } from 'node:test';

describe('store', () => {
  it.todo('create with participating host');
  it.todo('create with opted-out host');
  it.todo('code collision retries');
  it.todo('always-colliding generator throws SESSION_LIMIT');
  it.todo('join error precedence');
  it.todo('NAME_TAKEN for padded ALICE vs Alice');
  it.todo('authenticate roles, wrong token, cross-session token');
  it.todo('removeParticipant works and emits events');
  it.todo('removing host gives CANNOT_REMOVE_HOST');
  it.todo('remove with participant token gives FORBIDDEN');
  it.todo('remove after draw gives ALREADY_DRAWN');
  it.todo('draw thresholds');
  it.todo('draw twice gives ALREADY_DRAWN, assignments unchanged');
  it.todo('opted-out host not in draw');
  it.todo('resultFor correct for every participant');
  it.todo('hostView has no token, nameKey or assignedTo');
  it.todo('TTL expiry in both states');
  it.todo('close clears timer');
  it.todo('dispose clears sessions and timers');
  it.todo('throwing listener does not stop others');
});
