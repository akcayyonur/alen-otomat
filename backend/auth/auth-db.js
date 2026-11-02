/**
 * Kimlik dogrulama veritabani - AYRI dosya (data/auth.db). Telemetri ve kutuphane
 * veritabanlarindan bagimsiz; sifre ozetleri ve oturumlar burada. node:sqlite, bagimlilik yok.
 *
 *   roles     admin-tanimli roller (ad + yetkiler: {ekranId: 'read'|'write'})
 *   users     kullanici + is_admin (sabit tek rol) ya da role_id (roles'a) + sifre ozeti (scrypt)
 *   sessions  oturumlar; tarayiciya giden belirtecin YALNIZCA SHA-256 ozeti saklanir
 *   audit     giris/cikis/hesap olaylari (kim, ne zaman, hangi adresten)
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// SQLite'in yerlesik NOCASE'i yalniz ASCII harfleri katlar: "İmalat" (Turkce noktali I) ile "imalat" (ASCII i)
// COLLATE NOCASE altinda FARKLI sayilir ve UNIQUE'i atlar. Bu yuzden benzersizlik name_key (Turkce katlanmis) uzerinde.
// backend/planning/normalize.js'teki foldTr ile AYNI kural (NBSP -> bosluk ONCE; Excel/Word'den yapistirilan rol adlarinda
// gorunmez NBSP olabilir, katlamadan once temizlenmezse iki "ayni gorunen" ad farkli name_key uretebilir, 2026-11-02'de bulundu).
const TR_FOLD = Object.freeze({
  İ: 'I', I: 'I', ı: 'I', i: 'I', Ş: 'S', ş: 'S', Ğ: 'G', ğ: 'G', Ü: 'U', ü: 'U', Ö: 'O', ö: 'O', Ç: 'C', ç: 'C',
});
const foldKey = (value) => String(value ?? '').replace(/ /g, ' ').replace(/[İIıiŞşĞğÜüÖöÇç]/g, (c) => TR_FOLD[c]).toUpperCase().trim();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  name_key   TEXT    NOT NULL UNIQUE,
  grants     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  role_id       INTEGER REFERENCES roles(id),
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

/**
 * Gocten (eski role sutunundan) turetilen iki rolun yetkileri: davranis birebir aynı kalsın. Bu degerler eski
 * VIEWER_PLANNING/OPERATOR_PLANNING dizilerinden (policy.js'in o zamanki hali) o SIRADA elle cikarildi; o diziler
 * artik SILINDI, yani burada "canli" bir kaynaktan turetilmiyor - DONDURULMUS bir tarihsel kayit.
 * SCREEN_ROUTES ileride degisirse bu nesneyi "guncel" tutmak icin DEGISTIRME: amaci, o gun gocen eski
 * viewer/operator hesaplarinin O GUNKU davranisini aynen korumak; SCREEN_ROUTES'un BUGUNKU halini yansitmasi
 * gerekmiyor (aksine yanlis olur). Yeni bir rol gerekiyorsa Ayarlar > Roller'den acik acik tanimlanir.
 */
const MIGRATED_ROLE_GRANTS = Object.freeze({
  İzleyici: { telemetri: 'read', tezgahbasi: 'read', isemirleri: 'read', gkk: 'read', ilkonay: 'read', olcuraporlari: 'read' },
  Operatör: { tezgahbasi: 'write', paketleme: 'write', isemirleri: 'read', gkk: 'read', ilkonay: 'write', olcuraporlari: 'read', programlar: 'write' },
});

const userRow = (r) => (r ? {
  id: r.id, username: r.username, isAdmin: !!r.is_admin, roleId: r.role_id ?? null, createdAt: r.created_at, lastLoginAt: r.last_login_at,
} : null);

const roleRow = (r) => (r ? { id: r.id, name: r.name, grants: JSON.parse(r.grants), createdAt: r.created_at, createdBy: r.created_by } : null);

export class AuthDb {
  /** @param {string} file ':memory:' testler icin */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Eski veritabani (users.role sutunu, sabit admin/viewer/operator): SQLite'in onerdigi yontemle users
   * tablosu yeniden kurulur (kayitlar ve oturumlar korunur). role='admin' -> is_admin=1; 'viewer'/'operator' ->
   * ayni davranisi veren YENI rollere ("İzleyici"/"Operatör") baglanir. Davranis birebir aynı kalır; admin artık
   * bu iki rolü düzenleyebilir/yeni rol ekleyebilir.
   */
  #migrate() {
    const cols = this.db.prepare("SELECT 1 AS x FROM pragma_table_info('users') WHERE name = 'is_admin'").get();
    if (cols) return; // zaten yeni sema
    const hasRoleCol = this.db.prepare("SELECT 1 AS x FROM pragma_table_info('users') WHERE name = 'role'").get();
    if (!hasRoleCol) return; // yeni bos veritabani: SCHEMA zaten dogru users'i kurdu

    const now = Date.now();
    const roleIdFor = {};
    for (const [name, grants] of Object.entries(MIGRATED_ROLE_GRANTS)) {
      let r = this.db.prepare('SELECT id FROM roles WHERE name_key = ?').get(foldKey(name));
      if (!r) {
        this.db.prepare('INSERT INTO roles (name, name_key, grants, created_at, created_by) VALUES (?,?,?,?,?)').run(name, foldKey(name), JSON.stringify(grants), now, null);
        r = this.db.prepare('SELECT id FROM roles WHERE name_key = ?').get(foldKey(name));
      }
      roleIdFor[name] = Number(r.id);
    }

    this.db.exec('PRAGMA foreign_keys = OFF'); // islem icinde degistirilemez; oturumlar users silinirken CASCADE ile gitmesin
    try {
      this.db.exec('BEGIN');
      this.db.exec(`CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        role_id       INTEGER REFERENCES roles(id),
        password_hash TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      )`);
      const old = this.db.prepare('SELECT id, username, role, password_hash, created_at, last_login_at FROM users').all();
      const ins = this.db.prepare('INSERT INTO users_new (id, username, is_admin, role_id, password_hash, created_at, last_login_at) VALUES (?,?,?,?,?,?,?)');
      for (const u of old) {
        const isAdmin = u.role === 'admin' ? 1 : 0;
        const roleId = u.role === 'viewer' ? roleIdFor.İzleyici : u.role === 'operator' ? roleIdFor.Operatör : null;
        ins.run(u.id, u.username, isAdmin, roleId, u.password_hash, u.created_at, u.last_login_at);
      }
      this.db.exec('DROP TABLE users');
      this.db.exec('ALTER TABLE users_new RENAME TO users');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /* ----------------------------------------------------------------------------- roller */

  listRoles() {
    return this.db.prepare('SELECT * FROM roles ORDER BY name').all().map(roleRow);
  }

  getRole(id) {
    return roleRow(this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id));
  }

  findRoleByName(name) {
    return roleRow(this.db.prepare('SELECT * FROM roles WHERE name_key = ?').get(foldKey(name)));
  }

  createRole({ name, grants, now, by = null }) {
    const r = this.db.prepare('INSERT INTO roles (name, name_key, grants, created_at, created_by) VALUES (?,?,?,?,?)').run(name, foldKey(name), JSON.stringify(grants), now, by);
    return this.getRole(Number(r.lastInsertRowid));
  }

  updateRole(id, { name, grants }) {
    this.db.prepare('UPDATE roles SET name = ?, name_key = ?, grants = ? WHERE id = ?').run(name, foldKey(name), JSON.stringify(grants), id);
  }

  deleteRole(id) {
    this.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  }

  countUsersWithRole(id) {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(id).n);
  }

  /* ----------------------------------------------------------------- kullanicilar */

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  countAdmins() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
  }

  /** @param {{username: string, isAdmin: boolean, roleId: number|null, passwordHash: string, now: number}} u */
  createUser({ username, isAdmin, roleId, passwordHash, now }) {
    const r = this.db
      .prepare('INSERT INTO users (username, is_admin, role_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, isAdmin ? 1 : 0, roleId ?? null, passwordHash, now);
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

  /** Oturum + kullanici + (varsa) rolu (yoksa null). */
  getSession(tokenHash) {
    const r = this.db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.created_at AS s_created, s.last_seen_at,
                u.id, u.username, u.is_admin, u.role_id, u.created_at, u.last_login_at,
                r.name AS role_name, r.grants AS role_grants
           FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN roles r ON r.id = u.role_id
          WHERE s.token_hash = ?`,
      )
      .get(tokenHash);
    if (!r) return null;
    return {
      tokenHash: r.token_hash, createdAt: r.s_created, lastSeenAt: r.last_seen_at,
      user: {
        ...userRow(r), roleName: r.role_name ?? null, grants: r.role_grants ? JSON.parse(r.role_grants) : null,
      },
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

  /** Suresi dolan oturumlari siler (admin / admin-disi icin ayri esikler); geri donen: silinen sayisi. */
  purgeSessions({ idleCutoffAdmin, absoluteCutoffAdmin, idleCutoffOther, absoluteCutoffOther }) {
    const admin = this.db
      .prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_admin = 1) AND (last_seen_at < ? OR created_at < ?)')
      .run(idleCutoffAdmin, absoluteCutoffAdmin);
    const other = this.db
      .prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_admin = 0) AND (last_seen_at < ? OR created_at < ?)')
      .run(idleCutoffOther, absoluteCutoffOther);
    return Number(admin.changes) + Number(other.changes);
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
