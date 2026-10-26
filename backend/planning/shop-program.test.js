/**
 * Tezgah basi: IS EMRI BAGLANMASA DA calisan program gorunur (ne zamandir, kac parca, hangi urun) ve programa uyan bekleyen is emirleri yukaridan
 * baglamak icin sunulur. Deneme asamasinda ustalar sisteme dokunmaz; is emri ofisten baglanir. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planning } from './planning.js';

const NOW = new Date(2026, 9, 15, 12).getTime();
const saat = (h) => NOW - h * 3_600_000;
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-02', name: 'Torna 2' }];

function kur() {
  const live = new Map();
  const runs = new Map();
  const p = new Planning({
    dbFile: ':memory:', listMachines: () => MAKINELER, productionEvents: () => [],
    liveMachine: (id) => live.get(id) ?? null, programRuns: (id) => { const r = runs.get(id); if (r instanceof Error) throw r; return r ?? []; },
  });
  const urun = (kod, ek = {}) => p.createProduct({ stockCode: kod, name: `${kod} URUN`, material: 'HM1', grossKg: 0.05, netKg: 0.04, plannedSec: 20, ...ek });
  const emri = (kod, ek = {}) => p.createWorkOrder({ stockCode: kod, targetQty: 100, ...ek }, { now: NOW });
  const canli = (id, program, ek = {}) => live.set(id, { connected: true, state: 'RUNNING', program, mainProgram: program, partTotal: 500, partCount: 10, ...ek });
  const prog = (id) => p.shopOverview({ now: NOW }).machines.find((m) => m.id === id).program;
  return { p, live, runs, urun, emri, canli, prog };
}

test('veri gelmiyorsa ya da program okunamiyorsa bunu soyler (bos kart degil)', () => {
  const k = kur();
  assert.deepEqual(k.prog('CNC-01'), { state: 'veri-yok', name: null }, 'telemetri hic gelmemis');
  k.live.set('CNC-01', { connected: false, state: 'NO_DATA', program: null, mainProgram: null });
  assert.equal(k.prog('CNC-01').state, 'veri-yok');
  k.canli('CNC-01', '');
  assert.equal(k.prog('CNC-01').state, 'program-yok');
  k.p.close();
});

test('is emri YOKKEN: calisan program, ne zamandir/kac parca ve musteri koduyla taninan urun; bekleyen is emirleri bu tezgaha atananlar once gelir', () => {
  const k = kur();
  k.urun('SR001.001', { customerCode: '140100188' });
  k.urun('SR002.001', { customerCode: '999888777' });
  const a = k.emri('SR001.001', { machineId: 'CNC-02' });
  const b = k.emri('SR001.001'); // tezgah atanmamis
  const c = k.emri('SR001.001', { machineId: 'CNC-01' });
  k.emri('SR002.001', { machineId: 'CNC-01' }); // baska urun: onerilmez
  k.canli('CNC-01', '140100188');
  k.runs.set('CNC-01', [
    { program: '777777777', startedAt: saat(30), endedAt: saat(5), qty: 40, approxQty: 0 },
    { program: '140100188', startedAt: saat(3), endedAt: null, qty: 87, approxQty: 2 },
  ]);

  const pr = k.prog('CNC-01');
  assert.equal(pr.state, 'calisiyor');
  assert.equal(pr.name, '140100188');
  assert.deepEqual([pr.startedAt, pr.parts, pr.approx], [saat(3), 87, true]);
  assert.deepEqual(pr.product, { stockCode: 'SR001.001', name: 'SR001.001 URUN', how: 'musteri-kodu' });
  assert.deepEqual(pr.waiting.map((x) => x.no), [c.no, b.no, a.no], 'bu tezgaha atanan, atanmamis, baska tezgah');
  assert.equal(pr.mismatch, null);
  assert.deepEqual(pr.ambiguous, []);
  k.p.close();
});

test('aralik bilgisi yoksa / program degismisse / telemetri hata verirse sure ve adet bos kalir (uydurulmaz)', () => {
  const k = kur();
  k.urun('SR001.001', { customerCode: '140100188' });
  k.canli('CNC-01', '140100188');
  assert.deepEqual([k.prog('CNC-01').startedAt, k.prog('CNC-01').parts], [null, null], 'aralik yok');
  k.runs.set('CNC-01', [{ program: '555555555', startedAt: saat(2), endedAt: null, qty: 9, approxQty: 0 }]);
  assert.equal(k.prog('CNC-01').startedAt, null, 'son aralik baska programin');
  k.runs.set('CNC-01', [{ program: '140100188', startedAt: saat(4), endedAt: saat(1), qty: 9, approxQty: 0 }]);
  assert.equal(k.prog('CNC-01').startedAt, null, 'son aralik kapanmis');
  k.runs.set('CNC-01', new Error('okunamadi'));
  assert.equal(k.prog('CNC-01').state, 'calisiyor', 'telemetri hatasi karti bozmaz');
  assert.equal(k.prog('CNC-01').startedAt, null);
  k.p.close();
});

test('program eslemesi musteri kodu onerisinden ustundur; urun birden cok adaya uyuyorsa "belirsiz" ve ikisinin de bekleyen is emirleri gelir', () => {
  const k = kur();
  k.urun('SR001.001', { customerCode: '140100188' });
  k.urun('SR002.001', { customerCode: '140100188' });
  const a = k.emri('SR001.001', { machineId: 'CNC-01' });
  const b = k.emri('SR002.001', { machineId: 'CNC-01' });
  k.canli('CNC-01', '140100188');

  const belirsiz = k.prog('CNC-01');
  assert.equal(belirsiz.product, null);
  assert.deepEqual(belirsiz.ambiguous, ['SR001.001', 'SR002.001']);
  assert.deepEqual(belirsiz.waiting.map((x) => x.no).sort(), [a.no, b.no].sort());

  k.p.mapProgram('140100188', 'SR002.001');
  const esli = k.prog('CNC-01');
  assert.deepEqual(esli.product, { stockCode: 'SR002.001', name: 'SR002.001 URUN', how: 'esleme' });
  assert.deepEqual(esli.waiting.map((x) => x.no), [b.no], 'eslenen urunun is emri');
  assert.deepEqual(esli.ambiguous, []);
  k.p.close();
});

test('tanimadigi program: urun yok, bekleyen yok (ortak alt program gibi); program adi yine gorunur', () => {
  const k = kur();
  k.urun('SR001.001', { customerCode: '140100188' });
  k.emri('SR001.001', { machineId: 'CNC-01' });
  k.canli('CNC-01', 'O9001');
  const pr = k.prog('CNC-01');
  assert.deepEqual([pr.state, pr.name, pr.product, pr.waiting, pr.ambiguous], ['calisiyor', 'O9001', null, [], []]);
  k.p.close();
});

test('is emri BAGLIYKEN: bekleyen listesi bos; program baska urune eslese capraz denetim uyarir, ayni urunse uyarmaz', () => {
  const k = kur();
  k.urun('SR001.001', { customerCode: '140100188' });
  k.urun('SR002.001', { customerCode: '999888777' });
  const w = k.emri('SR001.001', { machineId: 'CNC-01' });
  k.emri('SR001.001', { machineId: 'CNC-01' });
  k.canli('CNC-01', '140100188');
  k.p.startWorkOrder(w.no, {}, { now: NOW });

  const uygun = k.prog('CNC-01');
  assert.deepEqual([uygun.waiting, uygun.mismatch], [[], null], 'is emri bagli: baglama onerisi yok, program uyuyor');

  k.canli('CNC-01', '999888777'); // usta baska urunun programini acti
  const uyumsuz = k.prog('CNC-01');
  assert.deepEqual(uyumsuz.mismatch, { woStockCode: 'SR001.001' });
  assert.equal(uyumsuz.product.stockCode, 'SR002.001');
  k.p.close();
});

test('ana program yoksa alt program adi kullanilir; ana programdan farkliysa alt program ayrica bildirilir', () => {
  const k = kur();
  k.canli('CNC-01', '140100188', { program: 'O9001', mainProgram: '140100188' });
  assert.deepEqual([k.prog('CNC-01').name, k.prog('CNC-01').subProgram], ['140100188', 'O9001']);
  k.canli('CNC-01', 'O9001', { program: 'O9001', mainProgram: null });
  assert.deepEqual([k.prog('CNC-01').name, k.prog('CNC-01').subProgram], ['O9001', null]);
  k.p.close();
});
