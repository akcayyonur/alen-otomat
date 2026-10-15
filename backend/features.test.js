/**
 * Kurulumda KAPALI bölümler (config/features.json): dosya doğrulaması, sunucu uçlarının reddi (yönetici dahil), oturumla arayüze bildirim,
 * hatalı dosyada sunucunun başlamaması. Kapalı bölümde kart basma / yeniden yazdırma / ölçü föyü / ret ÇALIŞMAYA DEVAM eder.
 * TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSABLE_SECTIONS, loadFeatures, validateFeatures } from '../shared/features.js';
import { tabsForRole, defaultTabFor } from '../dashboard/planning-tabs.js';
import { Planning } from './planning/planning.js';
import { createPlanningRoutes } from './planning/routes.js';

const KOK = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------ dosya dogrulama */

test('features: gecerli dosya; kapali bolumler tekrarsiz ve sabit sirada; dosya yoksa her sey acik; depodaki dosya gecerli', () => {
  assert.deepEqual(validateFeatures({ closedSections: [] }), { closedSections: [] });
  assert.deepEqual(validateFeatures({}), { closedSections: [] }, 'alan yoksa hepsi acik');
  assert.deepEqual(validateFeatures({ closedSections: ['hammadde', 'paketleme', 'hammadde'] }), { closedSections: ['paketleme', 'hammadde'] });
  assert.deepEqual(validateFeatures({ _aciklama: 'not', closedSections: ['paketleme'] }), { closedSections: ['paketleme'] });
  assert.deepEqual(loadFeatures(join(tmpdir(), 'cnc-features-yok-dosya.json')), { closedSections: [] });
  const repo = loadFeatures();
  assert.ok(Array.isArray(repo.closedSections), 'depodaki config/features.json gecerli');
  assert.deepEqual(Object.keys(CLOSABLE_SECTIONS), ['paketleme', 'hammadde']);
});

test('features: hatali dosya sessizce kabul edilmez (bilinmeyen bolum, yanlis yazilmis anahtar, liste degil, bozuk JSON)', () => {
  assert.throws(() => validateFeatures({ closedSections: ['paketlem'] }), /kapatılamayan ya da bilinmeyen bölüm "paketlem"/);
  assert.throws(() => validateFeatures({ closedSections: ['tezgahbasi'] }), /kapatılamayan/, 'tezgah basi gibi cekirdek bolumler kapatilamaz');
  assert.throws(() => validateFeatures({ closedSection: ['paketleme'] }), /bilinmeyen anahtar "closedSection"/, 'yanlis yazilmis anahtar bolumu ACIK birakirdi');
  assert.throws(() => validateFeatures({ closedSections: 'paketleme' }), /liste olmalı/);
  assert.throws(() => validateFeatures({ closedSections: [1] }), /bölüm "1"/);
  assert.throws(() => validateFeatures(null), /nesne olmalı/);
  assert.throws(() => validateFeatures([]), /nesne olmalı/);
  const d = mkdtempSync(join(tmpdir(), 'cnc-features-'));
  try {
    writeFileSync(join(d, 'bozuk.json'), '{bozuk');
    assert.throws(() => loadFeatures(join(d, 'bozuk.json')), /okunamadı/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------- sekmeler */

test('sekmeler: kapali bolum HICBIR rolde (yonetici dahil) gorunmez; digerleri ve acilis sekmesi etkilenmez', () => {
  const kapali = ['paketleme', 'hammadde'];
  assert.ok(!tabsForRole('admin', kapali).includes('paketleme') && !tabsForRole('admin', kapali).includes('hammadde'));
  assert.deepEqual(tabsForRole('admin', kapali), ['tezgahbasi', 'isemirleri', 'gkk', 'ilkonay', 'olcuraporlari', 'verimlilik', 'urunler', 'siparisler', 'programlar']);
  assert.deepEqual(tabsForRole('operator', kapali), ['tezgahbasi', 'isemirleri', 'gkk', 'ilkonay', 'olcuraporlari', 'programlar'], 'operator Paketleme sekmesini de gormez');
  assert.deepEqual(tabsForRole('viewer', kapali), tabsForRole('viewer'), 'izleyici zaten gormuyordu');
  assert.deepEqual(tabsForRole('admin', ['hammadde']).includes('paketleme'), true, 'yalniz listedeki kapanir');
  assert.deepEqual(tabsForRole('admin', []), tabsForRole('admin'));
  for (const r of ['admin', 'operator', 'viewer']) assert.ok(tabsForRole(r, kapali).includes(defaultTabFor(r)), `${r} acilis sekmesini gorebilmeli`);
});

/* ------------------------------------------------------------------- sunucu uclari */

async function sunucu(closedSections) {
  const planning = new Planning({ dbFile: ':memory:', listMachines: () => [{ id: 'CNC-01', name: 'Torna 1' }], productionEvents: () => [], liveMachine: () => null });
  const routes = createPlanningRoutes({ planning, closedSections });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => {
    const r = await fetch(base + yol, init);
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { j, kapat: async () => { await new Promise((r) => srv.close(r)); planning.close(); } };
}
const post = (obj = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

const MATERIAL_UCLARI = [
  ['GET', '/api/planning/material/need'],
  ['GET', '/api/planning/material/consumption'],
  ['GET', '/api/planning/material/consumption.csv?view=hammadde'],
  ['POST', '/api/planning/material/fis'],
  ['POST', '/api/planning/material/fis/undo'],
];

test('sunucu: kapali hammadde bolumunde /material/* uclari reddedilir; paketleme uclari etkilenmez', async () => {
  const s = await sunucu(['hammadde']);
  try {
    for (const [method, yol] of MATERIAL_UCLARI) {
      const r = await s.j(yol, method === 'POST' ? post({ orders: [] }) : undefined);
      assert.equal(r.status, 403, `${method} ${yol}`);
      assert.deepEqual(r.json, { error: 'Bu bölüm bu kurulumda kapalı.', code: 'section-closed', section: 'hammadde' });
    }
    assert.notEqual((await s.j('/api/planning/crates/1/pack', post({ qty: 1 }))).json?.code, 'section-closed', 'paketleme acik');
    assert.equal((await s.j('/api/planning/summary')).status, 200);
  } finally { await s.kapat(); }
});

test('sunucu: kapali paketleme bolumunde YALNIZ kesin adet girisi reddedilir; kasa listesi, kapatma, iptal, kart basma acik kalir', async () => {
  const s = await sunucu(['paketleme']);
  try {
    const pack = await s.j('/api/planning/crates/1/pack', post({ qty: 5 }));
    assert.equal(pack.status, 403);
    assert.deepEqual(pack.json, { error: 'Bu bölüm bu kurulumda kapalı.', code: 'section-closed', section: 'paketleme' });
    assert.equal((await s.j('/api/planning/crates?state=kapali')).status, 200, 'kasa listesi (kart/ölçü föyü akışları kullanır) acik');
    assert.equal((await s.j('/api/planning/crates?state=ret')).status, 200);
    // kapatma / iptal / kart basma ayni 403'u VERMEZ (olmayan kasa 404, olmayan is emri 404/400 gibi kendi hatalarini verir)
    for (const yol of ['/api/planning/crates/1/close', '/api/planning/crates/1/void', '/api/planning/work-orders/2026000001/cards', '/api/planning/work-orders/2026000001/crates']) {
      const r = await s.j(yol, post({ reason: 'deneme' }));
      assert.notEqual(r.json?.code, 'section-closed', yol);
      assert.notEqual(r.status, 403, yol);
    }
    for (const [, yol] of MATERIAL_UCLARI.slice(0, 2)) assert.equal((await s.j(yol)).status, 200, `hammadde acik: ${yol}`);
  } finally { await s.kapat(); }
});

test('sunucu: hicbir bolum kapali degilken (varsayilan) hicbir uc 403 section-closed vermez', async () => {
  const s = await sunucu([]);
  try {
    for (const [method, yol] of MATERIAL_UCLARI) {
      const r = await s.j(yol, method === 'POST' ? post({ orders: [] }) : undefined);
      assert.notEqual(r.json?.code, 'section-closed', `${method} ${yol}`);
    }
    assert.notEqual((await s.j('/api/planning/crates/1/pack', post({ qty: 1 }))).json?.code, 'section-closed');
  } finally { await s.kapat(); }
});

/* ------------------------------------------------------------ gercek sunucu sureci */

function bosPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function istek(port, method, yol, { govde = null, cerez = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}` };
    if (cerez) h.cookie = cerez;
    let data = null;
    if (govde !== null) { data = Buffer.from(JSON.stringify(govde)); h['content-length'] = data.length; h['content-type'] = 'application/json'; }
    const req = http.request({ host: '127.0.0.1', port, method, path: yol, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* json degil */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function ortam(dizin, port, featuresFile) {
  return {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1',
    DB_FILE: join(dizin, 'telemetri.db'), LIBRARY_DB_FILE: join(dizin, 'kutuphane.db'), AUTH_DB_FILE: join(dizin, 'auth.db'), PLANNING_DB_FILE: join(dizin, 'planlama.db'),
    MACHINES_FILE: join(dizin, 'machines.json'), AUTH_DISABLED: '', TRANSFER_DISABLED: '1', FEATURES_FILE: featuresFile,
  };
}

test('gercek sunucu: kapali bolumler oturumla arayuze bildirilir; yonetici dahil 403 section-closed; kart/kasa listesi acik', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'cnc-features-e2e-'));
  copyFileSync(join(KOK, 'config', 'machines.json'), join(dizin, 'machines.json'));
  writeFileSync(join(dizin, 'features.json'), JSON.stringify({ closedSections: ['paketleme', 'hammadde'] }));
  const port = await bosPort();
  const proc = spawn(process.execPath, [join(KOK, 'backend', 'server.js')], { cwd: KOK, env: ortam(dizin, port, join(dizin, 'features.json')), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  try {
    let hazir = false;
    for (let i = 0; i < 60 && !hazir; i += 1) {
      try { hazir = (await istek(port, 'GET', '/api/health')).status === 200; } catch { /* henuz acilmadi */ }
      if (!hazir) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(hazir, `backend acilmadi:\n${log}`);
    assert.match(log, /KAPALI bölümler \(config\/features\.json\): paketleme, hammadde/, 'acilista hangi bolumlerin kapali oldugu yazilir');

    const kur = await istek(port, 'POST', '/api/auth/setup', { govde: { username: 'admin', password: 'yonetici-sifre-1' } });
    assert.equal(kur.status, 201, kur.text);
    const cerez = (kur.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('cnc_sid='));
    assert.ok(cerez);

    const oturum = await istek(port, 'GET', '/api/session', { cerez });
    assert.deepEqual(oturum.json, { authenticated: true, user: { username: 'admin', role: 'admin' }, closedSections: ['paketleme', 'hammadde'] });
    assert.deepEqual((await istek(port, 'GET', '/api/session')).json.closedSections, undefined, 'giris yapmayana bolum bilgisi verilmez');

    for (const yol of ['/api/planning/material/need', '/api/planning/material/consumption']) {
      const r = await istek(port, 'GET', yol, { cerez });
      assert.equal(r.status, 403, `${yol}: yonetici bile`);
      assert.equal(r.json.code, 'section-closed');
    }
    const pack = await istek(port, 'POST', '/api/planning/crates/1/pack', { cerez, govde: { qty: 3 } });
    assert.equal(pack.status, 403);
    assert.equal(pack.json.code, 'section-closed');

    // kart/kasa akisi ve is emri ayrintisi acik: hammadde bilgi paneli (consumption) iş emri ayrintisiyla gelmeye devam eder
    assert.equal((await istek(port, 'GET', '/api/planning/crates?state=tumu', { cerez })).status, 200);
    assert.equal((await istek(port, 'GET', '/api/planning/measure-reports', { cerez })).status, 200);
    const kart = await istek(port, 'POST', '/api/planning/products', { cerez, govde: { stockCode: 'KP-001', name: 'KAPALI DENEME', material: 'HM-1', grossKg: 0.05, netKg: 0.04, plannedSec: 20 } });
    assert.equal(kart.status, 201, kart.text);
    const emri = await istek(port, 'POST', '/api/planning/work-orders', { cerez, govde: { stockCode: 'KP-001', targetQty: 10, machineId: 'CNC-01' } });
    assert.equal(emri.status, 201, emri.text);
    const ayrinti = await istek(port, 'GET', `/api/planning/work-orders/${emri.json.no}`, { cerez });
    assert.equal(ayrinti.status, 200);
    assert.ok('consumption' in ayrinti.json, 'is emri ayrintisindaki Hammadde bilgisi kalir');

    // kart basma, ret, olcu foyu ve kart listesi paketleme kapaliyken CALISIR; yalniz paketleme adedi girisi kapali
    const basla = await istek(port, 'POST', `/api/planning/work-orders/${emri.json.no}/start`, { cerez, govde: { person: 'Ayşe' } });
    assert.equal(basla.status, 200, basla.text);
    const k1 = await istek(port, 'POST', `/api/planning/work-orders/${emri.json.no}/cards`, { cerez, govde: { person: 'Ayşe', steps: { washTo: true } } });
    assert.equal(k1.status, 201, k1.text);
    assert.equal(k1.json.state, 'kapali');
    const k2 = await istek(port, 'POST', `/api/planning/work-orders/${emri.json.no}/cards`, { cerez, govde: { person: 'Ayşe', reject: true } });
    assert.equal(k2.status, 201, k2.text);
    assert.equal(k2.json.state, 'ret');
    assert.equal((await istek(port, 'GET', `/api/planning/crates/${k1.json.id}`, { cerez })).status, 200, 'kart yeniden yazdirilabilir (kasa ayrintisi)');
    assert.equal((await istek(port, 'GET', `/api/planning/crates/${k1.json.id}/sheet`, { cerez })).status, 200, 'olcu foyu');
    assert.deepEqual((await istek(port, 'GET', '/api/planning/crates?state=ret', { cerez })).json.items.map((x) => x.id), [k2.json.id]);
    const sayi = await istek(port, 'POST', `/api/planning/crates/${k1.json.id}/pack`, { cerez, govde: { qty: 5 } });
    assert.equal(sayi.status, 403, 'kesin paketleme adedi girilemez');
    assert.equal(sayi.json.code, 'section-closed');
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 400));
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* Windows'ta kilitli kalabilir */ }
  }
});

test('gercek sunucu: hatali features dosyasiyla BASLAMAZ ve nedenini yazar', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'cnc-features-bad-'));
  copyFileSync(join(KOK, 'config', 'machines.json'), join(dizin, 'machines.json'));
  writeFileSync(join(dizin, 'features.json'), JSON.stringify({ closedSections: ['paketlem'] }));
  const port = await bosPort();
  const proc = spawn(process.execPath, [join(KOK, 'backend', 'server.js')], { cwd: KOK, env: ortam(dizin, port, join(dizin, 'features.json')), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  try {
    const kod = await new Promise((resolve) => {
      const t = setTimeout(() => { proc.kill(); resolve('zaman-asimi'); }, 15000);
      proc.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.notEqual(kod, 'zaman-asimi', `sunucu hatali dosyayla kapanmadi:\n${log}`);
    assert.notEqual(kod, 0);
    assert.match(log, /kapatılamayan ya da bilinmeyen bölüm "paketlem"/);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* Windows'ta kilitli kalabilir */ }
  }
});
