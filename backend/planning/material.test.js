/**
 * Hammadde ve sarfiyat (planlama D asamasi): kg = islenen adet (sayac) x brut agirlik, cubuk, beklenen talas, ihtiyac (planlanan + uretimdeki kalan),
 * hammadde bazinda toplamlar, Mikro sarfiyat fisi "elle girildi" takibi, Excel CSV, HTTP. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { consumptionOf, groupByMaterial, materialKey } from './material.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(10);
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;HM614.YU24.00;27;62,65;0,039;0,0078',
  '2026000002;05.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;;45;53;0,1065;0,036',
  '',
].join('\r\n');

function kur() {
  const st = { events: [] };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MAKINELER,
    productionEvents: (machineId, from, to) => st.events.filter((e) => e.machineId === machineId && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
const ev = (machineId, ts, qty = 1) => ({ machineId, ts, program: 'X', qty, partTotal: null, cycleSec: 24, gapMs: 0, suspect: false });
/** Bitmis is emri: baslangic/bitis ve uretilen adet (tek olay). */
function bitmis(p, st, { stock = 'SR001.013', machine = 'CNC-01', target = 100, start, end, qty, used = null, length = null }) {
  const w = p.createWorkOrder({ stockCode: stock, targetQty: target, machineId: machine, ...(length ? { lengthMm: length } : {}) }, { now: NOW });
  p.startWorkOrder(w.no, { startAt: start, fields: used ? { usedMaterial: used } : {} }, { now: NOW });
  st.events.push(ev(machine, start + 60_000, qty));
  return p.finishWorkOrder(w.no, { endAt: end }, { now: NOW });
}

test('hesap: kg = adet x brut, cubuk, beklenen talas; bilinmeyen null (0 degil); sifir adet bilinen sifir', () => {
  const w = { material: 'HM614.YU23.00', usedMaterial: null, altMaterial: 'HM614.YU24.00', grossKg: 0.039, netKg: 0.0078, lengthMm: 13 };
  const c = consumptionOf(w, 30);
  assert.deepEqual([c.kg, c.bars, c.netKg, c.scrapKg, c.material, c.qty], [1.17, 0.16, 0.234, 0.936, 'HM614.YU23.00', 30]);
  assert.deepEqual([consumptionOf(w, 0).kg, consumptionOf(w, 0).bars, consumptionOf(w, 0).scrapKg], [0, 0, 0], 'hic uretilmediyse kg 0 (biliniyor)');
  assert.equal(consumptionOf({ ...w, lengthMm: null }, 0).bars, null);
  const bilinmeyen = consumptionOf({ ...w, grossKg: null, netKg: null }, 30);
  assert.deepEqual([bilinmeyen.kg, bilinmeyen.scrapKg, bilinmeyen.netKg, bilinmeyen.grossKnown], [null, null, null, false]);
  assert.equal(consumptionOf(w, null).kg, null, 'adet bilinmiyorsa kg null');

  // gercek hammadde: planlidan farkli -> uyari; alternatifse beklenen sapma; ayni kod (buyuk/kucuk, Turkce harf) fark degil
  assert.deepEqual([consumptionOf({ ...w, usedMaterial: 'hm614.yu23.00' }, 1).differs, consumptionOf({ ...w, usedMaterial: 'hm614.yu23.00' }, 1).material], [false, 'hm614.yu23.00']);
  const alt = consumptionOf({ ...w, usedMaterial: 'HM614.YU24.00' }, 1);
  assert.deepEqual([alt.isAlt, alt.differs, alt.material], [true, false, 'HM614.YU24.00']);
  const farkli = consumptionOf({ ...w, usedMaterial: 'HM999.00' }, 1);
  assert.deepEqual([farkli.isAlt, farkli.differs], [false, true]);
  assert.equal(consumptionOf({ ...w, material: null, usedMaterial: '  ' }, 1).material, null);
  assert.equal(materialKey('Nİ002.001 '), materialKey('NI002.001'));
});

test('hammadde bazinda toplam: kg, cubuk, talas, bekleyen; bilinmeyenler toplama girmez ama sayilir; kg azalan', () => {
  const g = groupByMaterial([
    { material: 'HM-A', kg: 1.5, bars: 0.2, scrapKg: 0.3, qty: 10, pendingKg: 1.5 },
    { material: 'hm-a', kg: 2.25, bars: 0.1, scrapKg: 0.4, qty: 20, pendingKg: 0 },
    { material: 'HM-B', kg: 10, bars: null, scrapKg: null, qty: 5 },
    { material: 'HM-C', kg: null, bars: null, scrapKg: null, qty: 7 },
    { material: null, kg: 0.5, qty: 1 },
  ]);
  assert.deepEqual(g.map((x) => [x.material, x.orders, x.kg, x.bars, x.scrapKg, x.pendingKg, x.unknownKg, x.qty]), [
    ['HM-B', 1, 10, 0, 0, 0, 0, 5], ['HM-A', 2, 3.75, 0.3, 0.7, 1.5, 0, 30], ['— (hammadde yok)', 1, 0.5, 0, 0, 0, 0, 1], ['HM-C', 1, 0, 0, 0, 0, 1, 7],
  ]);
});

test('ihtiyac: planlanan (hedef) + uretimdeki (kalan) is emirleri, hammadde bazinda; agirligi olmayan ayri sayilir', () => {
  const { p, st } = kur();
  const c = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 40, machineId: 'CNC-01', lengthMm: 13 }, { now: NOW });
  p.startWorkOrder(c.no, { startAt: day(9) }, { now: NOW });
  st.events.push(ev('CNC-01', day(9, 30), 5));
  p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 200, machineId: 'CNC-03' }, { now: NOW });
  p.createWorkOrder({ stockCode: 'Nİ002.001', targetQty: 10, machineId: 'CNC-03', grossKg: null, netKg: null }, { now: NOW });
  bitmis(p, st, { start: day(7), end: day(8), qty: 3, machine: 'CNC-03' }); // bitmis: ihtiyaca girmez

  const n = p.materialNeed({ now: NOW });
  assert.equal(n.rows.length, 3);
  const a = n.byMaterial.find((x) => x.material === 'HM614.YU23.00');
  assert.deepEqual([a.orders, a.qty, a.kg], [2, 235, 9.165], '(40-5) + 200 adet x 0,039');
  assert.equal(n.rows.find((r) => r.status === 'uretimde').remaining, 35);
  assert.ok(n.totals.orders === 3 && n.totals.kg > 9.16);
});

test('sarfiyat: bitis tarih araligi, dondurulmus adet, hammadde bazinda toplam, uretimdekiler ayri', () => {
  const { p, st } = kur();
  bitmis(p, st, { machine: 'CNC-03', start: day(7, 0, 0, 11), end: day(8, 0, 0, 11), qty: 10 }); // E: dun, 0,39 kg (tezgahta zaman cakismasi olmasin diye ilk)
  bitmis(p, st, { start: day(7), end: day(9), qty: 30, used: 'hm614.yu23.00', length: 13 }); // A: 1,17 kg
  bitmis(p, st, { stock: 'Nİ002.001', machine: 'CNC-03', start: day(7), end: day(10), qty: 20, used: 'HM617.YU99.00' }); // B: 2,13 kg, planlidan farkli
  const c = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 40, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(c.no, { startAt: day(9, 30) }, { now: NOW });
  st.events.push(ev('CNC-01', day(9, 45), 5));

  const bugun = p.materialConsumption({ from: '2026-10-12', to: '2026-10-12', now: NOW });
  assert.deepEqual(bugun.rows.map((r) => [r.stockCode, r.produced, r.kg, r.material, r.differs]), [['SR001.013', 30, 1.17, 'hm614.yu23.00', false], ['Nİ002.001', 20, 2.13, 'HM617.YU99.00', true]]);
  assert.deepEqual(bugun.byMaterial.map((g) => [g.material, g.kg, g.pendingKg]), [['HM617.YU99.00', 2.13, 2.13], ['hm614.yu23.00', 1.17, 1.17]]);
  assert.deepEqual([bugun.totals.orders, bugun.totals.qty, bugun.totals.kg, bugun.totals.bars, bugun.totals.pendingOrders, bugun.totals.pendingKg, bugun.totals.differs], [2, 50, 3.3, 0.16, 2, 3.3, 1]);
  assert.equal(bugun.totals.scrapKg, 2.346, 'beklenen talas (brut - net): 30 x 0,0312 + 20 x 0,0705');
  assert.deepEqual(bugun.inProgress.map((r) => [r.no === c.no, r.produced, r.kg]), [[true, 5, 0.195]], 'uretimdekiler fise girmez, bilgi olarak ayri');

  const iki = p.materialConsumption({ from: '2026-10-11', to: '2026-10-12', now: NOW });
  assert.equal(iki.rows.length, 3);
  assert.equal(iki.byMaterial.find((g) => g.material === 'HM614.YU23.00' || g.material === 'hm614.yu23.00').kg, 1.56, 'ayni hammadde (kucuk/buyuk harf) tek satirda');
  // varsayilan aralik: bu ayin basindan bugune
  assert.equal(p.materialConsumption({ now: NOW }).from, '2026-10-01');

  assert.throws(() => p.materialConsumption({ from: 'abc', now: NOW }), /yyyy-aa-gg/);
  assert.throws(() => p.materialConsumption({ from: '2026-10-12', to: '2026-10-11', now: NOW }), /sonra olamaz/);
  assert.throws(() => p.materialConsumption({ from: '2024-01-01', to: '2026-10-12', now: NOW }), /400 gün/);
});

test('fis takibi: yalniz biten is emri, cift fis yok, kg varsayilan hesaplanan / tek is emrinde elle, toplu evrak no, geri al, gecmis', () => {
  const { p, st } = kur();
  const d = bitmis(p, st, { stock: 'Nİ002.001', machine: 'CNC-03', start: day(7, 0, 0, 11), end: day(8, 0, 0, 11), qty: 4 }); // dun (zaman cakismasi olmasin diye ilk)
  const a = bitmis(p, st, { start: day(7), end: day(9), qty: 30 });
  const b = bitmis(p, st, { stock: 'Nİ002.001', machine: 'CNC-03', start: day(7), end: day(10), qty: 20 });
  const c = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 40, machineId: 'CNC-01' }, { now: NOW });
  assert.throws(() => p.markFis({ orders: [c.no] }), (e) => e.code === 'bad-status');
  assert.throws(() => p.markFis({ orders: [] }), /1–200/);
  assert.throws(() => p.markFis({ orders: ['2026999999'] }), (e) => e.status === 404);
  assert.throws(() => p.markFis({ orders: [a.no, b.no], kg: 5 }), /tek iş emri/);

  const r = p.markFis({ orders: [a.no, b.no], docNo: 'SF-0042', note: 'ekim' }, { by: 'ofis', now: NOW });
  assert.deepEqual(r, { marked: 2, kg: 3.3 });
  const g = p.getWorkOrder(a.no, { now: NOW });
  assert.deepEqual([g.consumption.fis.status, g.consumption.fis.docNo, g.consumption.fis.kg, g.consumption.fis.by, g.consumption.kg], ['girildi', 'SF-0042', 1.17, 'ofis', 1.17]);
  assert.match(g.events.at(-1).detail, /1.17 kg · evrak SF-0042 · ekim/);
  assert.throws(() => p.markFis({ orders: [a.no] }), (e) => e.status === 409 && e.code === 'fis-exists' && /SF-0042/.test(e.message));

  assert.deepEqual(p.materialConsumption({ from: '2026-10-12', to: '2026-10-12', fis: 'bekleyen', now: NOW }).rows, []);
  assert.equal(p.materialConsumption({ from: '2026-10-12', to: '2026-10-12', fis: 'girildi', now: NOW }).rows.length, 2);
  assert.equal(p.materialConsumption({ from: '2026-10-12', to: '2026-10-12', now: NOW }).totals.pendingKg, 0);

  assert.deepEqual(p.clearFis({ orders: [b.no] }, { now: NOW }), { cleared: 1 });
  assert.throws(() => p.clearFis({ orders: [b.no] }), (e) => e.code === 'no-fis');
  // tek is emrinde Mikro'ya yazilan fiili kg elle girilebilir
  assert.deepEqual(p.markFis({ orders: [b.no], kg: '2,2', docNo: 'SF-0043' }, { now: NOW }), { marked: 1, kg: 2.2 });
  assert.equal(p.getWorkOrder(b.no, { now: NOW }).consumption.fis.kg, 2.2);

  // brut agirligi olmayan is emri: hesaplanamaz -> kg elle girilmeden fis kesilmez
  p.updateWorkOrder(d.no, { grossKg: 0.1065 }, { now: NOW }); // once agirlik var
  p.db.updateWorkOrder(d.no, { gross_kg: null }, { now: NOW }); // sonra silindi (eski/eksik kayit)
  assert.throws(() => p.markFis({ orders: [d.no] }), (e) => e.code === 'no-weight');
  assert.equal(p.markFis({ orders: [d.no], kg: 0.4 }, { now: NOW }).kg, 0.4);
});

test('CSV: Excel uyumlu (BOM, sep=;, ondalik virgul), is emri bazli ve hammadde bazli', () => {
  const { p, st } = kur();
  bitmis(p, st, { start: day(7), end: day(9), qty: 30, used: 'HM614.YU23.00' });
  bitmis(p, st, { stock: 'Nİ002.001', machine: 'CNC-03', start: day(7), end: day(10), qty: 20 });
  p.markFis({ orders: [p.listWorkOrders({ status: 'bitti' }).items.find((w) => w.stockCode === 'SR001.013').no], docNo: 'SF-1' }, { now: NOW });

  const is = p.materialCsv({ from: '2026-10-12', to: '2026-10-12', now: NOW }, 'is-emri');
  assert.equal(is.filename, 'sarfiyat-is-emirleri-2026-10-12_2026-10-12.csv');
  const lines = is.text.split('\r\n');
  assert.equal(lines[0], '﻿sep=;');
  assert.match(lines[1], /^İş emri;Bitiş;Tezgah;Stok kodu;Ürün;Hammadde \(kullanılan\);/);
  const a = lines.find((l) => l.includes('SR001.013'));
  assert.match(a, /;30;39;1,17;/, 'brut gram (39) ve sarfiyat kg ondalik virgulle');
  assert.match(a, /;girildi;SF-1;1,17$/);
  assert.match(lines.find((l) => l.includes('Nİ002.001')), /;bekliyor;;$/);

  const h = p.materialCsv({ from: '2026-10-12', to: '2026-10-12', now: NOW }, 'hammadde');
  assert.equal(h.filename, 'hammadde-sarfiyat-2026-10-12_2026-10-12.csv');
  assert.match(h.text, /Hammadde;İş emri;Adet;Sarfiyat \(kg\);Çubuk \(BOY\);Beklenen talaş \(kg\);Fişi bekleyen \(kg\)/);
  assert.match(h.text, /HM617.YU18.00;1;20;2,13;/);
});

test('HTTP: ihtiyac, sarfiyat (json ve csv), fis isaretle ve geri al', async () => {
  const { p, st } = kur();
  const w = bitmis(p, st, { start: day(7), end: day(9), qty: 30 });
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  };
  try {
    assert.equal((await j('/api/planning/material/need')).status, 200);
    const q = '?from=2026-10-12&to=2026-10-12';
    const c = await j(`/api/planning/material/consumption${q}`);
    assert.equal(c.json.rows.length, 1);
    assert.equal(c.json.totals.pendingKg, 1.17);
    assert.equal((await j('/api/planning/material/consumption?from=bozuk')).status, 400);
    assert.equal((await j(`/api/planning/material/consumption${q}&fis=bozuk`)).json.fis, 'tumu', 'bilinmeyen filtre tumu sayilir');

    const csv = await fetch(`${base}/api/planning/material/consumption.csv${q}&view=hammadde`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /hammadde-sarfiyat-2026-10-12_2026-10-12\.csv/);
    assert.match(await csv.text(), /HM614.YU23.00;1;30;1,17;/);

    assert.equal((await j('/api/planning/material/fis', 'POST', { orders: [w.no], docNo: 'SF-9' })).json.kg, 1.17);
    assert.equal((await j('/api/planning/material/fis', 'POST', { orders: [w.no] })).json.code, 'fis-exists');
    assert.equal((await j('/api/planning/material/fis', 'POST', { orders: 'x' })).status, 400);
    assert.equal((await j('/api/planning/material/fis/undo', 'POST', { orders: [w.no] })).json.cleared, 1);
    assert.equal((await j(`/api/planning/work-orders/${w.no}`)).json.consumption.fis.status, 'bekliyor');
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
