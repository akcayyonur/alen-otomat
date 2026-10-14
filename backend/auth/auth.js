/**
 * Kimlik dogrulama servisi: hesaplar, giris, oturum, kilitleme. HTTP'den bagimsiz (saf mantik);
 * cerez/baslik isleri http.js'te.
 *
 * Roller:
 *   admin   herseyi gorur ve yapar (kutuphane, editor, gonderme, ayarlar, kullanicilar)
 *   viewer  yalniz izleme (filo, tezgah detayi, raporlar); program kutuphanesi, ayarlar ve
 *           tezgahlardaki "Programlar" paneli YOK (sunucu da bu uclari reddeder, bkz. policy.js)
 *   operator fabrika PC'sinin ORTAK hesabi (planlama T asamasi): izleme okuma + is emri baslat/bitir + durus nedeni girisi;
 *           planlama ayarlari, siparis/urun duzenleme, program kutuphanesi, ayarlar YOK (bkz. policy.js)
 *
 * Guvenlik kararlari:
 *   - Sifreler scrypt ile; belirtec rastgele 32 bayt, veritabaninda yalniz SHA-256 ozeti.
 *   - Oturum bosta kalma suresi role gore: admin 12 saat, viewer ve operator 30 gun (mutlak ust sinir 7 / 90 / 90 gun;
 *     operator: fabrika PC'si surekli acik kalir, ortak hesap yetkisi dardir).
 *   - Basarisiz giris: (adres, kullanici) basina 15 dakikada 5, adres basina 20 deneme; sonra kilit.
 *   - Kullanici bulunamasa da sifre dogrulamasi kadar sure harcanir (kullanici adi sizdirilmasin).
 *   - Son yonetici silinemez; kimse kendi hesabini silemez. Sifre degisince diger oturumlar kapanir.
 */
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, validatePassword } from './password.js';

export class AuthError extends Error {
  /** @param {string} message @param {number} [status] @param {object} [extra] */
  constructor(message, status = 401, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    Object.assign(this, extra);
  }
}

export const ROLES = Object.freeze(['admin', 'viewer', 'operator']);
export const IDLE_MS = Object.freeze({ admin: 12 * 3_600_000, viewer: 30 * 86_400_000, operator: 30 * 86_400_000 });
export const ABSOLUTE_MS = Object.freeze({ admin: 7 * 86_400_000, viewer: 90 * 86_400_000, operator: 90 * 86_400_000 });

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const TOUCH_EVERY_MS = 60_000;
const LOCK_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 20;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

  /* -------------------------------------------------------------------- hesaplar */

  async #validateNew({ username, password, role }) {
    if (!USERNAME_RE.test(String(username ?? ''))) {
      throw new AuthError('Kullanıcı adı 3-32 karakter olmalı (harf, rakam, ".", "_", "-").', 400);
    }
    if (!ROLES.includes(role)) throw new AuthError(`Rol geçersiz: "${role}" (admin, viewer ya da operator).`, 400);
    const bad = validatePassword(password);
    if (bad) throw new AuthError(bad, 400);
  }

  async #insert({ username, password, role }) {
    const passwordHash = await hashPassword(password);
    try {
      return this.db.createUser({ username, role, passwordHash, now: this.now() });
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw new AuthError('Bu kullanıcı adı zaten var.', 409);
      throw err;
    }
  }

  /** Ilk yonetici (hesap yokken). Cagiran, istegin sunucu bilgisayarindan geldigini zaten denetlemis olmali. */
  async setup({ username, password }, { ip = null } = {}) {
    if (!this.setupRequired) throw new AuthError('Kurulum zaten yapılmış.', 409);
    await this.#validateNew({ username, password, role: 'admin' });
    const user = await this.#insert({ username, password, role: 'admin' });
    this.#audit('setup', user.username, ip, 'ilk yönetici hesabı');
    return user;
  }

  async createUser({ username, password, role }, { actor = null, ip = null } = {}) {
    await this.#validateNew({ username, password, role });
    const user = await this.#insert({ username, password, role });
    this.#audit('user_created', actor?.username ?? null, ip, `${user.username} (${user.role})`);
    return user;
  }

  listUsers() {
    return this.db.listUsers();
  }

  deleteUser(userId, { actor = null, ip = null } = {}) {
    const target = this.db.getUser(userId);
    if (!target) throw new AuthError('Kullanıcı bulunamadı.', 404);
    if (actor && actor.id === target.id) throw new AuthError('Kendi hesabınızı silemezsiniz.', 400);
    if (target.role === 'admin' && this.db.countAdmins() <= 1) {
      throw new AuthError('Son yönetici hesabı silinemez.', 400);
    }
    this.db.deleteUser(target.id);
    this.#audit('user_deleted', actor?.username ?? null, ip, `${target.username} (${target.role})`);
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
    return { token, user, maxAgeSec: Math.floor(IDLE_MS[record.role] / 1000) };
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
    const role = s.user.role;
    return now - s.lastSeenAt > IDLE_MS[role] || now - s.createdAt > ABSOLUTE_MS[role];
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
    const idleCutoffByRole = {};
    const absoluteCutoffByRole = {};
    for (const role of ROLES) {
      idleCutoffByRole[role] = now - IDLE_MS[role];
      absoluteCutoffByRole[role] = now - ABSOLUTE_MS[role];
    }
    return this.db.purgeSessions({ idleCutoffByRole, absoluteCutoffByRole });
  }

  recentAudit(limit = 50) {
    return this.db.listAudit(limit);
  }
}
