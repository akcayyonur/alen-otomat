/**
 * Kimlik dogrulama servisi: hesaplar, roller, giris, oturum, kilitleme. HTTP'den bagimsiz (saf mantik);
 * cerez/baslik isleri http.js'te.
 *
 * Roller (2026-10-30, esnek rol sistemi):
 *   admin   TEK sabit rol: her seyi gorur ve yapar (kutuphane, editor, gonderme, ayarlar, kullanicilar/roller)
 *   (diger herkes)  admin'in Ayarlar > Roller'dan tanimladigi bir role baglidir (shared/screens.js'teki her
 *           ekran icin Kapali / Gorebilir / Yazabilir); eski sabit "viewer"/"operator" roller GOCTE esdeger
 *           rollere tasindi (bkz. auth-db.js), davranislari degismedi - artik admin bunlari DUZENLEYEBILIR.
 *
 * Guvenlik kararlari:
 *   - Sifreler scrypt ile; belirtec rastgele 32 bayt, veritabaninda yalniz SHA-256 ozeti.
 *   - Oturum bosta kalma suresi: admin 12 saat (mutlak 7 gun), admin-disi HERKES 30 gun (mutlak 90 gun;
 *     fabrika PC'si surekli acik kalir, ortak hesap yetkisi dardir).
 *   - Basarisiz giris: (adres, kullanici) basina 15 dakikada 5, adres basina 20 deneme; sonra kilit.
 *   - Kullanici bulunamasa da sifre dogrulamasi kadar sure harcanir (kullanici adi sizdirilmasin).
 *   - Son yonetici silinemez; kimse kendi hesabini silemez. Sifre degisince diger oturumlar kapanir.
 */
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, validatePassword } from './password.js';
import { validateGrants } from '../../shared/screens.js';

export class AuthError extends Error {
  /** @param {string} message @param {number} [status] @param {object} [extra] */
  constructor(message, status = 401, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    Object.assign(this, extra);
  }
}

export const IDLE_MS_ADMIN = 12 * 3_600_000;
export const ABSOLUTE_MS_ADMIN = 7 * 86_400_000;
export const IDLE_MS_OTHER = 30 * 86_400_000;
export const ABSOLUTE_MS_OTHER = 90 * 86_400_000;

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const TOUCH_EVERY_MS = 60_000;
const LOCK_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 20;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Rol adi gecerli mi (yeni rol / rol duzenleme); sorun yoksa null. "admin" sabit rol oldugu icin YASAK. */
function validateRoleName(name) {
  const t = String(name ?? '').trim();
  if (t.length < 2 || t.length > 40) return 'Rol adı 2-40 karakter olmalı.';
  if (t.toLowerCase() === 'admin') return '"admin" sabit bir roldür: bu adla yeni rol oluşturulamaz.';
  return null;
}

const publicRole = (r) => (r ? { id: r.id, name: r.name, grants: r.grants } : null);

export class Auth {
  /** @param {{db: import('./auth-db.js').AuthDb, now?: () => number}} deps */
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
    /** @type {Map<string, number[]>} */
    this.userFails = new Map();
    /** @type {Map<string, number[]>} */
    this.ipFails = new Map();
    this.dummyHash = null;
  }

  /** Hic hesap yok: ilk kurulum (yalniz sunucu bilgisayarindan) bekleniyor. */
  get setupRequired() {
    return this.db.countUsers() === 0;
  }

  #audit(event, username, ip, detail = null) {
    this.db.audit({ ts: this.now(), username, event, ip, detail });
  }

  /* ----------------------------------------------------------------------- kilitleme */

  #recent(map, key) {
    const cut = this.now() - LOCK_WINDOW_MS;
    const list = (map.get(key) ?? []).filter((t) => t > cut);
    if (list.length === 0) map.delete(key);
    else map.set(key, list);
    return list;
  }

  #assertNotLocked(ip, username) {
    const u = this.#recent(this.userFails, `${ip}|${username.toLowerCase()}`);
    const i = this.#recent(this.ipFails, String(ip));
    const locked = u.length >= MAX_FAILS_PER_USER ? u : i.length >= MAX_FAILS_PER_IP ? i : null;
    if (locked) {
      const retryAfterSec = Math.max(1, Math.ceil((locked[0] + LOCK_WINDOW_MS - this.now()) / 1000));
      this.#audit('login_locked', username, ip);
      throw new AuthError(
        `Çok fazla başarısız deneme. ${Math.ceil(retryAfterSec / 60)} dakika sonra tekrar deneyin.`,
        429,
        { retryAfterSec },
      );
    }
  }

  #recordFail(ip, username) {
    const now = this.now();
    for (const [map, key] of [[this.userFails, `${ip}|${username.toLowerCase()}`], [this.ipFails, String(ip)]]) {
      const list = this.#recent(map, key);
      list.push(now);
      map.set(key, list);
    }
  }

  /* -------------------------------------------------------------------- roller */

  listRoles() {
    return this.db.listRoles().map(publicRole);
  }

  /** @param {{name: string, grants: object}} input @returns {object} */
  createRole({ name, grants }, { actor = null, ip = null } = {}) {
    const nameErr = validateRoleName(name);
    if (nameErr) throw new AuthError(nameErr, 400);
    const gErr = validateGrants(grants ?? {});
    if (gErr) throw new AuthError(gErr, 400);
    try {
      const role = this.db.createRole({ name: String(name).trim(), grants: grants ?? {}, now: this.now(), by: actor?.username ?? null });
      this.#audit('role_created', actor?.username ?? null, ip, role.name);
      return publicRole(role);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw new AuthError('Bu rol adı zaten var.', 409);
      throw err;
    }
  }

  updateRole(id, { name, grants }, { actor = null, ip = null } = {}) {
    const cur = this.db.getRole(id);
    if (!cur) throw new AuthError('Rol bulunamadı.', 404);
    const nameErr = validateRoleName(name);
    if (nameErr) throw new AuthError(nameErr, 400);
    const gErr = validateGrants(grants ?? {});
    if (gErr) throw new AuthError(gErr, 400);
    try {
      this.db.updateRole(id, { name: String(name).trim(), grants: grants ?? {} });
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw new AuthError('Bu rol adı zaten var.', 409);
      throw err;
    }
    this.#audit('role_updated', actor?.username ?? null, ip, cur.name);
    return publicRole(this.db.getRole(id));
  }

  deleteRole(id, { actor = null, ip = null } = {}) {
    const cur = this.db.getRole(id);
    if (!cur) throw new AuthError('Rol bulunamadı.', 404);
    const n = this.db.countUsersWithRole(id);
    if (n > 0) throw new AuthError(`Bu role atanmış ${n} hesap var; önce onları silin ya da başka role taşıyın.`, 409);
    this.db.deleteRole(id);
    this.#audit('role_deleted', actor?.username ?? null, ip, cur.name);
  }

  /* -------------------------------------------------------------------- hesaplar */

  /** @returns {{isAdmin: boolean, roleId: number|null}} */
  #resolveRole(role) {
    if (role === 'admin') return { isAdmin: true, roleId: null };
    const r = this.db.findRoleByName(String(role ?? ''));
    if (!r) throw new AuthError(`Rol bulunamadı: "${role}" (önce Ayarlar > Roller'dan oluşturun).`, 400);
    return { isAdmin: false, roleId: r.id };
  }

  async #validateNew({ username, password, role }) {
    if (!USERNAME_RE.test(String(username ?? ''))) {
      throw new AuthError('Kullanıcı adı 3-32 karakter olmalı (harf, rakam, ".", "_", "-").', 400);
    }
    const resolved = this.#resolveRole(role);
    const bad = validatePassword(password);
    if (bad) throw new AuthError(bad, 400);
    return resolved;
  }

  async #insert({ username, password, isAdmin, roleId }) {
    const passwordHash = await hashPassword(password);
    try {
      return this.db.createUser({ username, isAdmin, roleId, passwordHash, now: this.now() });
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw new AuthError('Bu kullanıcı adı zaten var.', 409);
      throw err;
    }
  }

  /** Ilk yonetici (hesap yokken). Cagiran, istegin sunucu bilgisayarindan geldigini zaten denetlemis olmali. */
  async setup({ username, password }, { ip = null } = {}) {
    if (!this.setupRequired) throw new AuthError('Kurulum zaten yapılmış.', 409);
    const resolved = await this.#validateNew({ username, password, role: 'admin' });
    const user = await this.#insert({ username, password, ...resolved });
    this.#audit('setup', user.username, ip, 'ilk yönetici hesabı');
    return user;
  }

  /** @param {{role: 'admin'|string}} input role: 'admin' sabit roldur, aksi halde bir rol ADI (roles tablosunda var olmali) */
  async createUser({ username, password, role }, { actor = null, ip = null } = {}) {
    const resolved = await this.#validateNew({ username, password, role });
    const user = await this.#insert({ username, password, ...resolved });
    this.#audit('user_created', actor?.username ?? null, ip, `${user.username} (${role})`);
    return { ...user, roleName: user.roleId ? this.db.getRole(user.roleId)?.name ?? null : null };
  }

  listUsers() {
    const roleNames = new Map(this.db.listRoles().map((r) => [r.id, r.name])); // N+1 sorgu yerine tek harita
    return this.db.listUsers().map((u) => ({ ...u, roleName: u.roleId ? roleNames.get(u.roleId) ?? null : null }));
  }

  deleteUser(userId, { actor = null, ip = null } = {}) {
    const target = this.db.getUser(userId);
    if (!target) throw new AuthError('Kullanıcı bulunamadı.', 404);
    if (actor && actor.id === target.id) throw new AuthError('Kendi hesabınızı silemezsiniz.', 400);
    if (target.isAdmin && this.db.countAdmins() <= 1) {
      throw new AuthError('Son yönetici hesabı silinemez.', 400);
    }
    this.db.deleteUser(target.id);
    this.#audit('user_deleted', actor?.username ?? null, ip, target.username);
  }

  /** Yonetici baska bir kullanicinin sifresini belirler; o kullanicinin tum oturumlari kapanir. */
  async setPassword(userId, newPassword, { actor = null, ip = null } = {}) {
    const target = this.db.getUser(userId);
    if (!target) throw new AuthError('Kullanıcı bulunamadı.', 404);
    const bad = validatePassword(newPassword);
    if (bad) throw new AuthError(bad, 400);
    this.db.setPassword(target.id, await hashPassword(newPassword));
    this.db.deleteUserSessions(target.id);
    this.#audit('password_set', actor?.username ?? null, ip, target.username);
  }

  /** Kullanici kendi sifresini degistirir (eskisini bilmeli); diger oturumlari kapanir, bu kalir. */
  async changeOwnPassword(auth, currentPassword, newPassword, { ip = null } = {}) {
    const stored = this.db.getUserHashById(auth.user.id);
    if (!(await verifyPassword(currentPassword, stored))) {
      this.#audit('password_change_fail', auth.user.username, ip);
      throw new AuthError('Mevcut şifre yanlış.', 400);
    }
    const bad = validatePassword(newPassword);
    if (bad) throw new AuthError(bad, 400);
    this.db.setPassword(auth.user.id, await hashPassword(newPassword));
    this.db.deleteUserSessions(auth.user.id, auth.tokenHash);
    this.#audit('password_changed', auth.user.username, ip);
  }

  /* ------------------------------------------------------------------ giris / oturum */

  /** @returns {Promise<{token: string, user: object, maxAgeSec: number}>} */
  async login(username, password, { ip = null, userAgent = null } = {}) {
    const name = String(username ?? '').trim();
    this.#assertNotLocked(ip, name);

    const record = name ? this.db.getUserWithHash(name) : null;
    if (!this.dummyHash) this.dummyHash = await hashPassword('zamanlama-icin-sahte-sifre');
    // Kullanici yoksa da ayni maliyette bir dogrulama yap: sure farki kullanici adini sizdirmasin.
    const ok = await verifyPassword(String(password ?? ''), record?.passwordHash ?? this.dummyHash);
    if (!record || !ok) {
      this.#recordFail(ip, name);
      this.#audit('login_fail', name || null, ip);
      throw new AuthError('Kullanıcı adı ya da şifre hatalı.', 401);
    }

    this.userFails.delete(`${ip}|${name.toLowerCase()}`);
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.createSession({ tokenHash: sha256(token), userId: record.id, now, ip, userAgent });
    this.db.touchLogin(record.id, now);
    this.#audit('login_ok', record.username, ip);
    const { passwordHash, ...user } = record; // eslint-disable-line no-unused-vars
    return { token, user: this.#withRole(user), maxAgeSec: Math.floor((user.isAdmin ? IDLE_MS_ADMIN : IDLE_MS_OTHER) / 1000) };
  }

  /** Kullaniciya rol adi + yetkileri (grants) ekler (admin icin grants=null: her seye zaten erisir). */
  #withRole(user) {
    if (user.isAdmin || !user.roleId) return { ...user, roleName: null, grants: user.isAdmin ? null : {} };
    const r = this.db.getRole(user.roleId);
    return { ...user, roleName: r?.name ?? null, grants: r?.grants ?? {} };
  }

  /** Belirteci dogrular, bosta kalma suresini kaydirir. @returns {{user: object, tokenHash: string}|null} */
  authenticate(token) {
    const s = this.#lookup(token);
    if (!s) return null;
    const now = this.now();
    if (now - s.lastSeenAt > TOUCH_EVERY_MS) this.db.touchSession(s.tokenHash, now);
    return { user: s.user, tokenHash: s.tokenHash };
  }

  /** Acik bir akis (SSE) icin: oturum hala gecerli mi (suresini UZATMADAN). */
  isValid(tokenHash) {
    const s = this.db.getSession(tokenHash);
    return !!s && !this.#expired(s);
  }

  #expired(s) {
    const now = this.now();
    const idle = s.user.isAdmin ? IDLE_MS_ADMIN : IDLE_MS_OTHER;
    const abs = s.user.isAdmin ? ABSOLUTE_MS_ADMIN : ABSOLUTE_MS_OTHER;
    return now - s.lastSeenAt > idle || now - s.createdAt > abs;
  }

  #lookup(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const s = this.db.getSession(sha256(token));
    if (!s) return null;
    if (this.#expired(s)) {
      this.db.deleteSession(s.tokenHash);
      return null;
    }
    return s;
  }

  logout(token, { ip = null } = {}) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return;
    const hash = sha256(token);
    const s = this.db.getSession(hash);
    if (!s) return;
    this.db.deleteSession(hash);
    this.#audit('logout', s.user.username, ip);
  }

  /** Suresi dolmus oturumlari temizler (zamanlayici cagirir); basarisiz giris sayaclarini da bosaltir. */
  purge() {
    for (const map of [this.userFails, this.ipFails]) {
      for (const key of [...map.keys()]) this.#recent(map, key); // eskileri atar, bos kalani siler
    }
    const now = this.now();
    return this.db.purgeSessions({
      idleCutoffAdmin: now - IDLE_MS_ADMIN, absoluteCutoffAdmin: now - ABSOLUTE_MS_ADMIN,
      idleCutoffOther: now - IDLE_MS_OTHER, absoluteCutoffOther: now - ABSOLUTE_MS_OTHER,
    });
  }

  recentAudit(limit = 50) {
    return this.db.listAudit(limit);
  }
}
