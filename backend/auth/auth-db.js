/**
 * Kimlik dogrulama veritabani - AYRI dosya (data/auth.db). Telemetri ve kutuphane
 * veritabanlarindan bagimsiz; sifre ozetleri ve oturumlar burada. node:sqlite, bagimlilik yok.
 *
 *   users     kullanici + rol (admin | viewer) + sifre ozeti (scrypt)
 *   sessions  oturumlar; tarayiciya giden belirtecin YALNIZCA SHA-256 ozeti saklanir
 *   audit     giris/cikis/hesap olaylari (kim, ne zaman, hangi adresten)
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  username TEXT,
  event    TEXT    NOT NULL,
  ip       TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts);
`;

const userRow = (r) => (r ? {
  id: r.id, username: r.username, role: r.role, createdAt: r.created_at, lastLoginAt: r.last_login_at,
} : null);

export class AuthDb {
  /** @param {string} file ':memory:' testler icin */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /* ----------------------------------------------------------------- kullanicilar */

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  countAdmins() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  }

  createUser({ username, role, passwordHash, now }) {
    const r = this.db
      .prepare('INSERT INTO users (username, role, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, role, passwordHash, now);
    return this.getUser(Number(r.lastInsertRowid));
  }

  getUser(id) {
    return userRow(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  /** Sifre ozeti ile birlikte (yalniz giris dogrulamasi icin). */
  getUserWithHash(username) {
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    return r ? { ...userRow(r), passwordHash: r.password_hash } : null;
  }

  getUserHashById(id) {
    return this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash ?? null;
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY username').all().map(userRow);
  }

  setPassword(id, passwordHash) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  setRole(id, role) {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  touchLogin(id, now) {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
  }

  deleteUser(id) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id); // oturumlar CASCADE ile gider
  }

  /* ------------------------------------------------------------------- oturumlar */

  createSession({ tokenHash, userId, now, ip = null, userAgent = null }) {
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenHash, userId, now, now, ip, userAgent ? String(userAgent).slice(0, 200) : null);
  }

  /** Oturum + kullanici (yoksa null). */
  getSession(tokenHash) {
    const r = this.db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.created_at AS s_created, s.last_seen_at,
                u.id, u.username, u.role, u.created_at, u.last_login_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
      )
      .get(tokenHash);
    if (!r) return null;
    return {
      tokenHash: r.token_hash, createdAt: r.s_created, lastSeenAt: r.last_seen_at,
      user: userRow(r),
    };
  }

  touchSession(tokenHash, now) {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash);
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** `exceptHash` verilirse o oturum korunur (sifre degistiren kisinin kendi oturumu). */
  deleteUserSessions(userId, exceptHash = null) {
    if (exceptHash) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptHash);
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  countSessions() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  }

  /** Suresi dolan oturumlari siler; geri donen: silinen sayisi. */
  purgeSessions({ idleCutoffByRole, absoluteCutoffByRole }) {
    let removed = 0;
    for (const role of Object.keys(idleCutoffByRole)) {
      const r = this.db
        .prepare(
          `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role = ?)
             AND (last_seen_at < ? OR created_at < ?)`,
        )
        .run(role, idleCutoffByRole[role], absoluteCutoffByRole[role]);
      removed += Number(r.changes);
    }
    return removed;
  }

  /* ----------------------------------------------------------------- denetim kaydi */

  audit({ ts, username = null, event, ip = null, detail = null }) {
    this.db
      .prepare('INSERT INTO audit (ts, username, event, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .run(ts, username, event, ip, detail ? String(detail).slice(0, 300) : null);
  }

  listAudit(limit = 50) {
    return this.db
      .prepare('SELECT id, ts, username, event, ip, detail FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => ({ id: r.id, ts: r.ts, username: r.username, event: r.event, ip: r.ip, detail: r.detail }));
  }

  close() {
    this.db.close();
  }
}
