/**
 * Olcu kontrolu (EYS.FR.005): sutun (30 dk) yuvarlama ve formdaki konum (gunduz 07:30-19:00, gece 19:30-07:00), olcu plani dogrulamasi,
 * tolerans degerlendirmesi, saatlik olcum kaydi (guncelleme / silme / kontrol satirlari), plan kopyalama, olcumlerin urun tanitim kartina
 * (kasanin zaman araligina) baglanmasi ve HTTP. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { slotOf, slotPosition, parseValue, normalizePlan, evaluate, limits } from './measure.js';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const at = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = at(10, 5);

/* ------------------------------------------------------------------ saf hesaplar */

test('sutun: en yakin yarim saate yuvarlanir (yerel saat), gece yarisini asar', () => {
  const k = (...a) => new Date(slotOf(at(...a))).toLocaleString('tr-TR', { hour12: false });
  assert.equal(slotOf(at(10, 12)), at(10, 0));
  assert.equal(slotOf(at(10, 20)), at(10, 30));
  assert.equal(slotOf(at(10, 15)), at(10, 30), 'tam ortada yukari');
  assert.equal(slotOf(at(10, 14, 59)), at(10, 0));
  assert.equal(slotOf(at(23, 50)), at(0, 0, 0, 13), '23:50 -> ertesi gun 00:00');
  assert.match(k(7, 29), /07:30:00$/);
});

test('formdaki konum: gunduz 0-23 (07:30 ... 19:00), gece 24-47 (19:30 ... ertesi 07:00); gece blogu BASLADIGI gunun formundadir', () => {
  const p = (...a) => { const x = slotPosition(at(...a)); return `${x.date} ${x.index} ${x.block} ${x.label}`; };
  assert.equal(p(7, 30), '2026-10-12 0 gunduz 07:30');
  assert.equal(p(8, 0), '2026-10-12 1 gunduz 08:00');
  assert.equal(p(19, 0), '2026-10-12 23 gunduz 19:00');
  assert.equal(p(19, 30), '2026-10-12 24 gece 19:30');
  assert.equal(p(23, 30), '2026-10-12 32 gece 23:30');
  assert.equal(p(0, 0, 0, 13), '2026-10-12 33 gece 00:00', '13 Ekim 00:00 hala 12 Ekim formunun gecesi');
  assert.equal(p(6, 30, 0, 13), '2026-10-12 46 gece 06:30');
  assert.equal(p(7, 0, 0, 13), '2026-10-12 47 gece 07:00', 'gece bloğunun son sutunu');
  assert.equal(p(7, 30, 0, 13), '2026-10-13 0 gunduz 07:30', 'yeni form');
  // ay sinirinda
  assert.equal(slotPosition(new Date(2026, 10, 1, 3, 0).getTime()).date, '2026-10-31');
});

test('deger ayristirma: ondalik virgul/nokta, bos = null, gecersiz = NaN', () => {
  assert.equal(parseValue('34,13'), 34.13);
  assert.equal(parseValue(' 34.13 '), 34.13);
  assert.equal(parseValue('-0,1'), -0.1);
  assert.equal(parseValue(14), 14);
  assert.equal(parseValue(''), null);
  assert.equal(parseValue(null), null);
  assert.equal(parseValue('  '), null);
  for (const bad of ['abc', '34,1,3', '1e5', '--1', '34 mm', NaN, Infinity]) assert.ok(Number.isNaN(parseValue(bad)), String(bad));
});

test('olcu plani: satir sayisi, ad zorunlu, sapma icin nominal, alt <= ust', () => {
  assert.deepEqual(normalizePlan([{ label: 'Ø34,2', nominal: '34,2', lower: '-0,1', upper: '0' }, { label: '14' }]), [
    { label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 },
    { label: '14', nominal: null, lower: null, upper: null },
  ]);
  assert.deepEqual(normalizePlan([]), []);
  assert.throws(() => normalizePlan('x'), /liste/);
  assert.throws(() => normalizePlan(Array.from({ length: 11 }, (_, i) => ({ label: `a${i}` }))), /En fazla 10/);
  assert.throws(() => normalizePlan([{ label: '' }]), /ölçü adı gerekli/);
  assert.throws(() => normalizePlan([{ label: 'x'.repeat(41) }]), /40 karakter/);
  assert.throws(() => normalizePlan([{ label: 'a', lower: -0.1 }]), /nominal/);
  assert.throws(() => normalizePlan([{ label: 'a', nominal: 10, lower: 0.1, upper: 0 }]), /eksi işaretiyle/);
  assert.throws(() => normalizePlan([{ label: 'a', nominal: 'abc' }]), /sayı olmalı/);
});

test('tolerans: nominal + sapma araligi; yalniz nominal ya da sapmasiz satir degerlendirilmez', () => {
  const r = { label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 };
  assert.equal(evaluate(r, 34.13), 'ok');
  assert.equal(evaluate(r, 34.1), 'ok', 'sinirda');
  assert.equal(evaluate(r, 34.2), 'ok', 'ust sinirda');
  assert.equal(evaluate(r, 34.09), 'dusuk');
  assert.equal(evaluate(r, 34.21), 'yuksek');
  assert.equal(evaluate({ label: 'a', nominal: 14, lower: null, upper: null }, 99), null);
  assert.equal(evaluate({ label: 'a', nominal: null, lower: null, upper: null }, 99), null);
  assert.equal(evaluate({ label: 'a', nominal: 14, lower: -0.05, upper: null }, 20), 'ok', 'tek yonlu sinir');
  assert.equal(evaluate(r, null), null);
  const l = limits(r);
  assert.ok(Math.abs(l.min - 34.1) < 1e-9 && Math.abs(l.max - 34.2) < 1e-9);
  assert.deepEqual(limits({ label: 'a', nominal: null }), { min: null, max: null });
});

/* ------------------------------------------------------------------ is emri entegrasyonu */

const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');
function kur() {
  const st = { events: [], live: new Map() };
  const p = new Planning({
    dbFile: ':memory:', listMachines: () => MAKINELER,
    productionEvents: (m, from, to) => st.events.filter((e) => e.machineId === m && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
    liveMachine: (id) => st.live.get(id) ?? null,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
const PLAN = [
  { label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 },
  { label: 'Ø30,8', nominal: 30.8, lower: -0.05, upper: 0.05 },
  { label: '14' },
];
function uretimde(p, o = {}) {
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01', ...o }, { now: at(7) });
  return p.startWorkOrder(w.no, { startAt: at(7) }, { now: at(7) });
}

test('plan tanimlanmadan olcum girilmez; plan kaydedilir ve gecmise yazilir', () => {
  const { p } = kur();
  const w = uretimde(p);
  assert.deepEqual(p.getWorkOrder(w.no, { now: NOW }).measurePlan, []);
  assert.throws(() => p.saveMeasurements(w.no, { values: { 1: '34,13' } }, { now: NOW }), (e) => e.status === 409 && e.code === 'no-plan');
  const m = p.setMeasurePlan(w.no, PLAN, { by: 'ayse', now: NOW });
  assert.deepEqual(m.plan.map((r) => [r.label, r.nominal, r.min, r.max].map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)))[0], ['Ø34,2', 34.2, 34.1, 34.2]);
  assert.equal(m.plan.length, 3);
  assert.match(p.getWorkOrder(w.no, { now: NOW }).events.find((e) => e.kind === 'olcu-plani').detail, /3 ölçü: Ø34,2, Ø30,8, 14/);
  assert.throws(() => p.setMeasurePlan(w.no, [{ label: '' }]), /ölçü adı/);
});

test('olcum kaydi: sutuna yuvarlanir, ayni sutun GUNCELLENIR, bos deger siler, kontrol satirlari, tolerans disi uyari', () => {
  const { p } = kur();
  const w = uretimde(p);
  p.setMeasurePlan(w.no, PLAN, { now: NOW });

  const a = p.saveMeasurements(w.no, { values: { 1: '34,13', 2: '30,77', 3: '14' }, checks: { gorsel: true, gecer: true, gecmez: true }, person: 'Ayşe' }, { by: 'fabrika', now: at(10, 12) });
  assert.equal(a.saved.slot, at(10, 0), '10:12 -> 10:00 sutunu');
  assert.deepEqual([a.saved.values[1].value, a.saved.values[1].status, a.saved.values[3].status], [34.13, 'ok', null]);
  assert.deepEqual(a.saved.checks, { gorsel: true, gecer: true, gecmez: true });
  assert.deepEqual([a.saved.by, a.saved.person], ['fabrika', 'Ayşe']);
  assert.deepEqual(a.warnings, []);

  // tolerans disi + uygun degil kontrol: uyari (makine durdurulur)
  const b = p.saveMeasurements(w.no, { slot: at(10, 0), values: { 1: '34,31' }, checks: { gecmez: false } }, { by: 'fabrika', now: at(10, 20) });
  assert.equal(b.saved.slot, at(10, 0), 'ayni sutun');
  assert.equal(b.saved.values[1].value, 34.31, 'guncellendi');
  assert.equal(b.saved.values[1].status, 'yuksek');
  assert.deepEqual(b.saved.outOfTol, [1]);
  assert.equal(b.saved.checks.gecmez, false);
  assert.equal(b.saved.values[2].value, 30.77, 'dokunulmayan satir korunur');
  assert.equal(b.warnings.length, 2);
  assert.match(b.warnings[0], /1\. ölçü \(Ø34,2\): 34,31 tolerans dışı \(yüksek\)/);
  assert.match(b.warnings[1], /Geçmez Mastarlar: uygun değil/);

  // bos deger siler, kontrol null siler
  const c = p.saveMeasurements(w.no, { slot: at(10, 0), values: { 2: '' }, checks: { gorsel: null } }, { now: at(10, 25) });
  assert.equal(c.saved.values[2], undefined);
  assert.equal(c.saved.checks.gorsel, null);
  assert.equal(c.slots.length, 1);

  // ikinci sutun
  p.saveMeasurements(w.no, { values: { 1: '34,12' } }, { now: at(10, 40) });
  assert.deepEqual(p.getMeasurements(w.no, { now: at(10, 41) }).slots.map((s) => s.position.label), ['10:00', '10:30']);
});

test('olcum kaydi: dogrulamalar (satir, sayi, bos kayit, zaman, durum)', () => {
  const { p } = kur();
  const w = uretimde(p);
  p.setMeasurePlan(w.no, PLAN, { now: NOW });
  const kaydet = (i, now = NOW) => p.saveMeasurements(w.no, i, { now });
  assert.throws(() => kaydet({}), /Kaydedilecek/);
  assert.throws(() => kaydet({ values: { 4: '1' } }), /1 ile 3 arası/);
  assert.throws(() => kaydet({ values: { 0: '1' } }), /geçersiz/);
  assert.throws(() => kaydet({ values: { x: '1' } }), /geçersiz/);
  assert.throws(() => kaydet({ values: { 1: 'abc' } }), /sayı olmalı/);
  assert.throws(() => kaydet({ checks: { baska: true } }), /Kontrol satırı geçersiz/);
  assert.throws(() => kaydet({ checks: { gorsel: 'evet' } }), /uygun/);
  assert.throws(() => kaydet({ values: { 1: '34' }, slot: NOW + 3_600_000 }), /gelecekte/);
  assert.throws(() => kaydet({ values: { 1: '34' }, slot: NOW - 80 * 3_600_000 }), /72 saat/);
  assert.throws(() => kaydet({ values: { 1: '34' }, slot: 'x' }), /geçersiz/);
  assert.equal(p.getMeasurements(w.no, { now: NOW }).slots.length, 0, 'hatali istekler kayit olusturmadi');

  const plan = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-01' }, { now: NOW });
  p.setMeasurePlan(plan.no, PLAN, { now: NOW });
  assert.throws(() => p.saveMeasurements(plan.no, { values: { 1: '34' } }, { now: NOW }), (e) => e.code === 'bad-status', 'baslamamis is emrinde olcum girilmez');
  const x = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 5, machineId: 'CNC-01' }, { now: NOW });
  p.cancelWorkOrder(x.no, { reason: 'deneme' });
  assert.throws(() => p.setMeasurePlan(x.no, PLAN), (e) => e.code === 'cancelled');
});

test('plan satirlari: olcum kaydi olan satir silinemez (yeniden adlandirilabilir); ayni urunun yeni is emri plani KOPYALAR', () => {
  const { p } = kur();
  const w = uretimde(p);
  p.setMeasurePlan(w.no, PLAN, { now: NOW });
  p.saveMeasurements(w.no, { values: { 3: '14,01' } }, { now: NOW });
  assert.throws(() => p.setMeasurePlan(w.no, PLAN.slice(0, 2)), (e) => e.status === 409 && e.code === 'rows-in-use');
  const yeniAd = [...PLAN.slice(0, 2), { label: 'Boy 14' }];
  assert.equal(p.setMeasurePlan(w.no, yeniAd, { now: NOW }).plan[2].label, 'Boy 14');

  // ayni urun: yeni is emri plani otomatik alir
  const w2 = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 50 }, { now: NOW });
  assert.deepEqual(w2.measurePlan.map((r) => r.label), ['Ø34,2', 'Ø30,8', 'Boy 14']);
  assert.equal(w2.measurePlan[0].lower, -0.1);
  // eski is emrinin plani sonradan degisse yeni is emri etkilenmez
  p.setMeasurePlan(w.no, [...yeniAd, { label: 'ek olcu' }], { now: NOW + 1 });
  assert.equal(p.getWorkOrder(w2.no, { now: NOW }).measurePlan.length, 3);
  // sonraki is emri EN SON planli is emrinin planini alir
  assert.equal(p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 5 }, { now: NOW + 2000 }).measurePlan.length, 4);
});

test('olcumler urun tanitim kartina baglanir: kart basilmadan "bekleyen", basilinca kartin foyunda; sonraki olcum sonraki kartin', () => {
  const { p, st } = kur();
  st.live.set('CNC-01', { connected: true, state: 'RUNNING', program: 'X', partTotal: 100 });
  const w = uretimde(p);
  p.setMeasurePlan(w.no, PLAN, { now: at(7, 5) });
  p.saveMeasurements(w.no, { values: { 1: '34,13' }, checks: { gorsel: true } }, { now: at(8, 2) });
  p.saveMeasurements(w.no, { values: { 1: '34,12' } }, { now: at(9, 1) });
  let m = p.getMeasurements(w.no, { now: at(9, 5) });
  assert.equal(m.pending, 2);
  assert.ok(m.slots.every((s) => s.card === null));

  // kasa doldu: 09:30'da ilk kart basilir
  const k1 = p.issueCard(w.no, { person: 'Ayşe' }, { now: at(9, 30) });
  p.saveMeasurements(w.no, { values: { 1: '34,11' } }, { now: at(10, 1) }); // kart basildiktan sonra: bir sonraki kartin
  m = p.getMeasurements(w.no, { now: at(10, 5) });
  assert.deepEqual(m.slots.map((s) => [s.position.label, s.card?.cardNo ?? null]), [['08:00', 'K000001'], ['09:00', 'K000001'], ['10:00', null]]);
  assert.equal(m.pending, 1);

  const sheet1 = p.measureSheet(k1.id, { now: at(10, 5) });
  assert.deepEqual(sheet1.slots.map((s) => s.position.label), ['08:00', '09:00']);
  assert.deepEqual([sheet1.card.cardNo, sheet1.wo.stockCode, sheet1.wo.machineNumber, sheet1.plan.length], ['K000001', 'SR001.013', 1, 3]);
  assert.equal(sheet1.slots[0].checks.gorsel, true);

  const k2 = p.issueCard(w.no, {}, { now: at(10, 30) });
  const sheet2 = p.measureSheet(k2.id, { now: at(10, 35) });
  assert.deepEqual(sheet2.slots.map((s) => s.position.label), ['10:00']);
  assert.equal(p.measureSheet(k1.id, { now: at(10, 35) }).slots.length, 2, 'ilk kartin foyu degismez');
});

test('biten is emrinde son kartin foyune bitisten sonra girilen olcum de dahil edilir', () => {
  const { p } = kur();
  const w = uretimde(p);
  p.setMeasurePlan(w.no, PLAN, { now: at(7, 5) });
  p.saveMeasurements(w.no, { values: { 1: '34,13' } }, { now: at(8, 0) });
  p.finishWorkOrder(w.no, { endAt: at(9, 0) }, { now: at(9, 0) });
  const k = p.issueCard(w.no, {}, { now: at(9, 10) });
  p.saveMeasurements(w.no, { slot: at(8, 30), values: { 1: '34,11' } }, { now: at(9, 20) }); // is emri bittikten sonra geriye donuk giris
  assert.deepEqual(p.measureSheet(k.id, { now: at(9, 30) }).slots.map((s) => s.position.label), ['08:00', '08:30']);
});

test('tezgah basi ozeti: olcu satiri sayisi ve son olcum zamani', () => {
  const { p } = kur();
  const w = uretimde(p);
  assert.deepEqual(p.shopOverview({ now: NOW }).machines[0].active.measure, { rows: 0, last: null });
  p.setMeasurePlan(w.no, PLAN, { now: NOW });
  p.saveMeasurements(w.no, { values: { 1: '34,1' } }, { now: at(9, 50) });
  assert.deepEqual(p.shopOverview({ now: NOW }).machines[0].active.measure, { rows: 3, last: at(9, 50) });
});

test('HTTP: plan (PUT), olcum (POST/GET), kartin foyu (GET) ve hata kodlari', async () => {
  const { p, st } = kur();
  st.live.set('CNC-01', { connected: true, state: 'RUNNING', program: 'X', partTotal: 100 });
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
    assert.equal((await j(`/api/planning/work-orders/${w.no}/measurements`, 'POST', { values: { 1: '1' } })).status, 409, 'baslamadan');
    await j(`/api/planning/work-orders/${w.no}/start`, 'POST', {});
    assert.equal((await j(`/api/planning/work-orders/${w.no}/measurements`, 'POST', { values: { 1: '1' } })).json.code, 'no-plan');
    assert.equal((await j(`/api/planning/work-orders/${w.no}/measure-plan`, 'PUT', { rows: [{ label: '' }] })).status, 400);
    const pl = await j(`/api/planning/work-orders/${w.no}/measure-plan`, 'PUT', { rows: PLAN });
    assert.deepEqual([pl.status, pl.json.plan.length], [200, 3]);
    const k = await j(`/api/planning/work-orders/${w.no}/measurements`, 'POST', { values: { 1: '34,13', 2: '31,5' }, checks: { gorsel: true }, person: 'Ayşe' });
    assert.equal(k.status, 200, JSON.stringify(k.json));
    assert.equal(k.json.saved.values[2].status, 'yuksek');
    assert.equal(k.json.warnings.length, 1);
    assert.equal((await j(`/api/planning/work-orders/${w.no}/measurements`, 'POST', { values: { 9: '1' } })).status, 400);
    const g = (await j(`/api/planning/work-orders/${w.no}/measurements`)).json;
    assert.deepEqual([g.slots.length, g.pending, g.plan[0].label], [1, 1, 'Ø34,2']);
    const card = (await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', {})).json;
    const sheet = await j(`/api/planning/crates/${card.id}/sheet`);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.json.slots.length, 1);
    assert.equal(sheet.json.card.cardNo, card.cardNo);
    assert.equal((await j('/api/planning/crates/99999/sheet')).status, 404);
    assert.equal((await j('/api/planning/work-orders/0000000000/measurements')).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
