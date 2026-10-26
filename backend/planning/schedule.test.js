/**
 * Cizelgeleme / optimizasyon (OR-Tools CP-SAT): problem toplama (buildProblem - olculen cevrim
 * onceligi, planlanana dusme, bilinmeyen sure disarida), sahte cozucu ile oneri zenginlestirme ve
 * uygulama (apply - mevcut updateWorkOrder yolu, baslamis is emri sessizce atlanir), HTTP.
 *
 * GERCEK Python/OR-Tools cozucusu BURADA CAGRILMAZ (npm test bagimsiz kalsin diye `run` enjekte
 * edilir); optimizer/schedule_solver.py'nin kendisi elle (`python -m unittest`) test edilir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { materialKey } from './material.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(10);
const DAY_MS = 86_400_000;
const MACHINES = [{ id: 'CNC-01' }, { id: 'CNC-02' }];

function kur() {
  const st = { events: [] };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MACHINES,
    productionEvents: (machineId, from, to) => st.events.filter((e) => e.machineId === machineId && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
  });
  return { p, st };
}
const ev = (machineId, ts, qty = 1, o = {}) => ({ machineId, ts, program: 'X', qty, partTotal: null, cycleSec: 30, gapMs: 0, suspect: false, ...o });

test('buildProblem: olculen cevrim onceligi, planlanana dusme, bilinmeyen sure disarida (uyariyla)', () => {
  const { p, st } = kur();
  // URUN-A: 2 gun once bitmis bir is emrinden GERCEK olculen cevrim (40 sn) var; urun kartindaki planlanan (999) yoksayilmali.
  p.createProduct({ stockCode: 'URUN-A', plannedSec: 999, material: 'HM-A' });
  const geçmis = NOW - 2 * DAY_MS;
  const a0 = p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 10, machineId: 'CNC-01' }, { now: geçmis });
  p.startWorkOrder(a0.no, { startAt: geçmis }, { now: geçmis });
  st.events.push(ev('CNC-01', geçmis + 60_000, 10, { cycleSec: 40 }));
  p.finishWorkOrder(a0.no, { endAt: geçmis + 120_000 }, { now: geçmis + 120_000 });

  // URUN-B: gecmis yok, yalniz urun kartindaki planlanan sure (50 sn).
  p.createProduct({ stockCode: 'URUN-B', plannedSec: 50, material: 'HM-B' });
  // URUN-C: ne olculen ne planlanan sure yok.
  p.createProduct({ stockCode: 'URUN-C', material: 'HM-C' });

  p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 5 }, { now: NOW });
  p.createWorkOrder({ stockCode: 'URUN-B', targetQty: 5, dueDate: NOW + 3_600_000 }, { now: NOW });
  const c = p.createWorkOrder({ stockCode: 'URUN-C', targetQty: 5 }, { now: NOW });

  const { problem, jobInfo, warnings } = p.schedule.buildProblem({ now: NOW });
  assert.equal(problem.jobs.length, 2, 'URUN-C disarida kaldi (ne olculen ne planlanan sure)');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(c.no));

  const ja = problem.jobs.find((j) => jobInfo.get(j.no).stockCode === 'URUN-A');
  assert.equal(ja.durationSec, 5 * 40, 'olculen cevrim (40 sn) kullanildi, planlanan (999) degil');
  assert.equal(ja.materialKey, materialKey('HM-A'));
  assert.equal(ja.dueSec, problem.horizonSec, 'termin yok -> ufkun kendisi verildi (gecikme baskisi olmasin)');

  const jb = problem.jobs.find((j) => jobInfo.get(j.no).stockCode === 'URUN-B');
  assert.equal(jb.durationSec, 5 * 50, 'olculen yok, planlanan (50 sn) kullanildi');
  assert.equal(jb.dueSec, 3600, 'termin now+1sa -> 3600 sn');

  assert.deepEqual(problem.machines.map((m) => m.id).sort(), ['CNC-01', 'CNC-02']);
  assert.ok(problem.machines.every((m) => m.busyUntilSec === 0), 'uretimde is emri yok -> tezgahlar bos');
});

test('buildProblem: uretimdeki is emri tezgahi mesgul eder (parcalar arasi araliktan tahmin)', () => {
  const { p, st } = kur();
  p.createProduct({ stockCode: 'URUN-A', plannedSec: 30 });
  const w = p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(w.no, { startAt: NOW }, { now: NOW });
  for (let i = 1; i <= 10; i += 1) st.events.push(ev('CNC-01', NOW + i * 30_000, 1, { cycleSec: 30 }));

  const asOf = NOW + 10 * 30_000;
  const { problem } = p.schedule.buildProblem({ now: asOf });
  const m1 = problem.machines.find((m) => m.id === 'CNC-01');
  // 90 adet kaldi, ~30 sn/adet -> ~2700 sn (makul bir aralikta, tam esitlik degil: yuvarlama)
  assert.ok(m1.busyUntilSec > 2000 && m1.busyUntilSec < 3200, `beklenmeyen busyUntilSec: ${m1.busyUntilSec}`);
  assert.equal(problem.machines.find((m) => m.id === 'CNC-02').busyUntilSec, 0);
});

test('buildProblem: tezgah yoksa hata', () => {
  const p = new Planning({ dbFile: ':memory:' });
  assert.throws(() => p.schedule.buildProblem({ now: NOW }), /tezgah yok/);
});

test('suggest: sahte cozucu ile zenginlestirme (urun bilgisi, tezgah degisiyor isareti, tarih)', async () => {
  const { p } = kur();
  p.createProduct({ stockCode: 'URUN-A', plannedSec: 30 });
  const w = p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 10 }, { now: NOW });
  const fakeRun = async (problem) => {
    assert.equal(problem.jobs.length, 1);
    assert.equal(problem.jobs[0].no, w.no);
    return { ok: true, assignments: [{ no: w.no, machineId: 'CNC-02', startSec: 0, endSec: 300 }], metrics: { totalTardinessSec: 0, makespanSec: 300, loadImbalanceSec: 0, changeoverCount: 0 } };
  };
  const r = await p.schedule.suggest({ now: NOW, run: fakeRun });
  assert.equal(r.assignments.length, 1);
  const a = r.assignments[0];
  assert.deepEqual([a.stockCode, a.machineId, a.currentMachineId, a.changesMachine], ['URUN-A', 'CNC-02', null, true]);
  assert.equal(a.startAt, NOW);
  assert.equal(a.endAt, NOW + 300_000);
  assert.equal(r.metrics.makespanSec, 300);
});

test('suggest: bekleyen is emri yoksa cozucu hic cagrilmaz', async () => {
  const { p } = kur();
  let called = false;
  const r = await p.schedule.suggest({ now: NOW, run: async () => { called = true; return { ok: true, assignments: [], metrics: {} }; } });
  assert.equal(called, false);
  assert.equal(r.assignments.length, 0);
  assert.match(r.warnings.join(' '), /çizelgelenecek bir şey bulunamadı/);
});

test('suggest: cozucu basarisiz donerse (ok:false) PlanningError firlatilir', async () => {
  const { p } = kur();
  p.createProduct({ stockCode: 'URUN-A', plannedSec: 30 });
  p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 10 }, { now: NOW });
  await assert.rejects(
    p.schedule.suggest({ now: NOW, run: async () => ({ ok: false, error: 'OR-Tools durumu: INFEASIBLE' }) }),
    (err) => { assert.equal(err.code, 'optimizer-infeasible'); assert.match(err.message, /INFEASIBLE/); return true; },
  );
});

test('apply: onaylanan atama is emrine yazar; baslamis is emri sessizce atlanir (machine-locked)', () => {
  const { p } = kur();
  p.createProduct({ stockCode: 'URUN-A', plannedSec: 30 });
  const a = p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 10 }, { now: NOW });
  const b = p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 5, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(b.no, { startAt: NOW }, { now: NOW }); // artik uretimde: tezgahi degismez

  const r = p.schedule.apply([{ no: a.no, machineId: 'CNC-02' }, { no: b.no, machineId: 'CNC-02' }], { by: 'test', now: NOW });
  assert.deepEqual(r.applied, [a.no]);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual([r.skipped[0].no, r.skipped[0].code], [b.no, 'machine-locked']);
  assert.equal(p.getWorkOrder(a.no).machineId, 'CNC-02');
  assert.equal(p.getWorkOrder(b.no).machineId, 'CNC-01', 'uretimdeki is emrinin tezgahi degismedi');
});

test('apply: bos / asiri buyuk / eksik alanli liste', () => {
  const { p } = kur();
  assert.throws(() => p.schedule.apply([]), /boş/);
  assert.throws(() => p.schedule.apply(Array.from({ length: 501 }, (_, i) => ({ no: String(i), machineId: 'CNC-01' }))), /500/);
  const r = p.schedule.apply([{ no: '', machineId: 'CNC-01' }]);
  assert.deepEqual([r.applied, r.skipped.length], [[], 1]);
});

test('HTTP: /schedule/suggest ve /schedule/apply (sahte cozucu, gercek Python cagrilmaz)', async () => {
  const { p } = kur();
  p.createProduct({ stockCode: 'URUN-A', plannedSec: 30 });
  const w = p.createWorkOrder({ stockCode: 'URUN-A', targetQty: 10 }, { now: NOW });
  // routes.js planning.schedule.suggest()'i parametresiz cagirir: gercek Python surecini atlamak icin
  // alt-seviye solveSchedule burada sahte donusle degistirilir (yalniz bu testte).
  p.schedule.solveSchedule = async () => ({
    ok: true, assignments: [{ no: w.no, machineId: 'CNC-02', startSec: 0, endSec: 300 }],
    metrics: { totalTardinessSec: 0, makespanSec: 300, loadImbalanceSec: 0, changeoverCount: 0 },
  });
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
    const s = await j('/api/planning/schedule/suggest', 'POST', {});
    assert.equal(s.status, 200);
    assert.equal(s.json.assignments.length, 1);
    assert.equal(s.json.assignments[0].machineId, 'CNC-02');

    const ap = await j('/api/planning/schedule/apply', 'POST', { assignments: s.json.assignments.map((a) => ({ no: a.no, machineId: a.machineId })) });
    assert.equal(ap.status, 200);
    assert.deepEqual(ap.json.applied, [w.no]);
    assert.equal((await j(`/api/planning/work-orders/${w.no}`)).json.machineId, 'CNC-02');

    assert.equal((await j('/api/planning/schedule/apply', 'POST', { assignments: [] })).status, 400);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
