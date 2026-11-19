/**
 * SİPARİŞ FİŞİ (atölye malzeme/takım talebi): olusturma, kalemlerin (adet/malın cinsi/marka) dogrulanmasi,
 * durum gecisleri (bekliyor -> verildi -> geldi, geri al), duzenleme, silme, liste/arama, HTTP. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const NOW = new Date(2026, 10, 17, 9).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

test('olusturma: isim ve en az bir kalem zorunlu; kalem alanlari dogrulanir; tarih bos ise bugun; kod S000001 bicimli', () => {
  const p = kur();
  const sr = p.supplyRequests;
  const s = sr.create({ requestedBy: ' Onur Öztürk ', lines: [{ qty: 2, item: 'B114.0016.2.02', brand: 'HORN' }, { qty: '10', item: 'RS114.0200.D2 TH35' }] }, { by: 'onur', now: NOW });
  assert.deepEqual([s.id, s.code, s.requestedBy, s.status, s.createdBy], [1, 'S000001', 'Onur Öztürk', 'bekliyor', 'onur']);
  assert.equal(new Date(s.requestedOn).toDateString(), new Date(NOW).toDateString(), 'tarih bos -> bugun');
  assert.deepEqual(s.lines, [{ qty: 2, item: 'B114.0016.2.02', brand: 'HORN' }, { qty: 10, item: 'RS114.0200.D2 TH35', brand: null }]);

  assert.throws(() => sr.create({ lines: [{ qty: 1, item: 'X' }] }, { now: NOW }), (e) => e.status === 400 && /İsim/.test(e.message));
  assert.throws(() => sr.create({ requestedBy: 'A' }, { now: NOW }), (e) => e.status === 400, 'lines yok');
  assert.throws(() => sr.create({ requestedBy: 'A', lines: [] }, { now: NOW }), (e) => /en az bir kalem/i.test(e.message));
  assert.throws(() => sr.create({ requestedBy: 'A', lines: [{ qty: 0, item: 'X' }] }, { now: NOW }), (e) => /adet/.test(e.message), 'adet pozitif olmali');
  assert.throws(() => sr.create({ requestedBy: 'A', lines: [{ qty: 1, item: '' }] }, { now: NOW }), (e) => /malın cinsi/.test(e.message));
  assert.throws(() => sr.create({ requestedBy: 'A', lines: Array.from({ length: 61 }, () => ({ qty: 1, item: 'X' })) }, { now: NOW }), (e) => /en fazla 60/i.test(e.message));
  assert.throws(() => sr.create({ requestedBy: 'A', lines: 'yanlis' }, { now: NOW }), (e) => e.status === 400);
});

test('durum: bekliyor -> verildi -> geldi; sirasi disinda gecis reddedilir; "geri al" bir adim doner', () => {
  const p = kur();
  const sr = p.supplyRequests;
  const s = sr.create({ requestedBy: 'Onur', lines: [{ qty: 1, item: 'X' }] }, { now: NOW });
  assert.throws(() => sr.receive(s.id, { now: NOW }), (e) => e.status === 409, 'bekliyorken teslim alinamaz');
  assert.deepEqual(sr.back(s.id, { now: NOW }), s, 'bekliyorken geri alinamaz: no-op');

  const verildi = sr.order(s.id, { by: 'veli', now: NOW + 1000 });
  assert.deepEqual([verildi.status, verildi.orderedBy, verildi.orderedOn], ['verildi', 'veli', NOW + 1000]);
  assert.throws(() => sr.order(s.id, { now: NOW }), (e) => e.status === 409, 'zaten verildi');

  const geldi = sr.receive(s.id, { by: 'ali', now: NOW + 2000 });
  assert.deepEqual([geldi.status, geldi.receivedBy, geldi.receivedOn], ['geldi', 'ali', NOW + 2000]);
  assert.throws(() => sr.receive(s.id, { now: NOW }), (e) => e.status === 409, 'zaten geldi');

  const geri1 = sr.back(s.id, { now: NOW + 3000 });
  assert.deepEqual([geri1.status, geri1.receivedOn, geri1.receivedBy], ['verildi', null, null], 'geldi -> verildi, alan temizlendi');
  const geri2 = sr.back(s.id, { now: NOW + 4000 });
  assert.deepEqual([geri2.status, geri2.orderedOn, geri2.orderedBy], ['bekliyor', null, null], 'verildi -> bekliyor, alan temizlendi');
});

test('duzenleme: yalniz gonderilen alanlar degisir; lines gonderilirse TUMU degisir (wholesale); arama/liste/silme', () => {
  const p = kur();
  const sr = p.supplyRequests;
  const a = sr.create({ requestedBy: 'Onur', note: 'ilk not', lines: [{ qty: 2, item: 'B114.0016.2.02', brand: 'HORN' }] }, { now: NOW });
  const u1 = sr.update(a.id, { note: 'yeni not' }, { by: 'veli', now: NOW });
  assert.deepEqual([u1.note, u1.requestedBy, u1.lines, u1.updatedBy], ['yeni not', 'Onur', a.lines, 'veli'], 'yalniz note degisti');
  const u2 = sr.update(a.id, { lines: [{ qty: 5, item: 'RB18P.0016.01', brand: 'HORN' }, { qty: 1, item: 'B105.0025.01' }] }, { now: NOW });
  assert.deepEqual(u2.lines, [{ qty: 5, item: 'RB18P.0016.01', brand: 'HORN' }, { qty: 1, item: 'B105.0025.01', brand: null }], 'eski kalemler TAMAMEN degisti');
  assert.throws(() => sr.update(99999, { note: 'x' }), (e) => e.status === 404);

  sr.create({ requestedBy: 'Veli', lines: [{ qty: 3, item: 'FARKLI-KOD' }] }, { now: NOW });
  const hepsi = sr.list({}, { now: NOW });
  assert.equal(hepsi.total, 2);
  assert.deepEqual(sr.list({ q: 'rb18p' }).items.map((x) => x.id), [a.id], 'malin cinsi ile bosluksuz arama');
  assert.deepEqual(sr.list({ q: 'horn' }).items.map((x) => x.id), [a.id], 'marka ile arama');
  assert.equal(sr.list({ q: 'yok-boyle-bir-sey' }).total, 0);

  assert.deepEqual(sr.delete(a.id), { ok: true });
  assert.throws(() => sr.get(a.id), (e) => e.status === 404);
  assert.throws(() => sr.delete(a.id), (e) => e.status === 404);
});

/* ====================================================================================== HTTP */

test('HTTP: olustur, listele/ara/durum-suz, duzenle, durum gecisleri, sil', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    req.user = { isAdmin: true, username: 'ali' };
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const c = await j('/api/planning/supply-requests', 'POST', { requestedBy: 'Onur Öztürk', lines: [{ qty: 2, item: 'B114.0016.2.02', brand: 'HORN' }] });
    assert.deepEqual([c.status, c.json.code, c.json.status], [201, 'S000001', 'bekliyor']);
    assert.equal((await j('/api/planning/supply-requests', 'POST', { requestedBy: 'X', lines: [] })).status, 400);

    const liste = await j('/api/planning/supply-requests?q=horn');
    assert.deepEqual([liste.status, liste.json.total], [200, 1]);
    assert.equal((await j('/api/planning/supply-requests?status=verildi')).json.total, 0);

    assert.equal((await j(`/api/planning/supply-requests/${c.json.id}`, 'PUT', { note: 'acil' })).json.note, 'acil');
    const ordered = await j(`/api/planning/supply-requests/${c.json.id}/order`, 'POST', {});
    assert.deepEqual([ordered.status, ordered.json.status], [200, 'verildi']);
    const received = await j(`/api/planning/supply-requests/${c.json.id}/receive`, 'POST', {});
    assert.equal(received.json.status, 'geldi');
    const back = await j(`/api/planning/supply-requests/${c.json.id}/back`, 'POST', {});
    assert.equal(back.json.status, 'verildi');

    assert.equal((await j(`/api/planning/supply-requests/${c.json.id}`, 'DELETE')).status, 200);
    assert.equal((await j(`/api/planning/supply-requests/${c.json.id}`)).status, 404);
    assert.equal((await j('/api/planning/supply-requests/99999', 'DELETE')).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
