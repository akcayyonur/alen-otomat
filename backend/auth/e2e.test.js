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
      DB_FILE: join(dizin, 'telemetri.db'), LIBRARY_DB_FILE: join(dizin, 'kutuphane.db'), AUTH_DB_FILE: join(dizin, 'auth.db'), PLANNING_DB_FILE: join(dizin, 'planlama.db'),
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
  for (const yol of ['/api/machines', '/api/stream', '/api/library/config', '/api/config', '/api/machines/CNC-01', '/api/transfers', '/api/production', '/api/production/export.csv', '/api/planning/products']) {
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
  // program gecisleri (hangi program hangi saatte devreye girdi): izleme verisi, viewer gorur
  const gecis = await istek('GET', `/api/production/runs?machine=${id}`, { cerez: viewer });
  assert.equal(gecis.status, 200, gecis.text);
  assert.ok(Array.isArray(gecis.json.runs));
  assert.equal((await istek('GET', '/api/production/runs.csv', { cerez: viewer })).status, 200);
  assert.equal((await istek('GET', '/api/production/runs?from=abc', { cerez: viewer })).status, 400);
  assert.equal((await istek('GET', '/api/production/runs?machine=YOK-99', { cerez: viewer })).status, 404);

  // yonetici uclari: 403 (giris var ama yetki yok)
  const yasak = [
    ['GET', '/api/library/config'], ['GET', '/api/library/programs'], ['GET', '/api/library/matrix'], ['GET', '/api/library/customers'],
    ['GET', `/api/machines/${id}/programs`], ['POST', `/api/machines/${id}/programs/scan`], ['POST', `/api/machines/${id}/folders`],
    ['POST', '/api/transfers'], ['POST', '/api/transfers/precheck'], ['GET', '/api/transfers'],
    ['GET', '/api/config'], ['PUT', '/api/config/machines'], ['GET', '/api/drivers'],
    ['GET', '/api/users'], ['POST', '/api/users'], ['DELETE', '/api/users/1'], ['PUT', '/api/users/1/password'], ['GET', '/api/auth/audit'],
    ['POST', '/api/library/programs'], ['POST', '/api/library/programs/text'],
    ['POST', '/api/library/programs/delete'], ['GET', '/api/library/log'],
    ['POST', `/api/machines/${id}/programs/import-plan`], ['GET', `/api/machines/${id}/programs/import-plan/abc123`],
    ['GET', `/api/machines/${id}/programs/import-plan/abc123/diff`], ['POST', `/api/machines/${id}/programs/import-apply`],
    ['POST', `/api/machines/${id}/programs/delete-precheck`], ['POST', `/api/machines/${id}/programs/delete`],
    ['GET', '/api/planning/products'], ['POST', '/api/planning/products'], ['POST', '/api/planning/import'],
    ['GET', '/api/planning/orders'], ['GET', '/api/planning/programs'], ['PUT', '/api/planning/programs/map'],
    ['POST', '/api/planning/work-orders'], ['PUT', '/api/planning/work-orders/2026001055'],
    // planlama yazma/yonetim: izleyici okur ama yazamaz; siparis/uretim raporlari/hammadde hic goremez
    ['POST', '/api/planning/gkk'], ['PUT', '/api/planning/gkk/1'], ['DELETE', '/api/planning/gkk/1'], ['POST', '/api/planning/first-approvals'],
    ['PUT', '/api/planning/first-approvals/1'], ['POST', '/api/planning/work-orders/2026001055/drawings'],
    ['GET', '/api/planning/material/need'], ['GET', '/api/planning/efficiency'], ['GET', '/api/planning/downtime-report'],
  ];
  for (const [m, yol] of yasak) {
    const r = await istek(m, yol, { cerez: viewer, govde: m === 'GET' ? null : {} });
    assert.equal(r.status, 403, `${m} ${yol} viewer icin 403 olmali (geldi: ${r.status})`);
  }
});

test('operator (fabrika PC\'sinin ortak hesabi): is emri baslat/bitir ve durus nedeni acik; planlama/ayar/kutuphane/kullanici 403; IP gormez; viewer operator uclarini goremez', async () => {
  const admin = await girisYap('admin', SIFRE_ADMIN);
  const viewer = await girisYap('izleyici', SIFRE_VIEWER);
  const olustur = await istek('POST', '/api/users', { cerez: admin, govde: { username: 'fabrika', password: 'fabrika-sifre-1', role: 'operator' } });
  assert.equal(olustur.status, 201, olustur.text);
  assert.equal(olustur.json.user.role, 'operator');
  const op = await girisYap('fabrika', 'fabrika-sifre-1');
  assert.equal((await istek('GET', '/api/session', { cerez: op })).json.user.role, 'operator');

  // yonetici bir urun karti ve is emri acar
  const kart = await istek('POST', '/api/planning/products', { cerez: admin, govde: { stockCode: 'OP-001', name: 'OPERATOR DENEME', material: 'HM-1', grossKg: 0.05, netKg: 0.04, plannedSec: 20 } });
  assert.equal(kart.status, 201, kart.text);
  const emri = await istek('POST', '/api/planning/work-orders', { cerez: admin, govde: { stockCode: 'OP-001', targetQty: 10, machineId: 'CNC-01' } });
  assert.equal(emri.status, 201, emri.text);
  const no = emri.json.no;

  // operatorun acik uclari
  for (const yol of ['/api/planning/summary', '/api/planning/work-orders', `/api/planning/work-orders/${no}`, '/api/planning/downtime-codes', '/api/planning/shop/overview', '/api/planning/shop/stops?machine=CNC-01', '/api/machines']) {
    const r = await istek('GET', yol, { cerez: op });
    assert.equal(r.status, 200, `${yol} operator icin 200 olmali (geldi: ${r.status} ${r.text.slice(0, 120)})`);
    assert.ok(!r.text.includes('192.168.88.'), `${yol}: operator tezgah IP'si gormez`);
  }
  assert.equal((await istek('GET', '/api/planning/downtime-codes', { cerez: op })).json.codes.length, 48);
  // is emri: operator alan siniri (hedef adet degisemez), izinli alanlarla baslatir, sonra bitirir
  const yasak = await istek('POST', `/api/planning/work-orders/${no}/start`, { cerez: op, govde: { fields: { targetQty: 1 } } });
  assert.equal(yasak.status, 403);
  const basla = await istek('POST', `/api/planning/work-orders/${no}/start`, { cerez: op, govde: { person: 'Ayşe', fields: { gkkReportNo: '26-1' } } });
  assert.equal(basla.status, 200, basla.text);
  assert.equal(basla.json.status, 'uretimde');
  assert.equal(basla.json.startedBy, 'fabrika', 'islemi yapan hesap oturumdan gelir; "Ayse" yalniz serbest metin');
  assert.equal(basla.json.startedPerson, 'Ayşe');
  assert.equal((await istek('POST', '/api/planning/shop/downtime-reasons', { cerez: op, govde: { machineId: 'CNC-01', from: Date.now() - 600_000, to: Date.now() - 300_000, code: 'D1' } })).json.code, 'no-stop', 'uc acik, dogrulama calisir');
  assert.equal((await istek('DELETE', '/api/planning/shop/downtime-reasons/99999', { cerez: op })).status, 404);
  // kasa (Urun Tanitim Karti): operator acar, kapatir, paketleme adedini girer; kart numarasi sirasini YALNIZ yonetici ayarlar
  const kasaAc = await istek('POST', `/api/planning/work-orders/${no}/crates`, { cerez: op, govde: { person: 'Ayşe' } });
  assert.equal(kasaAc.status, 201, kasaAc.text);
  assert.match(kasaAc.json.cardNo, /^K\d{6}$/);
  assert.equal(kasaAc.json.openedBy, 'fabrika');
  assert.equal((await istek('POST', `/api/planning/crates/${kasaAc.json.id}/close`, { cerez: op, govde: {} })).json.state, 'kapali');
  assert.equal((await istek('POST', `/api/planning/crates/${kasaAc.json.id}/pack`, { cerez: op, govde: { qty: 5 } })).json.packedQty, 5);
  assert.equal((await istek('GET', '/api/planning/crates?state=paketlendi', { cerez: op })).json.total, 1);
  // tek adimli kart basma (kasa doldu): operator iş emrinden kart basar; kayit islemi yapan hesaba yazilir
  const kartBas = await istek('POST', `/api/planning/work-orders/${no}/cards`, { cerez: op, govde: { person: 'Ayşe', gkkReportNo: 'GKK-1' } });
  assert.equal(kartBas.status, 201, kartBas.text);
  assert.match(kartBas.json.cardNo, /^K\d{6}$/);
  assert.deepEqual([kartBas.json.state, kartBas.json.closedBy, kartBas.json.gkkReportNo], ['kapali', 'fabrika', 'GKK-1']);
  // is emri alani duzenleme (Tezgah basi): ilk onay rapor no / olculen net gramaj; planlama alanlari yoneticiye ozel
  const duz = await istek('POST', `/api/planning/work-orders/${no}/fields`, { cerez: op, govde: { fields: { firstApprovalNo: 'IO-1', measuredNetKg: 0.0079 } } });
  assert.equal(duz.status, 200, duz.text);
  assert.deepEqual([duz.json.firstApprovalNo, duz.json.updatedBy], ['IO-1', 'fabrika']);
  assert.equal((await istek('POST', `/api/planning/work-orders/${no}/fields`, { cerez: op, govde: { fields: { targetQty: 5 } } })).status, 403);
  // olcu kontrolu (EYS.FR.005): operator plani tanimlar, saatlik olcum girer, kartin foyunu gorur
  const plan = await istek('PUT', `/api/planning/work-orders/${no}/measure-plan`, { cerez: op, govde: { rows: [{ label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 }] } });
  assert.equal(plan.status, 200, plan.text);
  const olcum = await istek('POST', `/api/planning/work-orders/${no}/measurements`, { cerez: op, govde: { values: { 1: '34,13' }, checks: { gorsel: true }, person: 'Ayşe' } });
  assert.equal(olcum.status, 200, olcum.text);
  assert.equal(olcum.json.saved.by, 'fabrika');
  assert.equal((await istek('GET', `/api/planning/work-orders/${no}/measurements`, { cerez: op })).json.slots.length, 1);
  assert.equal((await istek('GET', `/api/planning/crates/${kartBas.json.id}/sheet`, { cerez: op })).status, 200);
  assert.equal((await istek('PUT', '/api/planning/crates/sequence', { cerez: op, govde: { last: 10 } })).status, 403, 'kart sirasi tabani yoneticiye ozel');
  assert.equal((await istek('PUT', '/api/planning/crates/sequence', { cerez: admin, govde: { last: 10 } })).status, 200);
  const bitir = await istek('POST', `/api/planning/work-orders/${no}/finish`, { cerez: op, govde: {} });
  assert.equal(bitir.status, 200, bitir.text);
  assert.equal(bitir.json.status, 'bitti');

  // operatorun KAPALI uclari
  const kapali = [
    ['GET', '/api/users'], ['POST', '/api/users'], ['GET', '/api/auth/audit'], ['GET', '/api/config'], ['PUT', '/api/config/machines'], ['GET', '/api/drivers'],
    ['GET', '/api/library/config'], ['GET', '/api/library/programs'], ['POST', '/api/transfers'], ['GET', '/api/machines/CNC-01/programs'],
    ['GET', '/api/planning/products'], ['POST', '/api/planning/products'], ['POST', '/api/planning/import'], ['GET', '/api/planning/orders'],
    ['POST', '/api/planning/work-orders'], ['GET', '/api/planning/work-orders/next'],
    ['PUT', '/api/planning/work-orders/sequence'], ['PUT', `/api/planning/work-orders/${no}`], ['POST', `/api/planning/work-orders/${no}/cancel`], ['POST', `/api/planning/work-orders/${no}/reopen`],
    ['GET', '/api/planning/material/need'], ['GET', '/api/planning/material/consumption'], ['GET', '/api/planning/material/consumption.csv'], ['POST', '/api/planning/material/fis'],
    ['GET', '/api/planning/efficiency'], ['GET', '/api/planning/downtime-report'], ['GET', '/api/planning/efficiency.csv'],
  ];
  for (const [m, yol] of kapali) {
    const r = await istek(m, yol, { cerez: op, govde: m === 'GET' ? null : {} });
    assert.equal(r.status, 403, `${m} ${yol} operator icin 403 olmali (geldi: ${r.status})`);
  }

  // operatorun ACIK program esleme uclari: okuma, dar urun aramasi, esle (kendi basina 403 DEGIL); urun karti listesi ise kapali kalir
  assert.equal((await istek('GET', '/api/planning/programs', { cerez: op })).status, 200);
  const ara = await istek('GET', '/api/planning/programs/product-search?q=A', { cerez: op });
  assert.equal(ara.status, 200, ara.text);
  assert.ok(Array.isArray(ara.json.items));
  assert.notEqual((await istek('PUT', '/api/planning/programs/map', { cerez: op, govde: { program: 'YOK-PROGRAM', stockCode: 'YOK.URUN' } })).status, 403, 'operator esleme yazabilir (urun yoksa 404, 403 degil)');
  assert.equal((await istek('GET', '/api/planning/products', { cerez: op })).status, 403, 'urun karti listesi operatore kapali');
  assert.deepEqual((await istek('GET', '/api/health', { cerez: op })).json, { ok: true }, 'operator saglik ayrintisini gormez');

  // viewer (izleyici) planlamada YALNIZ OKUR: yazan operator uclarini kullanamaz (403); anonim hicbirini goremez (401)
  for (const [m, yol] of [
    ['POST', '/api/planning/shop/downtime-reasons'],
    ['POST', `/api/planning/work-orders/${no}/start`], ['POST', `/api/planning/work-orders/${no}/finish`],
    ['POST', `/api/planning/work-orders/${no}/crates`], ['POST', `/api/planning/work-orders/${no}/cards`], ['POST', `/api/planning/work-orders/${no}/fields`],
    ['PUT', `/api/planning/work-orders/${no}/measure-plan`], ['POST', `/api/planning/work-orders/${no}/measurements`],
    ['POST', '/api/planning/crates/1/close'], ['POST', '/api/planning/crates/1/pack'], ['POST', '/api/planning/first-approvals'],
  ]) {
    assert.equal((await istek(m, yol, { cerez: viewer, govde: m === 'GET' ? null : {} })).status, 403, `viewer: ${m} ${yol}`);
    assert.equal((await istek(m, yol, { govde: m === 'GET' ? null : {} })).status, 401, `anonim: ${m} ${yol}`);
  }
  // okuma uclari izleyiciye ACIK (tezgah basi, is emirleri, olcu raporlari, GKK, ilk onay); IP gormez
  for (const yol of [
    '/api/planning/summary', '/api/planning/work-orders', `/api/planning/work-orders/${no}`, '/api/planning/downtime-codes', '/api/planning/shop/overview',
    '/api/planning/shop/stops?machine=CNC-01', '/api/planning/crates', `/api/planning/work-orders/${no}/measurements`, `/api/planning/crates/${kartBas.json.id}/sheet`,
    '/api/planning/gkk', '/api/planning/first-approvals', '/api/planning/measure-reports', `/api/planning/work-orders/${no}/measure-report`,
  ]) {
    const r = await istek('GET', yol, { cerez: viewer });
    assert.equal(r.status, 200, `viewer: GET ${yol} (geldi: ${r.status} ${r.text.slice(0, 100)})`);
    assert.ok(!r.text.includes('192.168.88.'), `${yol}: viewer tezgah IP'si gormez`);
    assert.equal((await istek('GET', yol)).status, 401, `anonim: GET ${yol}`);
  }
  assert.equal((await istek('GET', `/api/planning/work-orders/${no}/drawings.pdf`, { cerez: viewer })).status, 404, 'cizim yoksa 404 (yetki var)');

  // sonraki testler (CSRF: hesap sayisi) etkilenmesin
  assert.equal((await istek('DELETE', `/api/users/${olustur.json.user.id}`, { cerez: admin })).status, 200);
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

test('ingest: uzun kesintiden sonra ajanin tamponu (1 MB\'tan buyuk toplu paket) kabul edilir', async () => {
  // Ajan, backend kapaliyken mesajlari tamponlar ve geri gelince HEPSINI tek istekte yollar. 1 MB sinir bu paketi reddederdi
  // (ajan sonsuza dek ayni paketi yeniden denerdi). Sinir ingest icin ayri ve buyuk.
  const t0 = Date.now() - 6000 * 1000;
  const mesajlar = Array.from({ length: 6000 }, (_, i) => ({
    machineId: 'CNC-07', ts: new Date(t0 + i * 1000).toISOString(), status: 'RUNNING', source: 'syntec-remoteapi', mode: 'AUTO',
    program: 'P-TEST', mainProgram: 'P-TEST', partTotal: 100 + Math.floor(i / 25), partCount: Math.floor(i / 25), cycleTimeSec: i % 25, spindleRpm: 1800, feedRate: 120,
    controller: { vendor: 'SYNTEC', cncType: '11B', ncVersion: '10.116.54.19', seriesNo: 'M4L0007', rawStatus: 'START', platform: 'AM335x-H' },
  }));
  const govde = JSON.stringify(mesajlar);
  assert.ok(Buffer.byteLength(govde) > 1_000_000, 'paket 1 MB sinirini asmali');
  const r = await istek('POST', '/api/ingest', { govde });
  assert.equal(r.status, 202, r.text.slice(0, 200));
  assert.equal(r.json.accepted, 6000);
});

test('bozuk istekler 500 degil 400 verir: bozuk yuzde kodlamasi, nesne olmayan JSON govdesi (null/dizi/metin/sayi)', async () => {
  const admin = await girisYap('admin', SIFRE_ADMIN);
  assert.equal((await istek('GET', '/api/machines/%', { cerez: admin })).status, 400);
  assert.equal((await istek('GET', '/api/machines/%E0%A4%A/programs', { cerez: admin })).status, 400);
  const yollar = ['/api/library/programs/delete', '/api/library/programs/text', '/api/transfers', '/api/transfers/precheck', '/api/machines/CNC-01/programs/import', '/api/machines/CNC-01/folders'];
  for (const yol of yollar) {
    for (const govde of ['null', '[]', '"x"', '7']) {
      const r = await istek('POST', yol, { cerez: admin, govde, headers: { 'content-type': 'application/json' } });
      assert.ok(r.status >= 400 && r.status < 500, `${yol} govde=${govde}: 4xx beklenir, geldi ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
});
