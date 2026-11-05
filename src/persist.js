// SQLite-backed persistence for store sessions — see plan-impl.md §6.7
//
// Subscribes to store events and mirrors each session's full state (including
// tokens and assignments) into SQLite, so a restart can rehydrate sessions via
// store.restoreSessions(). The store itself stays synchronous and I/O-free;
// this module is the only thing that touches disk.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    code TEXT PRIMARY KEY,
    host_token TEXT NOT NULL,
    host_participant_id TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    seq INTEGER NOT NULL,
    token TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    fun_fact TEXT NOT NULL,
    is_host INTEGER NOT NULL,
    assigned_to TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_participants_code ON participants(code);
`;

export function createPersistence({ dbPath, store, log }) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (code, host_token, host_participant_id, created_at, state)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      host_token = excluded.host_token,
      host_participant_id = excluded.host_participant_id,
      state = excluded.state
  `);
  const deleteParticipantsForCode = db.prepare('DELETE FROM participants WHERE code = ?');
  const insertParticipant = db.prepare(`
    INSERT INTO participants (id, code, seq, token, name, name_key, fun_fact, is_host, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE code = ?');
  const selectSessions = db.prepare('SELECT * FROM sessions');
  const selectParticipants = db.prepare('SELECT * FROM participants WHERE code = ? ORDER BY seq ASC');

  function persistSession(code) {
    const snap = store.exportSession(code);
    if (!snap) return;
    try {
      db.exec('BEGIN');
      upsertSession.run(snap.code, snap.hostToken, snap.hostParticipantId, snap.createdAt, snap.state);
      deleteParticipantsForCode.run(snap.code);
      snap.participants.forEach((p, seq) => {
        insertParticipant.run(p.id, snap.code, seq, p.token, p.name, p.nameKey, p.funFact, p.isHost ? 1 : 0, p.assignedTo);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      log.error('persist_failed', { err, code });
    }
  }

  function removeSession(code) {
    db.exec('BEGIN');
    deleteParticipantsForCode.run(code);
    deleteSession.run(code);
    db.exec('COMMIT');
  }

  const unsubscribe = store.on((event) => {
    switch (event.type) {
      case 'created':
      case 'participants_changed':
      case 'removed':
      case 'drawn':
        persistSession(event.code);
        break;
      case 'closed':
        removeSession(event.code);
        break;
    }
  });

  function loadAll() {
    return selectSessions.all().map((row) => ({
      code: row.code,
      hostToken: row.host_token,
      hostParticipantId: row.host_participant_id,
      createdAt: row.created_at,
      state: row.state,
      participants: selectParticipants.all(row.code).map((p) => ({
        id: p.id, token: p.token, name: p.name, nameKey: p.name_key,
        funFact: p.fun_fact, isHost: !!p.is_host, assignedTo: p.assigned_to,
      })),
    }));
  }

  return {
    loadAll,
    removeSession,
    close: () => { unsubscribe(); db.close(); },
  };
}
