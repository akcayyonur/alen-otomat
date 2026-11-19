/**
 * GKK KALITE RAPORU klasoru: hammaddenin (malzemenin) uretici kalite sertifikasi PDF'leri bir klasore
 * konur; dosya adinda (ya da klasor yolunda) o teslimatin GK RAPOR NUMARASI yazar (ör. "AA24 X 13 - PB3 -
 * GK25.093.pdf", "GK26.353 - AA37 X 21 - PB2.pdf"). Klasor taranip dosyalar GKK kayitlarindaki RAPOR
 * NUMARASINA (gkk_reports.report_key) baglanir. doc-folder.js'teki (teknik resim/etiket) "ayarla -> esle"
 * deseniyle AYNI, ama DAHA BASIT:
 *
 *   - Kod tespiti yok (urun kodu kavrami bu domende yok): dosya adindan `findGkNoIn` ile bir GK rapor
 *     numarasi (GKxx.xxx) cikarilir, kayitli raporlardan AYNISI aranir (tam/exact eslesme — alt dize
 *     eslesmesi degil, rapor numaralari birbirini icerebildigi icin ör. "GK25.1" vs "GK25.10").
 *   - AYNI rapor numarasini PAYLASAN kayitlar (bir rapor no birden cok hammaddeye yazilabilir) AYNI
 *     dosyalari gorur; AYNI hammaddenin FARKLI rapor numaralari (ayri teslimat) AYRI dosyalar gorur —
 *     2026-11-19 duzeltmesi: oncesinde hammadde CINSINE baglaniyordu, bu gercek klasorde YANLIS cikti
 *     (kullanici fark etti: ayni hammadde klasorundeki GK25.141 ve GK25.179 dosyalari FARKLI sertifikalar).
 *   - Dosya adinda GK numarasi YOKSA ya da o numarayla eslesen bir GKK kaydi HIC YOKSA dosya "eslesmedi"
 *     listelenir (baglanmaz).
 *   - TEK SEFERLIK (kullanici istegi, 2026-11-17): "update" (yeniden revizyon) YOK; yalniz hic dosyasi
 *     OLMAYAN rapor numaralari eslenir, zaten raporu olana dokunulmaz.
 *
 * Not: sunucu SYSTEM hesabiyla calisir; ag paylasimi ona kapali olabilir, YEREL klasor kullanin (doc-folder.js'teki AYNI kisit).
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PlanningError } from './errors.js';
import { compactKey, findGkNoIn } from './gkk.js';
import { MAX_GKK_FILES } from './quality.js';
import { readErrorMessage, readFileRetry, scanFolder } from './doc-folder.js';

const EXTENSIONS = ['.pdf'];
const SETTING_DIR = 'docs.gkk.dir';

export class GkkFolder {
  /** @param {{planning: import('./planning.js').Planning, defaultDir?: string|null}} deps */
  constructor({ planning, defaultDir = null }) {
    this.planning = planning;
    this.defaultDir = defaultDir ? resolve(defaultDir) : null;
    this.busy = false;
  }

  get #db() { return this.planning.db; }

  get #quality() { return this.planning.quality; }

  dir() { return this.#db.getSetting(SETTING_DIR) ?? this.defaultDir; }

  config() {
    const dir = this.dir();
    return { dir, defaultDir: this.defaultDir, isDefault: dir === this.defaultDir, extensions: EXTENSIONS };
  }

  setDir(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '') { this.#db.setSetting(SETTING_DIR, null); return this.config(); }
    if (raw.length > 260) throw new PlanningError('Klasör yolu en fazla 260 karakter olabilir.');
    if (!isAbsolute(raw)) throw new PlanningError('Klasör yolu tam (mutlak) olmalı, ör. C:\\CNC-Telemetri\\data\\gkk-rapor');
    const dir = resolve(raw);
    let st;
    try { st = statSync(dir); } catch { throw new PlanningError(`Klasör bulunamadı ya da okunamıyor: ${dir}`, 400, 'no-dir'); }
    if (!st.isDirectory()) throw new PlanningError(`Bu bir klasör değil: ${dir}`, 400, 'no-dir');
    this.#db.setSetting(SETTING_DIR, dir);
    return this.config();
  }

  #ensureDefault(dir) {
    if (dir && dir === this.defaultDir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Kayitli raporlar: report_key -> {reportNo, rows} (bir rapor no birden cok hammaddeye yazilabilir, hepsi AYNI dosyalari gorur). */
  #reports() {
    const index = new Map();
    for (const r of this.#quality.db.gkkAll()) {
      const key = compactKey(r.reportNo);
      const entry = index.get(key) ?? { reportNo: r.reportNo, rows: [] };
      entry.rows.push(r);
      index.set(key, entry);
    }
    return index;
  }

  /** Hic dosyasi olmayan rapor numaralari. */
  #missing(reports) {
    const none = [...reports.values()].filter((e) => this.#quality.db.gkkFiles(compactKey(e.reportNo)).length === 0).map((e) => e.reportNo);
    return { total: reports.size, none };
  }

  /** Eslemeden durum: klasor, dosya sayisi ve kalite raporu olmayan rapor numarasi sayisi. */
  status() {
    const cfg = this.config();
    const base = { ...cfg, exists: false, files: 0, truncated: false, reports: 0, without: 0 };
    if (!cfg.dir) return base;
    this.#ensureDefault(cfg.dir);
    if (!existsSync(cfg.dir)) return base;
    const { files, truncated } = scanFolder(cfg.dir, { extensions: EXTENSIONS });
    const miss = this.#missing(this.#reports());
    return { ...base, exists: true, files: files.length, truncated, reports: miss.total, without: miss.none.length };
  }

  /**
   * Klasoru tarar ve dosyalari, adlarindan cikan GK rapor numarasina gore GKK kayitlarina baglar. Tek
   * seferliktir: yalniz hic kalite raporu OLMAYAN rapor numaralari eslenir.
   * @param {{by?: string|null, now?: number}} [opts]
   */
  match({ by = null, now = Date.now() } = {}) {
    if (this.busy) throw new PlanningError('Bir eşleme zaten sürüyor, bitmesini bekleyin.', 409, 'busy');
    this.busy = true;
    try {
      const dir = this.dir();
      if (!dir) throw new PlanningError('GKK kalite raporu klasörü ayarlanmadı. "Klasör" ile belirleyin.', 409, 'no-dir');
      this.#ensureDefault(dir);
      if (!existsSync(dir)) throw new PlanningError(`GKK kalite raporu klasörü bulunamadı: ${dir}`, 409, 'no-dir');

      const { files, truncated } = scanFolder(dir, { extensions: EXTENSIONS });
      const reports = this.#reports();
      const result = {
        dir, at: now, truncated, scanned: files.length, attached: [], reports: 0, alreadyHad: 0,
        unmatched: [], unmatchedTotal: 0, rejected: [],
      };
      const addUnmatched = (rel, reason) => { result.unmatchedTotal += 1; result.unmatched.push({ name: rel, reason }); };
      const reject = (rel, error) => result.rejected.push({ name: rel, error });

      /** @type {Map<string, {reportNo: string, files: object[]}>} */
      const byReport = new Map();
      for (const f of files) {
        const nameWithoutExt = f.name.replace(/\.[A-Za-z0-9]+$/, '');
        const found = findGkNoIn(nameWithoutExt);
        if (!found) { addUnmatched(f.rel, 'rapor numarası bulunamadı (dosya adında GKxx.xxx yok)'); continue; }
        const key = compactKey(found.no);
        if (!reports.has(key)) { addUnmatched(f.rel, `${found.no} için GKK kaydı yok`); continue; }
        const entry = byReport.get(key) ?? { reportNo: reports.get(key).reportNo, files: [] };
        entry.files.push(f);
        byReport.set(key, entry);
      }

      for (const [key, entry] of [...byReport].sort((a, b) => a[1].reportNo.localeCompare(b[1].reportNo, 'tr'))) {
        if (this.#quality.db.gkkFiles(key).length > 0) { result.alreadyHad += 1; continue; } // tek seferlik: zaten raporu olana dokunulmaz
        const names = [];
        for (const f of entry.files) {
          if (names.length >= MAX_GKK_FILES) { reject(f.rel, `en çok ${MAX_GKK_FILES} dosya eklenebilir`); continue; }
          let data;
          try { data = readFileRetry(f.path); } catch (err) { reject(f.rel, readErrorMessage(err)); continue; }
          try {
            this.#quality.addGkkFile(entry.reportNo, { name: f.name, data, source: 'klasor', relPath: f.rel }, { by, now });
            names.push(f.name);
          } catch (err) {
            if (err instanceof PlanningError) { if (err.code !== 'duplicate') reject(f.rel, err.message); } else reject(f.rel, err.message);
          }
        }
        if (names.length === 0) continue;
        result.reports += 1;
        result.attached.push({ reportNo: entry.reportNo, files: names });
      }

      const miss = this.#missing(reports);
      result.missing = { reports: miss.total, total: miss.none.length, sample: miss.none };
      return result;
    } finally {
      this.busy = false;
    }
  }
}
