// SQLite-backed persistence for store sessions — see plan-impl.md §6.7
//
// Subscribes to store events and mirrors each session's full state (including
// tokens and assignments) into SQLite, so a restart can rehydrate sessions via
// store.restoreSessions(). The store itself stays synchronous and I/O-free;
// this module is the only thing that touches disk.
import { DatabaseSync } from 'node:sqlite';
import { tokenEquals } from './codes.js';

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

  -- Kept forever after a session closes, so a participant who still has their
  -- token (sessionStorage/localStorage) can look their result up later. 'code'
  -- is NOT the key here: the 28,800-code space gets reused over the life of
  -- the event, so the same code can belong to many archived sessions over time.
  CREATE TABLE IF NOT EXISTS sessions_archive (
    archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    host_token TEXT NOT NULL,
    host_participant_id TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    closed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_archive_code ON sessions_archive(code);
  CREATE TABLE IF NOT EXISTS participants_archive (
    archive_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    token TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    fun_fact TEXT NOT NULL,
    is_host INTEGER NOT NULL,
    assigned_to TEXT,
    PRIMARY KEY (archive_id, id)
  );
`;

export function createPersistence({ dbPath, store, log }) {
  // Fail fast at startup if the SQLite backend can't be opened and written to
  // (missing directory, read-only filesystem, wrong permissions, ...), rather
  // than starting the app with persistence silently broken.
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA); // CREATE TABLE IF NOT EXISTS: a real write, so this also proves the file is writable.
  } catch (err) {
    throw new Error(`Cannot open session database at DB_PATH=${JSON.stringify(dbPath)}: ${err.message}`, { cause: err });
  }

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
  const selectSession = db.prepare('SELECT * FROM sessions WHERE code = ?');
  const selectSessions = db.prepare('SELECT * FROM sessions');
  const selectParticipants = db.prepare('SELECT * FROM participants WHERE code = ? ORDER BY seq ASC');

  const insertArchiveSession = db.prepare(`
    INSERT INTO sessions_archive (code, host_token, host_participant_id, created_at, state, closed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertArchiveParticipant = db.prepare(`
    INSERT INTO participants_archive (archive_id, id, seq, token, name, name_key, fun_fact, is_host, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectArchiveSessionsByCode = db.prepare('SELECT * FROM sessions_archive WHERE code = ? ORDER BY archive_id DESC');
  const selectArchiveParticipants = db.prepare('SELECT * FROM participants_archive WHERE archive_id = ?');

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

  // Archives whatever is currently on disk for `code` (there may be nothing,
  // e.g. a session that expired while the process was down and was never
  // loaded back into the live store), then removes the live rows. Used both
  // for a normal close/TTL expiry and for app.js's startup cleanup of
  // sessions that expired while down — both end up here so both get archived.
  function removeSession(code) {
    try {
      db.exec('BEGIN');
      const row = selectSession.get(code);
      if (row) {
        const { lastInsertRowid } = insertArchiveSession.run(
          row.code, row.host_token, row.host_participant_id, row.created_at, row.state, Date.now());
        for (const p of selectParticipants.all(code)) {
          insertArchiveParticipant.run(
            lastInsertRowid, p.id, p.seq, p.token, p.name, p.name_key, p.fun_fact, p.is_host, p.assigned_to);
        }
      }
      deleteParticipantsForCode.run(code);
      deleteSession.run(code);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      log.error('archive_failed', { err, code });
    }
  }

  // One token → one result, never a list: finds the one archived session (there
  // may be several over time, since codes get reused) whose participants include
  // a token match, using the same constant-time comparison as store.authenticate.
  function getArchivedResult(code, token) {
    if (typeof token !== 'string') return null;
    for (const session of selectArchiveSessionsByCode.all(code)) {
      const participants = selectArchiveParticipants.all(session.archive_id);
      const me = participants.find((p) => tokenEquals(token, p.token));
      if (!me || !me.assigned_to) continue;
      const target = participants.find((p) => p.id === me.assigned_to);
      if (target) return { assignedName: target.name, assignedFunFact: target.fun_fact };
    }
    return null;
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
    getArchivedResult,
    close: () => { unsubscribe(); db.close(); },
  };
}
