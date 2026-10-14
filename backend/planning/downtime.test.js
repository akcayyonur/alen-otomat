/**
 * Duruslar (planlama T asamasi): olculmus duruslar (telemetri durum araliklarindan), duruse baglanan nedenler, fabrika PC'si ana ekrani,
 * kod listesi ve HTTP uclari (operator alan siniri dahil). TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { buildStops, attachReasons, uncoveredParts } from './downtime.js';
import { validateDowntimeConfig, loadDowntimeCodes } from '../../shared/downtime-codes.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(10);
const MIN = 60_000;
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];

const KODLAR = {
  groups: [{ id: 'degisim', label: 'Değişim ve ayar' }, { id: 'bekleme', label: 'Bekleme ve yok' }],
  codes: [
    { code: 'D1', name: 'Ürün değişikliği', group: 'degisim', kind: 'D', frequent: true },
    { code: 'D4', name: 'Çubuk değişimi', group: 'degisim', kind: 'D', frequent: true },
    { code: 'D5', name: 'Ayarcı bekleme', group: 'bekleme', kind: 'D' },
  ],
};

const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

/** CNC-01 durum araliklari: 08:00-08:40 bir durus (bosta + alarm), 09:30-09:32 esik alti, 09:44-10:00 suren durus (NO_DATA once bolar). */
const SPANS_01 = [
  ['RUNNING', day(6), day(8)], ['IDLE', day(8), day(8, 30)], ['ALARM', day(8, 30), day(8, 40)], ['RUNNING', day(8, 40), day(9, 30)],
  ['IDLE', day(9, 30), day(9, 32)], ['RUNNING', day(9, 32), day(9, 40)], ['NO_DATA', day(9, 40), day(9, 44)], ['IDLE', day(9, 44), NOW],
].map(([state, startedAt, endedAt]) => ({ machineId: 'CNC-01', state, startedAt, endedAt }));

function kur(spans = SPANS_01) {
  const st = { spans: [...spans], live: new Map() };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MAKINELER,
    // db.spans gibi: pencereye kirpilmis
    spans: (id, from, to) => st.spans.filter((s) => s.machineId === id && s.startedAt < to && s.endedAt > from)
      .map((s) => ({ state: s.state, startedAt: Math.max(s.startedAt, from), endedAt: Math.min(s.endedAt, to), reason: null })),
    liveMachine: (id) => st.live.get(id) ?? null,
    downtimeConfig: KODLAR,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}

/* ------------------------------------------------------------ saf islevler */

test('duruslar: bosta+alarm birlesir, NO_DATA ve RUNNING boler, esik alti elenir, suren durus isaretlenir', () => {
  const stops = buildStops(SPANS_01.map(({ machineId, ...s }) => s), { minMs: 3 * MIN, now: NOW });
  assert.deepEqual(stops.map((s) => [s.from, s.to, s.ongoing, s.dominant]), [[day(8), day(8, 40), false, 'IDLE'], [day(9, 44), NOW, true, 'IDLE']]);
  assert.deepEqual(stops[0].states, { IDLE: 30 * MIN, ALARM: 10 * MIN });
  assert.equal(stops[0].durationMs, 40 * MIN);
  // veri yok durus degil: yalniz NO_DATA olan aralik hic durus uretmez
  assert.deepEqual(buildStops([{ state: 'NO_DATA', startedAt: day(1), endedAt: day(5) }], { minMs: MIN, now: NOW }), []);
  // esik: 2 dk durus 3 dk esikte yok, 1 dk esikte var
  assert.equal(buildStops([{ state: 'IDLE', startedAt: day(1), endedAt: day(1, 2) }], { minMs: 3 * MIN, now: NOW }).length, 0);
  assert.equal(buildStops([{ state: 'IDLE', startedAt: day(1), endedAt: day(1, 2) }], { minMs: MIN, now: NOW }).length, 1);
});

test('nedenler: kapsanmayan parcalar, cevaplandi esigi (60 sn hosgoru)', () => {
  assert.deepEqual(uncoveredParts(0, 100, []), [{ from: 0, to: 100 }]);
  assert.deepEqual(uncoveredParts(0, 100, [{ from: 20, to: 40 }, { from: 60, to: 80 }]), [{ from: 0, to: 20 }, { from: 40, to: 60 }, { from: 80, to: 100 }]);
  assert.deepEqual(uncoveredParts(0, 100, [{ from: -10, to: 120 }]), []);
  const stop = { from: day(8), to: day(8, 40), durationMs: 40 * MIN, ongoing: false, states: { IDLE: 40 * MIN }, dominant: 'IDLE' };
  const yari = attachReasons([stop], [{ id: 1, from: day(8), to: day(8, 30) }])[0];
  assert.deepEqual([yari.reasonMs, yari.uncoveredMs, yari.answered], [30 * MIN, 10 * MIN, false]);
  const tam = attachReasons([stop], [{ id: 1, from: day(8), to: day(8, 39, 30) }])[0];
  assert.equal(tam.answered, true, '30 sn artik cevaplandi sayilir');
  assert.equal(attachReasons([stop], [{ id: 9, from: day(9), to: day(9, 10) }])[0].reasons.length, 0, 'baska zamanin nedeni baglanmaz');
});

/* ------------------------------------------------------------- planlama */

test('olculmus duruslar: en yeni uste, nedenle birlikte; kod listesi ve gruplar', () => {
  const { p } = kur();
  const stops = p.machineStops('CNC-01', { hours: 24, now: NOW });
  assert.deepEqual(stops.map((s) => [s.from, s.ongoing, s.answered]), [[day(9, 44), true, false], [day(8), false, false]]);
  assert.deepEqual(p.machineStops('CNC-03', { now: NOW }), [], 'durusu olmayan tezgah');
  assert.throws(() => p.machineStops('CNC-99', { now: NOW }), /Bilinmeyen tezgah/);

  const k = p.downtimeCodes();
  assert.deepEqual(k.codes.map((c) => c.code), ['D1', 'D4', 'D5']);
  assert.equal(k.minStopMinutes, 3);
  assert.deepEqual(k.groups.map((g) => g.id), ['degisim', 'bekleme']);
});

test('neden ekle: durusa baglanir, cakisma ve gecersiz aralik reddedilir, durusa kirpilir, is emrine baglanir, kaldirilir', () => {
  const { p } = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(w.no, { startAt: day(7) }, { now: NOW });

  // 60 sn hosgoru: durustan biraz once baslayan aralik durusa kirpilir
  const a = p.addDowntimeReason({ machineId: 'CNC-01', from: day(7, 59, 30), to: day(8, 30), code: 'D4', person: 'Ayşe', note: 'çubuk bitti' }, { by: 'fabrika', now: NOW });
  assert.deepEqual([a.from, a.to, a.code, a.name, a.woNo, a.person, a.enteredBy], [day(8), day(8, 30), 'D4', 'Çubuk değişimi', w.no, 'Ayşe', 'fabrika']);
  let stop = p.machineStops('CNC-01', { now: NOW }).find((s) => s.from === day(8));
  assert.deepEqual([stop.answered, stop.uncoveredMs, stop.reasons.length], [false, 10 * MIN, 1]);

  assert.throws(() => p.addDowntimeReason({ machineId: 'CNC-01', from: day(8, 20), to: day(8, 35), code: 'D1' }, { now: NOW }), (e) => e.status === 409 && e.code === 'overlap' && /D4/.test(e.message));
  p.addDowntimeReason({ machineId: 'CNC-01', from: day(8, 30), to: day(8, 40), code: 'D5' }, { now: NOW });
  stop = p.machineStops('CNC-01', { now: NOW }).find((s) => s.from === day(8));
  assert.equal(stop.answered, true);
  assert.deepEqual(stop.reasons.map((r) => r.code), ['D4', 'D5'], 'bir durus birden cok nedene bolunur');

  const gecersiz = (o, re) => assert.throws(() => p.addDowntimeReason({ machineId: 'CNC-01', code: 'D1', ...o }, { now: NOW }), re);
  gecersiz({ from: day(8, 45), to: day(8, 50) }, (e) => e.code === 'no-stop');
  gecersiz({ from: day(9, 30), to: day(9, 32) }, (e) => e.code === 'no-stop'); // esik alti
  gecersiz({ from: day(9, 40), to: day(9, 44) }, (e) => e.code === 'no-stop'); // veri yok
  gecersiz({ from: day(9, 50), to: day(10, 5) }, /gelecekte/);
  gecersiz({ from: day(9, 50), to: day(9, 40) }, /sonra olmalı/);
  gecersiz({ from: 'dun', to: day(9, 40) }, /geçerli bir tarih/);
  gecersiz({ from: day(2, 0, 0, 3), to: day(2, 30, 0, 3) }, /7 gün/);
  assert.throws(() => p.addDowntimeReason({ machineId: 'CNC-01', from: day(9, 50), to: day(9, 55), code: 'D99' }, { now: NOW }), /Bilinmeyen duruş nedeni/);
  assert.throws(() => p.addDowntimeReason({ machineId: 'CNC-99', from: day(9, 50), to: day(9, 55), code: 'D1' }, { now: NOW }), /Bilinmeyen tezgah/);

  assert.deepEqual(p.removeDowntimeReason(a.id, { by: 'fabrika', now: NOW }), { ok: true });
  assert.equal(p.machineStops('CNC-01', { now: NOW }).find((s) => s.from === day(8)).reasons.length, 1, 'kaldirilan neden duruslarda gorunmez');
  assert.throws(() => p.removeDowntimeReason(a.id), (e) => e.status === 404);
  assert.equal(p.db.getDowntimeReason(a.id).deletedBy, 'fabrika', 'yumusak silme: kim sildi kayitli');
});

test('fabrika ana ekrani: tezgah basina canli durum, uretimdeki is emri, bekleyenler, nedeni sorulmamis duruslar', () => {
  const { p, st } = kur();
  st.live.set('CNC-01', { connected: true, state: 'IDLE', program: '140100187', partTotal: 5000 });
  const bekleyen = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-03' }, { now: NOW });
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(w.no, { startAt: day(7) }, { now: NOW });

  const o = p.shopOverview({ now: NOW });
  assert.equal(o.minStopMinutes, 3);
  const c1 = o.machines.find((m) => m.id === 'CNC-01');
  assert.deepEqual(c1.live, { connected: true, state: 'IDLE', program: '140100187' }, 'partTotal gibi ic alanlar disari cikmaz');
  assert.equal(c1.active.no, w.no);
  assert.equal(c1.active.targetQty, 20);
  assert.deepEqual(c1.stops, { pending: 2, pendingMs: 56 * MIN, ongoing: day(9, 44) });
  assert.deepEqual(c1.planned, []);
  const c3 = o.machines.find((m) => m.id === 'CNC-03');
  assert.equal(c3.active, null);
  assert.equal(c3.live, null);
  assert.deepEqual(c3.planned.map((x) => x.no), [bekleyen.no]);
  assert.deepEqual(c3.stops, { pending: 0, pendingMs: 0, ongoing: null });

  p.addDowntimeReason({ machineId: 'CNC-01', from: day(8), to: day(8, 40), code: 'D1' }, { now: NOW });
  assert.equal(p.shopOverview({ now: NOW }).machines[0].stops.pending, 1, 'cevaplanan durus bekleyenden duser');
});

test('kod listesi: yeniden esitlemede kaldirilan kod pasiflesir (eski nedenler bagli kalir); dosya dogrulamasi', () => {
  const { p } = kur();
  p.addDowntimeReason({ machineId: 'CNC-01', from: day(8), to: day(8, 30), code: 'D5' }, { now: NOW });
  p.db.syncDowntimeCodes(KODLAR.codes.filter((c) => c.code !== 'D5'));
  assert.deepEqual(p.downtimeCodes().codes.map((c) => c.code), ['D1', 'D4']);
  assert.throws(() => p.addDowntimeReason({ machineId: 'CNC-01', from: day(8, 30), to: day(8, 40), code: 'D5' }, { now: NOW }), /Bilinmeyen duruş nedeni/);
  assert.equal(p.machineStops('CNC-01', { now: NOW }).find((s) => s.from === day(8)).reasons[0].name, 'Ayarcı bekleme', 'pasif kodun adi eski kayitta korunur');

  const gercek = loadDowntimeCodes();
  assert.equal(gercek.codes.filter((c) => c.kind === 'Z').length, 4);
  assert.ok(gercek.codes.some((c) => c.code === 'D46' && c.name === 'Diğer'));
  assert.ok(!gercek.codes.some((c) => c.code === 'D21' || c.code === 'D22'), 'Excel listesinde D21/D22 yok');
  const kotu = (mut) => validateDowntimeConfig(mut(structuredClone(KODLAR)));
  assert.throws(() => kotu((c) => { c.codes.push({ ...c.codes[0] }); return c; }), /tekrarı/);
  assert.throws(() => kotu((c) => { c.codes[0].group = 'yok'; return c; }), /bilinmeyen grupta/);
  assert.throws(() => kotu((c) => { c.codes[0].kind = 'Z'; return c; }), /uyuşmuyor/);
  assert.throws(() => kotu((c) => { c.codes[0].code = 'X1'; return c; }), /geçersiz kod/);
});

/* -------------------------------------------------------------------- HTTP */

test('HTTP: kodlar, ana ekran, duruslar, neden ekle/kaldir; operator is emri baslatirken yalniz kendi alanlarini yazabilir', async () => {
  const { p } = kur([]) // gercek saatle calisan uclar: sentetik durus yok;
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    const rol = req.headers['x-test-rol'];
    if (rol) req.user = { username: 'fabrika', role: rol };
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj, headers = {}) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json', ...headers }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    assert.equal((await j('/api/planning/downtime-codes')).json.codes.length, 3);
    assert.equal((await j('/api/planning/shop/overview')).json.machines.length, 2);
    assert.equal((await j('/api/planning/shop/stops?machine=CNC-99')).status, 400);
    assert.deepEqual((await j('/api/planning/shop/stops?machine=CNC-01&hours=24')).json.stops, []);
    assert.equal((await j('/api/planning/shop/downtime-reasons', 'POST', { machineId: 'CNC-01', from: Date.now() - 60 * MIN, to: Date.now() - 50 * MIN, code: 'D1' })).json.code, 'no-stop');
    assert.equal((await j('/api/planning/shop/downtime-reasons/99999', 'DELETE')).status, 404);

    const w = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' })).json;
    const op = { 'x-test-rol': 'operator' };
    const yasak = await j(`/api/planning/work-orders/${w.no}/start`, 'POST', { fields: { targetQty: 5 } }, op);
    assert.equal(yasak.status, 403);
    assert.match(yasak.json.error, /targetQty/);
    assert.equal((await j(`/api/planning/work-orders/${w.no}`)).json.status, 'planlandi', 'reddedilen istek durumu degistirmez');
    const ok = await j(`/api/planning/work-orders/${w.no}/start`, 'POST', { person: 'Ayşe', fields: { gkkReportNo: '26-1', usedMaterial: 'HM614.YU23.00' } }, op);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.gkkReportNo, '26-1');
    // yonetici (ya da giris kapali) hedef adedi de yazabilir
    const w2 = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-03' })).json;
    assert.equal((await j(`/api/planning/work-orders/${w2.no}/start`, 'POST', { fields: { targetQty: 30 } }, { 'x-test-rol': 'admin' })).json.targetQty, 30);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
