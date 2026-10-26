/**
 * Cizelgeleme / optimizasyon (OR-Tools CP-SAT) - bekleyen (planlandi) is emirlerini hangi tezgaha,
 * hangi sirayla vermenin ONERISINI cikarir. Bu bir operasyonel arastirma / kombinatoryal
 * optimizasyon problemi (paralel makine cizelgeleme), yapay ogrenme modeli DEGIL. Ayrinti ve
 * kararlar: CLAUDE.md "Cizelgeleme / optimizasyon".
 *
 * Mimari: Node'un sifir bagimlilik kurali bu modul icin GECERLI KALIR - CP-SAT'in olgun API'si
 * Python oldugundan, problem tanimi JSON olarak AYRI bir Python surecine (optimizer/schedule_solver.py)
 * verilir, sonuc JSON olarak okunur (`child_process`; npm paketi DEGIL). Backend bu sureci
 * `run()` (test edilebilirlik icin enjekte edilebilir) ile cagirir.
 *
 * Hedef (oncelik sirali, agirlik uydurmaya gerek kalmasin diye):
 *   1) once toplam termin gecikmesini (tardiness) en aza indir
 *   2) sonra o en iyi gecikmeyi SABITLEYIP makespan + yuk dengesizligi + hammadde/musteri degisim
 *      SAYISI x ceza'yi birlikte en aza indir (degisim SURESI tahmin edilmez: gercek veri yok).
 *
 * SONUC ASLA OTOMATIK UYGULANMAZ: `suggest()` yalniz onerir, `apply()` kullanicinin ONAYLADIGI
 * atamalari (mevcut `Planning.updateWorkOrder` yoluyla, ayni dogrulama ve "baslamis is emrinin
 * tezgahi degismez" kurali gecerli) islemeye cevirir.
 *
 * Uretimdeki (uretimde) is emirlerine DOKUNULMAZ: yalniz mevcut tezgah mesguliyetini belirlemek
 * icin kullanilir (zaten var olan `getWorkOrder().progress.eta` tahmini ile - yeni bir hesap
 * YAZILMAZ). Tezgahlar birbirinin yerine gecebilir kabul edilir (envanterde kapasite/uygunluk
 * kisiti yok): bu dogrulanmamis bir varsayimdir.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { PlanningError } from './errors.js';
import { materialKey } from './material.js';
import { dateKey } from '../../shared/shifts.js';

const SOLVER_PATH = fileURLToPath(new URL('../../optimizer/schedule_solver.py', import.meta.url));
// Setup.exe projenin koklune runtime\python\python.exe olarak gomer (Node'un runtime\node.exe'si gibi;
// bkz. installer/build-installer.ps1). Gelistirmede bu klasor yok, PATH'teki python'a dusulur.
const BUNDLED_PYTHON = fileURLToPath(new URL('../../runtime/python/python.exe', import.meta.url));
const DAY_MS = 86_400_000;
/** "Degisim ve ayar" duruslarinin GERCEK ortalamasindan otomatik hesaplanmasi sonraki is (bkz. CLAUDE.md); simdilik kaba sabit varsayim. */
const DEFAULT_CHANGEOVER_PENALTY_SEC = 1200;
const MAX_JOBS = 500;
const MAX_APPLY = 500;

/** Calistirilacak python: SCHEDULE_PYTHON (elle gecersiz kilma) > gomulu (Setup.exe) > PATH'teki python/python3. */
function pythonBin() {
  if (process.env.SCHEDULE_PYTHON) return process.env.SCHEDULE_PYTHON;
  if (existsSync(BUNDLED_PYTHON)) return BUNDLED_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Python alt surecini calistirir, stdin'den problemi yazar, stdout'tan JSON sonucu okur. */
function defaultRun(problem) {
  return new Promise((resolve, reject) => {
    const bin = pythonBin();
    let child;
    try {
      child = spawn(bin, [SOLVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new PlanningError(`Optimizasyon motoru (Python) başlatılamadı: ${err.message}`, 503, 'optimizer-unavailable'));
      return;
    }
    let out = '';
    let errText = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('error', (err) => {
      // ENOENT: python bu makinede yok. Mesaj kurulumu isaret eder (bkz. CLAUDE.md "Cizelgeleme": Setup.exe'ye gomme henuz yapilmadi).
      reject(new PlanningError(`Optimizasyon motoru (Python) bu makinede çalıştırılamadı: ${err.message}. Kurulum: Python + "pip install ortools".`, 503, 'optimizer-unavailable'));
    });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* asagida ele alinir */ }
      if (!parsed || typeof parsed !== 'object') {
        reject(new PlanningError(`Optimizasyon motorundan geçersiz yanıt (çıkış kodu ${code}): ${(errText || out).trim().slice(0, 500) || 'boş yanıt'}`, 502, 'optimizer-failed'));
        return;
      }
      resolve(parsed);
    });
    child.stdin.write(JSON.stringify(problem));
    child.stdin.end();
  });
}

export class Schedule {
  constructor({ planning }) {
    this.planning = planning;
  }

  /** stockCode -> sure (sn): ONCE OLCULEN cevrim (son 90 gun), yoksa urun kartindaki PLANLANAN. Yeni veri cikarma kodu yok: efficiencyReport'u aynen kullanir. */
  #durationSecByStock(now) {
    const from = dateKey(new Date(now - 90 * DAY_MS));
    const to = dateKey(new Date(now));
    const map = new Map();
    for (const p of this.planning.efficiencyReport({ from, to }).products) map.set(p.stockCode, p.measuredCycleSec ?? p.plannedSec ?? null);
    return map;
  }

  /**
   * Cozucuye verilecek problemi toplar: bekleyen (planlandi) is emirleri = isler; uretimdeki is emirleri
   * = tezgah mesguliyeti (busyUntilSec); envanter = tezgahlar. Suresi bilinmeyen is emri cizelgelemeye
   * ALINMAZ (uydurulmaz), `warnings`'te ayrica bildirilir.
   * @returns {{problem: object, jobInfo: Map<string, object>, warnings: string[]}}
   */
  buildProblem({ now = Date.now() } = {}) {
    const machines = this.planning.listMachines().map((m) => ({ id: m.id }));
    if (machines.length === 0) throw new PlanningError('Envanterde tezgah yok: çizelgeleme için önce tezgah tanımlanmalı.', 409, 'no-machines');

    const durationSecByStock = this.#durationSecByStock(now);
    const durationSecOf = (w) => durationSecByStock.get(w.stockCode) ?? w.plannedSec ?? null;
    const warnings = [];

    const busyUntilSec = new Map(machines.map((m) => [m.id, 0]));
    for (const w of this.planning.db.listWorkOrders({ status: 'uretimde', limit: MAX_JOBS }).items) {
      if (!w.machineId || !busyUntilSec.has(w.machineId)) continue;
      const prog = this.planning.getWorkOrder(w.no, { now }).progress;
      let sec = 0;
      if (prog && prog.remaining > 0) {
        if (prog.eta) sec = Math.max(0, Math.round((prog.eta.ms - now) / 1000));
        else {
          const per = durationSecOf(w);
          if (per != null) sec = Math.round(prog.remaining * per);
          else warnings.push(`${w.no} (${w.machineId}): tahmini bitiş bilinmiyor, bu tezgah hemen boş sayıldı.`);
        }
      }
      busyUntilSec.set(w.machineId, Math.max(busyUntilSec.get(w.machineId), sec));
    }

    const jobs = [];
    const jobInfo = new Map();
    let totalDurationSec = 0;
    let maxDueSec = 0;
    for (const w of this.planning.db.listWorkOrders({ status: 'planlandi', limit: MAX_JOBS }).items) {
      const per = durationSecOf(w);
      if (per == null) { warnings.push(`${w.no}: ölçülen ya da planlanan çevrim süresi yok, çizelgelemeye alınamadı.`); continue; }
      const durationSec = Math.max(1, Math.round(w.targetQty * per));
      const dueSec = w.dueDate != null ? Math.max(0, Math.round((w.dueDate - now) / 1000)) : null;
      jobs.push({ no: w.no, durationSec, dueSec, materialKey: materialKey(w.material) || `__yok__${w.no}` });
      jobInfo.set(w.no, { stockCode: w.stockCode, productName: w.productName, customer: w.customer, targetQty: w.targetQty, dueDate: w.dueDate, currentMachineId: w.machineId });
      totalDurationSec += durationSec;
      if (dueSec != null) maxDueSec = Math.max(maxDueSec, dueSec);
    }
    if (jobs.length > MAX_JOBS) throw new PlanningError(`Bekleyen iş emri sayısı çok fazla (${jobs.length}); en fazla ${MAX_JOBS} ile çizelgelenebilir.`, 413);

    const maxBusy = Math.max(0, ...busyUntilSec.values());
    // Ufuk: termini olan en gec is + hiç gecikme olmasa dahi tum kuyrugu tezgahlara esit bolup bitirmenin kaba 3x'i (sira ozgurlugu icin) + 1 gun pay.
    const horizonSec = Math.round(Math.max(maxDueSec, maxBusy + Math.ceil(totalDurationSec / machines.length) * 3) + DAY_MS / 1000);
    for (const j of jobs) if (j.dueSec == null) j.dueSec = horizonSec; // termin yoksa gecikme baskisi olmasin diye ufkun kendisi verilir

    const rawPenalty = this.planning.db.getSetting('schedule.changeoverPenaltySec');
    const changeoverPenaltySec = rawPenalty != null ? Number(rawPenalty) : DEFAULT_CHANGEOVER_PENALTY_SEC;

    return {
      problem: { horizonSec, changeoverPenaltySec, machines: machines.map((m) => ({ id: m.id, busyUntilSec: busyUntilSec.get(m.id) })), jobs },
      jobInfo, warnings,
    };
  }

  /** Python alt surecini cagirir ve sonucu dogrular. `run`: testlerde sahte cozucu enjekte etmek icin. */
  async solveSchedule(problem, { run = defaultRun } = {}) {
    const result = await run(problem);
    if (!result.ok) throw new PlanningError(result.error || 'Çözüm bulunamadı.', 502, 'optimizer-infeasible');
    return result;
  }

  /**
   * Oneriyi cikarir: tezgah basina sira + tahmini baslangic/bitis + ozet metrikler. ASLA is emrine yazmaz.
   * @returns {Promise<{now: number, assignments: object[], metrics: object, warnings: string[]}>}
   */
  async suggest({ now = Date.now(), run } = {}) {
    const { problem, jobInfo, warnings } = this.buildProblem({ now });
    if (problem.jobs.length === 0) {
      return {
        now, assignments: [], metrics: { totalTardinessSec: 0, makespanSec: 0, loadImbalanceSec: 0, changeoverCount: 0 },
        warnings: [...warnings, 'Bekleyen (planlandı) iş emri yok: çizelgelenecek bir şey bulunamadı.'],
      };
    }
    const solved = await this.solveSchedule(problem, run ? { run } : {});
    const assignments = solved.assignments.map((a) => {
      const info = jobInfo.get(a.no) ?? {};
      return {
        no: a.no, machineId: a.machineId, currentMachineId: info.currentMachineId ?? null, changesMachine: (info.currentMachineId ?? null) !== a.machineId,
        startAt: now + a.startSec * 1000, endAt: now + a.endSec * 1000,
        stockCode: info.stockCode ?? null, productName: info.productName ?? null, customer: info.customer ?? null,
        targetQty: info.targetQty ?? null, dueDate: info.dueDate ?? null,
      };
    }).sort((a, b) => a.startAt - b.startAt || a.no.localeCompare(b.no));
    return { now, assignments, metrics: solved.metrics, warnings };
  }

  /**
   * Onaylanan atamalari isler: mevcut `Planning.updateWorkOrder` yolunu kullanir (ayni dogrulama,
   * ayni "baslamis is emrinin tezgahi degismez" kurali). Arada baslatilmis/iptal olmus is emri
   * SESSIZCE atlanir ve raporlanir (tum istek reddedilmez).
   * @param {{no: string, machineId: string}[]} assignments
   * @returns {{applied: string[], skipped: {no: string|null, reason: string, code?: string|null}[]}}
   */
  apply(assignments, { by = null, now = Date.now() } = {}) {
    if (!Array.isArray(assignments) || assignments.length === 0) throw new PlanningError('Uygulanacak atama listesi boş.');
    if (assignments.length > MAX_APPLY) throw new PlanningError(`Tek seferde en fazla ${MAX_APPLY} atama uygulanabilir.`, 413);
    const applied = [];
    const skipped = [];
    for (const a of assignments) {
      const no = String(a?.no ?? '').trim();
      const machineId = String(a?.machineId ?? '').trim();
      if (!no || !machineId) { skipped.push({ no: a?.no ?? null, reason: 'Eksik iş emri no ya da tezgah.' }); continue; }
      try {
        this.planning.updateWorkOrder(no, { machineId }, { by, now });
        applied.push(no);
      } catch (err) {
        if (err instanceof PlanningError) skipped.push({ no, reason: err.message, code: err.code ?? null });
        else throw err;
      }
    }
    return { applied, skipped };
  }
}
