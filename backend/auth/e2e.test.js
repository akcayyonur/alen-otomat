/**
 * Kimlik dogrulama UCTAN UCA: gercek backend sureci (gecici veritabanlariyla) ve gercek HTTP.
 * Neyi kanitlar: giris olmadan hicbir veri uc'u acik degil; viewer YALNIZ izleme gorur (program kutuphanesi,
 * ayarlar, tezgah programlari, kullanicilar 403); ajan ucu yalniz yerel; CSRF; cikis; kilitleme;
 * viewer akisinda IP yok; islemi yapan kisi oturumdan gelir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOK = fileURLToPath(new URL('../..', import.meta.url));
let dizin;
let sunucu;
let port;

const SIFRE_ADMIN = 'yonetici-sifre-1';
const SIFRE_VIEWER = 'izleyici-sifre-1';

function bosPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/** Ham HTTP istegi: Host/X-Forwarded-For gibi basliklari serbestce ayarlayabilmek icin node:http. */
function istek(method, yol, { headers = {}, govde = null, cerez = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (cerez) h.cookie = cerez;
    let data = null;
    if (govde !== null) {
      data = Buffer.isBuffer(govde) ? govde : Buffer.from(typeof govde === 'string' ? govde : JSON.stringify(govde));
      h['content-length'] = data.length;
      h['content-type'] ??= Buffer.isBuffer(govde) ? 'application/octet-stream' : 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: yol, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* json degil */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Set-Cookie'den "cnc_sid=..." kismi. */
const cerezDegeri = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('cnc_sid=')) ?? null;

async function girisYap(kullanici, sifre) {
  const r = await istek('POST', '/api/auth/login', { govde: { username: kullanici, password: sifre } });
  assert.equal(r.status, 200, `giris: ${r.text}`);
  return cerezDegeri(r);
}

before(async () => {
  dizin = mkdtempSync(join(tmpdir(), 'cnc-auth-e2e-'));
  copyFileSync(join(KOK, 'config', 'machines.json'), join(dizin, 'machines.json'));
  port = await bosPort();
  sunucu = spawn(process.execPath, [join(KOK, 'backend', 'server.js')], {
    cwd: KOK,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DB_FILE: join(dizin, 'telemetri.db'), LIBRARY_DB_FILE: join(dizin, 'kutuphane.db'), AUTH_DB_FILE: join(dizin, 'auth.db'),
      MACHINES_FILE: join(dizin, 'machines.json'), AUTH_DISABLED: '', TRANSFER_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  sunucu.stdout.on('data', (c) => { log += c; });
  sunucu.stderr.on('data', (c) => { log += c; });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await istek('GET', '/api/health')).status === 200) return; } catch { /* henuz acilmadi */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend acilmadi:\n${log}`);
});

after(async () => {
  sunucu?.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { rmSync(dizin, { recursive: true, force: true }); } catch { /* Windows'ta kilitli kalabilir */ }
});

/* ------------------------------------------------------------------ kurulum oncesi */

test('hesap yokken: veri uclari kapali, statik sayfa acik, saglik yalniz "ok", kurulum yalniz yerelden', async () => {
  const s = await istek('GET', '/api/session');
  assert.equal(s.json.authenticated, false);
  assert.equal(s.json.setupRequired, true);
  assert.equal(s.json.setupAllowed, true, 'localhost uzerinden kurulum serbest');

  assert.equal((await istek('GET', '/')).status, 200, 'giris sayfasi icin statik dosyalar acik');
  assert.equal((await istek('GET', '/app.js')).status, 200);
  for (const yol of ['/api/machines', '/api/stream', '/api/library/config', '/api/config', '/api/machines/CNC-01', '/api/transfers', '/api/production', '/api/production/export.csv']) {
    assert.equal((await istek('GET', yol)).status, 401, `${yol} giris olmadan 401 vermeli`);
  }
  const saglik = await istek('GET', '/api/health');
  assert.deepEqual(saglik.json, { ok: true }, 'anonim saglik ayrinti sizdirmaz');

  // Ters vekil/tunel arkasindan (ya da baska Host ile) ilk kurulum YAPILAMAZ
  const vekil = await istek('POST', '/api/auth/setup', { headers: { 'x-forwarded-for': '203.0.113.7' }, govde: { username: 'admin', password: SIFRE_ADMIN } });
  assert.equal(vekil.status, 403);
  const baskaHost = await istek('POST', '/api/auth/setup', { headers: { host: 'saldirgan.example' }, govde: { username: 'admin', password: SIFRE_ADMIN } });
  assert.equal(baskaHost.status, 403, 'DNS yeniden baglama: Host localhost degil');
  assert.equal((await istek('GET', '/api/session')).json.setupRequired, true, 'reddedilen denemeler hesap acmadi');
});

test('ilk kurulum: yonetici olusur, oturum cerezi guvenli bayraklarla verilir, ikinci kurulum 409', async () => {
  const r = await istek('POST', '/api/auth/setup', { govde: { username: 'admin', password: SIFRE_ADMIN } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.user, { username: 'admin', role: 'admin' });
  const cookie = (r.headers['set-cookie'] ?? [])[0] ?? '';
  assert.match(cookie, /^cnc_sid=[A-Za-z0-9_-]{40,}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=43200/, 'admin: 12 saat');
  assert.doesNotMatch(cookie, /Secure/, 'HTTP uzerinde Secure yok');

  const yine = await istek('POST', '/api/auth/setup', { govde: { username: 'baska', password: SIFRE_ADMIN } });
  assert.equal(yine.status, 409, 'hesap varken ikinci kurulum reddedilir');
  assert.match(yine.json.error, /zaten yapılmış/);
  assert.equal((await istek('GET', '/api/session')).json.setupRequired, false);
});

/* ----------------------------------------------------------------------- admin */

test('admin: her sey acik; viewer hesabi olusturur', async () => {
  const admin = await girisYap('admin', SIFRE_ADMIN);
  const me = await istek('GET', '/api/session', { cerez: admin });
  assert.deepEqual(me.json, { authenticated: true, user: { username: 'admin', role: 'admin' } });

  const ms = await istek('GET', '/api/machines', { cerez: admin });
  assert.equal(ms.status, 200);
  assert.ok(ms.json.machines.length >= 1);
  assert.ok(ms.json.machines.some((m) => m.ip), 'admin tezgah IP\'lerini gorur');

  for (const yol of ['/api/library/config', '/api/config', '/api/drivers', '/api/library/programs', '/api/transfers', '/api/users', '/api/auth/audit']) {
    assert.equal((await istek('GET', yol, { cerez: admin })).status, 200, yol);
  }
  const saglik = await istek('GET', '/api/health', { cerez: admin });
  assert.ok(saglik.json.db, 'admin saglik ayrintisini gorur');

  const v = await istek('POST', '/api/users', { cerez: admin, govde: { username: 'izleyici', password: SIFRE_VIEWER, role: 'viewer' } });
  assert.equal(v.status, 201, v.text);
  assert.ok(!v.text.includes('scrypt'), 'yanitta sifre ozeti yok');
  const liste = await istek('GET', '/api/users', { cerez: admin });
  assert.deepEqual(liste.json.users.map((u) => [u.username, u.role]), [['admin', 'admin'], ['izleyici', 'viewer']]);
});

/* ---------------------------------------------------------------------- viewer */

test('viewer: yalniz izleme; kutuphane, ayarlar, tezgah programlari/klasorleri, aktarim, kullanicilar 403', async () => {
  const viewer = await girisYap('izleyici', SIFRE_VIEWER);
  const me = await istek('GET', '/api/session', { cerez: viewer });
  assert.deepEqual(me.json.user, { username: 'izleyici', role: 'viewer' });
  assert.match((await istek('POST', '/api/auth/login', { govde: { username: 'izleyici', password: SIFRE_VIEWER } })).headers['set-cookie'][0], /Max-Age=2592000/, 'viewer: 30 gun');

  // izleme: acik
  const ms = await istek('GET', '/api/machines', { cerez: viewer });
  assert.equal(ms.status, 200);
  assert.ok(ms.json.machines.length >= 1);
  assert.ok(ms.json.machines.every((m) => m.ip === undefined && m.ftpPort === undefined), 'viewer tezgah IP/port gormez');
  assert.ok(!ms.text.includes('192.168.88.'), 'yanitin HICBIR yerinde torna IP\'si yok');

  const id = ms.json.machines[0].machineId;
  const detay = await istek('GET', `/api/machines/${id}?window=30m`, { cerez: viewer });
  assert.equal(detay.status, 200);
  assert.equal(detay.json.machine.ip, undefined);
  assert.ok(!detay.text.includes('192.168.88.'));
  for (const alt of ['history?window=30m', 'spans?window=30m', 'summary?window=30m', 'downtimes?window=30m', 'export.csv?window=30m']) {
    assert.equal((await istek('GET', `/api/machines/${id}/${alt}`, { cerez: viewer })).status, 200, alt);
  }
  assert.deepEqual((await istek('GET', '/api/health', { cerez: viewer })).json, { ok: true }, 'viewer saglik ayrintisini gormez');

  // uretim raporu (vardiya adetleri) izleme verisidir: viewer gorur; tezgah IP'si icermez; hatali istek 400/404
  const uretim = await istek('GET', `/api/production?machine=${id}`, { cerez: viewer });
  assert.equal(uretim.status, 200, uretim.text);
  assert.deepEqual(uretim.json.shifts.map((x) => x.id), ['gunduz', 'gece']);
  assert.ok(!uretim.text.includes('192.168.88.'));
  const uretimCsv = await istek('GET', '/api/production/export.csv?view=urun', { cerez: viewer });
  assert.equal(uretimCsv.status, 200);
  assert.match(uretimCsv.headers['content-type'], /text\/csv/);
  assert.equal((await istek('GET', '/api/production?from=abc', { cerez: viewer })).status, 400);
  assert.equal((await istek('GET', '/api/production/export.csv?view=yok', { cerez: viewer })).status, 400);
  assert.equal((await istek('GET', '/api/production?machine=YOK-99', { cerez: viewer })).status, 404);

  // yonetici uclari: 403 (giris var ama yetki yok)
  const yasak = [
    ['GET', '/api/library/config'], ['GET', '/api/library/programs'], ['GET', '/api/library/matrix'], ['GET', '/api/library/customers'],
    ['GET', `/api/machines/${id}/programs`], ['POST', `/api/machines/${id}/programs/scan`], ['POST', `/api/machines/${id}/folders`],
    ['POST', '/api/transfers'], ['POST', '/api/transfers/precheck'], ['GET', '/api/transfers'],
    ['GET', '/api/config'], ['PUT', '/api/config/machines'], ['GET', '/api/drivers'],
    ['GET', '/api/users'], ['POST', '/api/users'], ['DELETE', '/api/users/1'], ['PUT', '/api/users/1/password'], ['GET', '/api/auth/audit'],
    ['POST', '/api/library/programs'], ['POST', '/api/library/programs/text'],
    ['POST', `/api/machines/${id}/programs/import-plan`], ['GET', `/api/machines/${id}/programs/import-plan/abc123`],
    ['GET', `/api/machines/${id}/programs/import-plan/abc123/diff`], ['POST', `/api/machines/${id}/programs/import-apply`],
    ['POST', `/api/machines/${id}/programs/delete-precheck`], ['POST', `/api/machines/${id}/programs/delete`],
  ];
  for (const [m, yol] of yasak) {
    const r = await istek(m, yol, { cerez: viewer, govde: m === 'GET' ? null : {} });
    assert.equal(r.status, 403, `${m} ${yol} viewer icin 403 olmali (geldi: ${r.status})`);
  }
});

test('viewer canli akisi (SSE): kareler gelir ama tezgah IP\'si icermez; admin akisi icerir', async () => {
  const viewer = await girisYap('izleyici', SIFRE_VIEWER);
  const admin = await girisYap('admin', SIFRE_ADMIN);
  const ilkKare = (cerez) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie: cerez, host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf);
        if (m) { req.destroy(); resolve({ status: res.statusCode, text: m[1], json: JSON.parse(m[1]) }); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => { req.destroy(); reject(new Error('akis karesi gelmedi')); }, 5000);
  });
  const v = await ilkKare(viewer);
  assert.equal(v.status, 200);
  assert.ok(v.json.machines.length >= 1);
  assert.ok(!v.text.includes('192.168.88.'), 'viewer akisinda IP yok');
  const a = await ilkKare(admin);
  assert.ok(a.text.includes('192.168.88.'), 'admin akisinda IP var');

  const anonim = await istek('GET', '/api/stream');
  assert.equal(anonim.status, 401);
});

/* --------------------------------------------------------------- ajan (yerel) ucu */

test('ajan uclari: giris GEREKTIRMEZ ama yalniz sunucu bilgisayarindan; vekil/baska Host ile 403', async () => {
  const mesaj = { machineId: 'CNC-01', status: 'RUNNING', source: 'simulator' };
  const ok = await istek('POST', '/api/ingest', { govde: mesaj });
  assert.ok([202, 207].includes(ok.status), `yerel ingest kabul edilmeli: ${ok.status} ${ok.text}`);
  assert.equal((await istek('GET', '/api/agent/machines?driver=syntec-remoteapi')).status, 200);

  for (const baslik of [{ 'x-forwarded-for': '203.0.113.7' }, { 'cf-connecting-ip': '203.0.113.7' }, { host: 'saldirgan.example' }]) {
    assert.equal((await istek('POST', '/api/ingest', { headers: baslik, govde: mesaj })).status, 403, JSON.stringify(baslik));
    assert.equal((await istek('GET', '/api/agent/machines', { headers: baslik })).status, 403);
  }
  // giris yapmis admin bile uzaktan ingest'e yazamaz (yalniz yerel)
  const admin = await girisYap('admin', SIFRE_ADMIN);
  assert.equal((await istek('POST', '/api/ingest', { cerez: admin, headers: { 'x-forwarded-for': '203.0.113.7' }, govde: mesaj })).status, 403);
});

/* ------------------------------------------------------------------------ CSRF */

test('CSRF: baska siteden gelen yazma istekleri (Origin / Sec-Fetch-Site) reddedilir, ayni site gecer', async () => {
  const admin = await girisYap('admin', SIFRE_ADMIN);
  const govde = { username: 'denemeci', password: 'deneme-sifre-9', role: 'viewer' };
  const kotu1 = await istek('POST', '/api/users', { cerez: admin, headers: { origin: 'http://saldirgan.example' }, govde });
  assert.equal(kotu1.status, 403);
  const kotu2 = await istek('POST', '/api/users', { cerez: admin, headers: { 'sec-fetch-site': 'cross-site' }, govde });
  assert.equal(kotu2.status, 403);
  assert.equal((await istek('GET', '/api/users', { cerez: admin })).json.users.length, 2, 'reddedilen istek hesap acmadi');

  const iyi = await istek('POST', '/api/users', { cerez: admin, headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, govde });
  assert.equal(iyi.status, 201);
  const sil = await istek('DELETE', `/api/users/${iyi.json.user.id}`, { cerez: admin });
  assert.equal(sil.status, 200);
});

/* ----------------------------------------------- islemi yapan kisi oturumdan gelir */

test('denetim: program yukleyen kisi istemcinin yazdigi "by" degil, oturumdaki kullanici adi olur', async () => {
  const admin = await girisYap('admin', SIFRE_ADMIN);
  const y = await istek('POST', '/api/library/programs?customer=AA&name=KIMLIK-1&by=sahtekar', { cerez: admin, govde: Buffer.from('G0 X0.\r\nM99\r\n') });
  assert.equal(y.status, 201, y.text);
  assert.equal(y.json.version.createdBy, 'admin', 'sunucu oturumdan alir');
  assert.notEqual(y.json.version.createdBy, 'sahtekar');
});

/* ---------------------------------------------------------------- cikis ve sifre */

test('sifre degistirme: yanlis mevcut sifre 400; dogruysa diger oturumlar kapanir', async () => {
  const c1 = await girisYap('izleyici', SIFRE_VIEWER);
  const c2 = await girisYap('izleyici', SIFRE_VIEWER);
  const yanlis = await istek('POST', '/api/auth/password', { cerez: c1, govde: { current: 'yanlis-sifre-0', next: 'yeni-sifre-1234' } });
  assert.equal(yanlis.status, 400);
  const ok = await istek('POST', '/api/auth/password', { cerez: c1, govde: { current: SIFRE_VIEWER, next: 'yeni-sifre-1234' } });
  assert.equal(ok.status, 200);
  assert.equal((await istek('GET', '/api/machines', { cerez: c1 })).status, 200, 'degistiren oturum acik');
  assert.equal((await istek('GET', '/api/machines', { cerez: c2 })).status, 401, 'diger oturum kapandi');
  assert.equal((await istek('POST', '/api/auth/login', { govde: { username: 'izleyici', password: SIFRE_VIEWER } })).status, 401, 'eski sifre gecmez');
  assert.equal((await istek('POST', '/api/auth/login', { govde: { username: 'izleyici', password: 'yeni-sifre-1234' } })).status, 200);
});

test('cikis: cerez silinir, eski belirtec bir daha gecmez', async () => {
  const c = await girisYap('admin', SIFRE_ADMIN);
  assert.equal((await istek('GET', '/api/machines', { cerez: c })).status, 200);
  const r = await istek('POST', '/api/auth/logout', { cerez: c });
  assert.equal(r.status, 200);
  assert.match(r.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await istek('GET', '/api/machines', { cerez: c })).status, 401);
  assert.equal((await istek('GET', '/api/session', { cerez: c })).json.authenticated, false);
});

test('kilitleme: ust uste yanlis giris 429 + Retry-After; saldirgan belirtec uyduramaz', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await istek('POST', '/api/auth/login', { govde: { username: 'hedef-kisi', password: `yanlis-${i}` } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Kullanıcı adı ya da şifre hatalı.');
  }
  const kilit = await istek('POST', '/api/auth/login', { govde: { username: 'hedef-kisi', password: 'yanlis-5' } });
  assert.equal(kilit.status, 429);
  assert.ok(Number(kilit.headers['retry-after']) > 0);

  for (const sahte of ['cnc_sid=bos', 'cnc_sid=' + 'A'.repeat(43), 'cnc_sid=../../etc/passwd', 'baska=1']) {
    assert.equal((await istek('GET', '/api/machines', { cerez: sahte })).status, 401, sahte);
  }
});

test('guvenlik basliklari her yanitta; bozuk/buyuk govde kontrollu hata verir', async () => {
  const r = await istek('GET', '/');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  const bozuk = await istek('POST', '/api/auth/login', { govde: '{bozuk', headers: { 'content-type': 'application/json' } });
  assert.equal(bozuk.status, 400);
  const buyuk = await istek('POST', '/api/auth/login', { govde: { username: 'x'.repeat(20_000), password: 'y' } });
  assert.equal(buyuk.status, 413);
});
