/**
 * Kimlik dogrulamanin HTTP katmani:
 *   createGate        her istekten ONCE calisir: oturumu okur, policy.js'e gore izin verir/reddeder
 *   createAuthRoutes  /api/session, /api/auth/*, /api/users* uclari
 *
 * Cerez: `cnc_sid`, HttpOnly + SameSite=Strict (+ Secure, HTTPS arkasindaysa). Durum degistiren istekte
 * Origin/Sec-Fetch-Site denetlenir (CSRF). "Yerel" uclar (ajan ingest'i, ilk kurulum) yalniz sunucu
 * bilgisayarindan: baglanti yerel adresten gelmeli, Host localhost olmali (DNS yeniden baglama) ve
 * bir ters vekil/tunel basligi OLMAMALI (cloudflared gibi yerel vekil dis istegi yerel gosterir).
 */
import { classify } from './policy.js';
import { AuthError } from './auth.js';

export const COOKIE_NAME = 'cnc_sid';
const MAX_JSON_BYTES = 10_000;

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'tailscale-user-login'];

const DISABLED_USER = Object.freeze({ id: 0, username: 'yerel (giriş kapalı)', role: 'admin', authDisabled: true });

/* ------------------------------------------------------------------------ yardimcilar */

export function isLocalRequest(req) {
  if (!LOOPBACK_ADDRS.has(req.socket?.remoteAddress ?? '')) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(host);
}

/** Kayit icin istemci adresi: yerel bir vekil varsa onun ilettigi, yoksa baglanti adresi. */
export function clientIp(req) {
  const raw = req.socket?.remoteAddress ?? null;
  const addr = raw?.replace(/^::ffff:/, '') ?? null;
  if (raw && LOOPBACK_ADDRS.has(raw)) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd.slice(0, 64);
  }
  return addr;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function isSecure(req) {
  return !!req.socket?.encrypted || String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
}

function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;
}

const clearCookie = (req) => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;

/** Capraz site istegi (CSRF) mi? Yalniz durum degistiren yontemlerde denetlenir. */
function crossSiteWrite(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin) return false; // ajan/curl: cerez zaten SameSite=Strict ile capraz sitede gitmez
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new AuthError('İstek gövdesi çok büyük.', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AuthError('Gövde JSON olarak okunamadı.', 400);
  }
}

const publicUser = (u) => ({ username: u.username, role: u.role });

/* ----------------------------------------------------------------------------- kapi */

/**
 * @param {{auth: import('./auth.js').Auth, disabled?: boolean}} deps
 * @returns {(req, res, url: URL) => Promise<boolean>} true: devam; false: yanit zaten verildi
 */
export function createGate({ auth, disabled = false }) {
  return async function gate(req, res, url) {
    req.clientIp = clientIp(req);
    const isApi = url.pathname.toLowerCase().startsWith('/api');

    if (disabled) {
      req.user = DISABLED_USER;
      req.session = null;
      return true;
    }

    const session = isApi ? auth.authenticate(readCookie(req, COOKIE_NAME)) : null;
    req.session = session;
    req.user = session?.user ?? null;

    if (isApi && crossSiteWrite(req)) {
      send(res, 403, { error: 'Başka bir siteden gelen istek reddedildi.' });
      return false;
    }

    const kind = classify(req.method, url.pathname);
    if (kind === 'public') return true;
    if (kind === 'local') {
      if (isLocalRequest(req)) return true;
      send(res, 403, { error: 'Bu uç yalnızca sunucu bilgisayarından kullanılabilir.' });
      return false;
    }
    if (!req.user) {
      send(res, 401, { error: 'Giriş gerekli.' });
      return false;
    }
    if (kind === 'admin' && req.user.role !== 'admin') {
      send(res, 403, { error: 'Bu işlem için yönetici yetkisi gerekir.' });
      return false;
    }
    return true;
  };
}

/* ------------------------------------------------------------------------- uclar */

/**
 * @param {{auth: import('./auth.js').Auth, disabled?: boolean}} deps
 * @returns {(req, res, url: URL) => Promise<boolean>} true: istek bu modulde cevaplandi
 */
export function createAuthRoutes({ auth, disabled = false }) {
  const meta = (req) => ({ ip: req.clientIp ?? clientIp(req), userAgent: req.headers['user-agent'] ?? null });

  async function loginAndReply(req, res, username, password, status = 200) {
    const result = await auth.login(username, password, meta(req));
    send(res, status, { authenticated: true, user: publicUser(result.user) }, {
      'set-cookie': sessionCookie(req, result.token, result.maxAgeSec),
    });
  }

  return async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (!pathname.toLowerCase().startsWith('/api/')) return false;
    const usersMatch = /^\/api\/users(?:\/(\d+)(\/password)?)?$/.exec(pathname);
    const known =
      (method === 'GET' && pathname === '/api/session') ||
      (method === 'POST' && ['/api/auth/login', '/api/auth/setup', '/api/auth/logout', '/api/auth/password'].includes(pathname)) ||
      (method === 'GET' && pathname === '/api/auth/audit') ||
      usersMatch;
    if (!known) return false;

    try {
      if (method === 'GET' && pathname === '/api/session') {
        if (disabled) {
          return send(res, 200, { authenticated: true, authDisabled: true, user: publicUser(req.user) }), true;
        }
        if (req.user) return send(res, 200, { authenticated: true, user: publicUser(req.user) }), true;
        const setupRequired = auth.setupRequired;
        return send(res, 200, { authenticated: false, setupRequired, setupAllowed: setupRequired && isLocalRequest(req) }), true;
      }

      if (disabled && pathname !== '/api/auth/logout') {
        throw new AuthError('Giriş sistemi kapalı (AUTH_DISABLED=1): bu işlem kullanılamaz.', 400);
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        const b = await readJson(req);
        await loginAndReply(req, res, b.username, b.password);
        return true;
      }

      if (method === 'POST' && pathname === '/api/auth/setup') {
        if (!isLocalRequest(req)) {
          throw new AuthError('İlk yönetici hesabı yalnızca sunucu bilgisayarında (localhost) oluşturulabilir.', 403);
        }
        const b = await readJson(req);
        await auth.setup({ username: b.username, password: b.password }, meta(req));
        await loginAndReply(req, res, b.username, b.password, 201);
        return true;
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        auth.logout(readCookie(req, COOKIE_NAME), meta(req));
        send(res, 200, { ok: true }, { 'set-cookie': clearCookie(req) });
        return true;
      }

      if (method === 'POST' && pathname === '/api/auth/password') {
        const b = await readJson(req);
        await auth.changeOwnPassword(req.session, b.current, b.next, meta(req));
        return send(res, 200, { ok: true }), true;
      }

      if (method === 'GET' && pathname === '/api/auth/audit') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40));
        return send(res, 200, { events: auth.recentAudit(limit) }), true;
      }

      if (usersMatch) {
        const id = usersMatch[1] ? Number(usersMatch[1]) : null;
        const actor = req.user;
        if (method === 'GET' && id === null) return send(res, 200, { users: auth.listUsers() }), true;
        if (method === 'POST' && id === null) {
          const b = await readJson(req);
          const user = await auth.createUser({ username: b.username, password: b.password, role: b.role }, { actor, ...meta(req) });
          return send(res, 201, { user }), true;
        }
        if (method === 'DELETE' && id !== null && !usersMatch[2]) {
          auth.deleteUser(id, { actor, ...meta(req) });
          return send(res, 200, { ok: true }), true;
        }
        if (method === 'PUT' && id !== null && usersMatch[2]) {
          const b = await readJson(req);
          await auth.setPassword(id, b.password, { actor, ...meta(req) });
          return send(res, 200, { ok: true }), true;
        }
        return false;
      }
    } catch (err) {
      if (err instanceof AuthError) {
        send(res, err.status, { error: err.message, ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) },
          err.retryAfterSec ? { 'retry-after': String(err.retryAfterSec) } : {});
        return true;
      }
      throw err;
    }
    return false;
  };
}
