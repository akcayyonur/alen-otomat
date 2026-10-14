/**
 * Kasalar / Urun Tanitim Karti (planlama K asamasi): kasa ac-kapat (tezgah sayaci + telemetri adedi), paketleme sayimi, iptal, is emri toplamlari,
 * is emri bitince otomatik kapanma, kart numarasi sirasi, HTTP. TUM veriler sentetiktir.
 *
 * Kasa dolarken adet BILINMEZ: kapanista telemetrinin saydigi adet (tahmin) ve sayaclar kaydedilir; KESIN adet paketlemede girilir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(10);
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

function kur() {
  const st = { events: [], live: new Map() };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MAKINELER,
    productionEvents: (machineId, from, to) => st.events.filter((e) => e.machineId === machineId && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
    liveMachine: (id) => st.live.get(id) ?? null,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
const ev = (ts, qty = 1, o = {}) => ({ machineId: 'CNC-01', ts, program: '140100187', qty, partTotal: null, cycleSec: 24, gapMs: 0, suspect: false, ...o });
const canli = (partTotal, o = {}) => ({ connected: true, state: 'RUNNING', program: '140100187', partTotal, ...o });
/** Uretimde bir is emri (CNC-01, 07:00'den beri). */
function uretimde(p, o = {}) {
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01', ...o }, { now: NOW });
  return p.startWorkOrder(w.no, { startAt: day(7) }, { now: NOW });
}

test('kasa ac: yalniz uretimdeki is emrinde, kart numarasini sistem verir, baslangic sayaci kaydedilir, ayni anda tek acik kasa', () => {
  const { p, st } = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  assert.throws(() => p.openCrate(w.no, {}, { now: NOW }), (e) => e.status === 409 && e.code === 'bad-status', 'baslamamis is emrinde kasa acilmaz');
  p.startWorkOrder(w.no, { startAt: day(7) }, { now: NOW });

  st.live.set('CNC-01', canli(20011));
  const k = p.openCrate(w.no, { person: 'Ayşe', note: 'mavi kasa' }, { by: 'fabrika', now: day(9) });
  assert.deepEqual([k.cardNo, k.state, k.seq, k.startTotal, k.openedBy, k.openedPerson, k.note], ['K000001', 'acik', 1, 20011, 'fabrika', 'Ayşe', 'mavi kasa']);
  assert.deepEqual([k.stockCode, k.productName, k.customerCode, k.machineId, k.woNo], ['SR001.013', 'TEST SOMUN A', '100000013', 'CNC-01', w.no], 'karttaki is emri bilgileri');
  assert.deepEqual(k.warnings, []);
  assert.throws(() => p.openCrate(w.no, {}, { now: day(9, 1) }), (e) => e.status === 409 && e.code === 'crate-open' && /K000001/.test(e.message));
  assert.match(p.getWorkOrder(w.no, { now: NOW }).events.at(-1).detail, /K000001 · Ayşe · sayaç 20011/);

  st.live.delete('CNC-01'); // tezgahtan veri yok: kasa yine acilir, sayac bilinmez, uyari verilir
  p.closeCrate(k.id, {}, { now: day(9, 30) });
  const k2 = p.openCrate(w.no, {}, { now: day(9, 31) });
  assert.deepEqual([k2.cardNo, k2.startTotal], ['K000002', null]);
  assert.match(k2.warnings.join('|'), /veri gelmiyor/);
  assert.throws(() => p.openCrate('2026999999', {}), (e) => e.status === 404);
});

test('kasa kapat: sayilan adet telemetriden (ac-kapa araligi), bitis sayaci, arka arkaya kasalar ayni parcayi iki kez saymaz', () => {
  const { p, st } = kur();
  const w = uretimde(p);
  st.live.set('CNC-01', canli(100));
  st.events.push(ev(day(8, 59)), ev(day(9, 5)), ev(day(9, 10), 1, { suspect: true }), ev(day(9, 20), 2, { gapMs: 90_000 }), ev(day(9, 30)), ev(day(9, 45)), ev(day(10, 5)));
  const a = p.openCrate(w.no, {}, { now: day(9) });
  assert.equal(p.getCrate(a.id, { now: day(9, 25) }).countedQty, 3, 'acik kasanin adedi canli: 09:05 + 2 (kopukluktan sonra) = 3; supheli sicrama sayilmaz');

  st.live.set('CNC-01', canli(103));
  const kapali = p.closeCrate(a.id, { person: 'Veli' }, { now: day(9, 30) });
  assert.deepEqual([kapali.state, kapali.countedQty, kapali.approxQty, kapali.startTotal, kapali.endTotal, kapali.counterDiff, kapali.closedPerson, kapali.closedAt], ['kapali', 4, 2, 100, 103, 3, 'Veli', day(9, 30)]);
  assert.deepEqual(kapali.warnings, []);
  assert.throws(() => p.closeCrate(a.id, {}, { now: day(9, 31) }), (e) => e.code === 'bad-status' && /zaten kapalı/.test(e.message));

  // ayni anda kapan + yeni ac: 09:30'daki parca YALNIZ birinci kasada
  const b = p.openCrate(w.no, {}, { now: day(9, 30) });
  const bKapali = p.closeCrate(b.id, {}, { now: day(10) });
  assert.equal(bKapali.countedQty, 1, 'baslangic dislanir, bitis dahil: yalniz 09:45');
  const bos = p.openCrate(w.no, {}, { now: day(10, 1) });
  assert.match(p.closeCrate(bos.id, {}, { now: day(10, 2) }).warnings.join('|'), /hiç parça sayılmadı/);
});

test('paketleme adedi: kesin sayi kasa kapandiktan sonra girilir, duzeltilebilir, paket - sayilan fark gorunur', () => {
  const { p, st } = kur();
  const w = uretimde(p);
  st.events.push(ev(day(9, 5)), ev(day(9, 6)), ev(day(9, 7)));
  const a = p.openCrate(w.no, {}, { now: day(9) });
  assert.throws(() => p.packCrate(a.id, { qty: 3 }, { now: day(9, 10) }), (e) => e.code === 'crate-open', 'acik kasa paketlenmez');
  p.closeCrate(a.id, {}, { now: day(9, 30) });

  for (const kotu of [0, -3, 1.5, 'abc', '', null, 1_000_001]) {
    assert.throws(() => p.packCrate(a.id, { qty: kotu }, { now: day(10) }), /tam sayı/, String(kotu));
  }
  const v = p.packCrate(a.id, { qty: '2.500', person: 'Ayşe' }, { by: 'fabrika', now: day(10) });
  assert.deepEqual([v.state, v.packedQty, v.packedBy, v.packedPerson, v.countedQty, v.packDiff], ['paketlendi', 2500, 'fabrika', 'Ayşe', 3, 2497]);
  const d = p.packCrate(a.id, { qty: 3 }, { now: day(10, 1) });
  assert.deepEqual([d.packedQty, d.packDiff], [3, 0], 'duzeltme: yeniden girilir');
  assert.match(p.getWorkOrder(w.no, { now: NOW }).events.at(-1).detail, /K000001 · 3 adet \(önceki 2500\)/);
});

test('kasa iptal: nedenli, paketlenmis kasa iptal edilmez, numara yeniden verilmez, listelerden duser', () => {
  const { p, st } = kur();
  const w = uretimde(p);
  st.events.push(ev(day(9, 5)));
  const a = p.openCrate(w.no, {}, { now: day(9) });
  assert.throws(() => p.voidCrate(a.id, { reason: 'x' }), /en az 3/);
  const iptal = p.voidCrate(a.id, { reason: 'yanlis acildi' }, { by: 'fabrika', now: day(9, 1) });
  assert.deepEqual([iptal.state, iptal.voidReason, iptal.voidedBy], ['iptal', 'yanlis acildi', 'fabrika']);
  assert.throws(() => p.voidCrate(a.id, { reason: 'tekrar' }), (e) => e.code === 'bad-status');
  assert.throws(() => p.closeCrate(a.id, {}), (e) => e.code === 'bad-status');
  assert.throws(() => p.packCrate(a.id, { qty: 3 }), (e) => e.code === 'bad-status');

  const b = p.openCrate(w.no, {}, { now: day(9, 2) });
  assert.equal(b.cardNo, 'K000002', 'iptal edilen kartin numarasi yeniden kullanilmaz; iptal sonrasi yeni kasa acilabilir');
  p.closeCrate(b.id, {}, { now: day(9, 30) });
  p.packCrate(b.id, { qty: 3 }, { now: day(10) });
  assert.throws(() => p.voidCrate(b.id, { reason: 'paketlenmis' }), (e) => e.status === 409 && e.code === 'packed');
  assert.deepEqual(p.getWorkOrder(w.no, { now: NOW }).crates.items.map((c) => c.cardNo), ['K000002'], 'iptal edilen is emri kasalarinda gorunmez');
  assert.deepEqual(p.listCrates({ state: 'iptal' }, { now: NOW }).items.map((c) => c.cardNo), ['K000001']);
});

test('is emri toplamlari: sayilan, paketlenen, paketleme bekleyen, kasaya atanmayan (kasa acik degilken uretilen)', () => {
  const { p, st } = kur();
  const w = uretimde(p);
  // 07:30 ve 08:00 kasa yokken, 09:05/09:06 kasa 1'de, 09:45 kasa 2 (acik)
  st.events.push(ev(day(7, 30)), ev(day(8, 0)), ev(day(9, 5)), ev(day(9, 6)), ev(day(9, 45)));
  const a = p.openCrate(w.no, {}, { now: day(9) });
  p.closeCrate(a.id, {}, { now: day(9, 30) });
  p.packCrate(a.id, { qty: 2 }, { now: day(9, 40) });
  p.openCrate(w.no, {}, { now: day(9, 31) });
  const c = p.getWorkOrder(w.no, { now: day(10) }).crates;
  assert.deepEqual(c.totals, { count: 2, open: true, unpacked: 0, counted: 3, packed: 2, unassigned: 2 });
  assert.deepEqual(c.items.map((x) => [x.cardNo, x.state, x.countedQty]), [['K000001', 'paketlendi', 2], ['K000002', 'acik', 1]]);

  assert.deepEqual(p.listCrates({ state: 'acik' }, { now: day(10) }).items.map((x) => x.cardNo), ['K000002']);
  assert.deepEqual(p.listCrates({ state: 'paketlendi' }, { now: day(10) }).items.map((x) => x.cardNo), ['K000001']);
  assert.equal(p.listCrates({ state: 'kapali' }).total, 0);
  const o = p.shopOverview({ now: day(10) });
  assert.deepEqual([o.machines[0].active.crate.cardNo, o.machines[0].active.crateCount, o.packing.waiting], ['K000002', 2, 0]);
  p.closeCrate(c.items[1].id, {}, { now: day(10) });
  assert.equal(p.shopOverview({ now: day(10) }).packing.waiting, 1, 'kapanmis, adedi girilmemis kasa paketlemede bekler');
});

test('is emri bitince / iptal edilince acik kasa otomatik kapanir (bitis anina kadar sayilir)', () => {
  const { p, st } = kur();
  const w = uretimde(p);
  st.events.push(ev(day(9, 5)), ev(day(9, 20)), ev(day(9, 50)));
  const a = p.openCrate(w.no, {}, { now: day(9) });
  const bitti = p.finishWorkOrder(w.no, { endAt: day(9, 30) }, { now: NOW });
  const k = bitti.crates.items[0];
  assert.deepEqual([k.id, k.state, k.closedAt, k.countedQty, k.closedBy], [a.id, 'kapali', day(9, 30), 2, null], 'bitis saatine kadar: 09:50 sayilmaz');
  assert.match(bitti.events.find((e) => e.kind === 'kasa-kapandi').detail, /otomatik/);
  assert.throws(() => p.openCrate(w.no, {}, { now: NOW }), (e) => e.code === 'bad-status', 'biten is emrinde yeni kasa acilmaz');

  const w2 = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-03' }, { now: NOW });
  p.startWorkOrder(w2.no, { startAt: day(8) }, { now: NOW });
  const b = p.openCrate(w2.no, {}, { now: day(9) });
  const iptal = p.cancelWorkOrder(w2.no, { reason: 'musteri vazgecti', now: day(9, 10) });
  assert.deepEqual(iptal.crates.items.map((x) => [x.id, x.state]), [[b.id, 'kapali']]);
});

test('kart numarasi sirasi: yonetici tabani (K000100 den sonra), geriye alinamaz', () => {
  const { p } = kur();
  const w = uretimde(p);
  assert.deepEqual(p.setCrateSequence(99), { next: 100, nextCardNo: 'K000100' });
  assert.equal(p.openCrate(w.no, {}, { now: NOW }).cardNo, 'K000100');
  assert.throws(() => p.setCrateSequence(50), (e) => e.status === 409 && /K000100/.test(e.message));
  assert.throws(() => p.setCrateSequence('abc'), /tam sayı/);
  assert.throws(() => p.setCrateSequence(1_000_000), /tam sayı/);
});

test('HTTP: kasa ac / kapat / paketle / iptal / liste ve hata kodlari', async () => {
  const { p, st } = kur();
  st.live.set('CNC-01', canli(500));
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const w = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' })).json;
    assert.equal((await j(`/api/planning/work-orders/${w.no}/crates`, 'POST', {})).json.code, 'bad-status');
    await j(`/api/planning/work-orders/${w.no}/start`, 'POST', {});

    const ac = await j(`/api/planning/work-orders/${w.no}/crates`, 'POST', { person: 'Ayşe' });
    assert.equal(ac.status, 201);
    assert.equal(ac.json.cardNo, 'K000001');
    assert.equal((await j(`/api/planning/work-orders/${w.no}/crates`, 'POST', {})).json.code, 'crate-open');
    const id = ac.json.id;
    assert.equal((await j(`/api/planning/crates/${id}/pack`, 'POST', { qty: 5 })).json.code, 'crate-open');
    assert.equal((await j(`/api/planning/crates/${id}/close`, 'POST', {})).json.state, 'kapali');
    assert.equal((await j(`/api/planning/crates/${id}/pack`, 'POST', { qty: 'x' })).status, 400);
    const pk = await j(`/api/planning/crates/${id}/pack`, 'POST', { qty: 480, person: 'Veli' });
    assert.deepEqual([pk.status, pk.json.state, pk.json.packedQty], [200, 'paketlendi', 480]);
    assert.equal((await j(`/api/planning/crates/${id}/void`, 'POST', { reason: 'hata var' })).json.code, 'packed');

    const liste = (await j(`/api/planning/crates?woNo=${w.no}&state=paketlendi`)).json;
    assert.deepEqual([liste.total, liste.items[0].cardNo], [1, 'K000001']);
    assert.equal((await j('/api/planning/crates?state=bozuk')).json.total, 1, 'bilinmeyen durum suzgeci aktif sayilir');
    assert.equal((await j(`/api/planning/crates/${id}`)).json.stockCode, 'SR001.013');
    assert.equal((await j('/api/planning/crates/99999')).status, 404);
    assert.equal((await j('/api/planning/crates/99999/close', 'POST', {})).status, 404);
    assert.deepEqual((await j('/api/planning/crates/sequence', 'PUT', { last: 41 })).json, { next: 42, nextCardNo: 'K000042' });
    assert.equal((await j('/api/planning/crates/sequence', 'PUT', { last: 'x' })).status, 400);
    assert.equal((await j(`/api/planning/work-orders/${w.no}`)).json.crates.totals.packed, 480);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
