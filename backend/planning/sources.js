/**
 * KAYNAK KLASORU: Mikro'nun (ve GKK / ilk onay formlarinin) Excel dosyalari sabit bir klasore konur; "Yenile" bu klasoru okur, DEGISEN dosyalari
 * bulur ve uygulamayi gunceller (yeni siparis satiri, degisen kalan miktar, yeni/degisen urun karti, yeni GKK kaydi ...). Her seferinde dosya
 * yuklemek gerekmez. Disaridan veri alan ek bir kanal DEGIL: ayni iceri alma kodu (importers.js) ve ayni yetki (yalniz yonetici) kullanilir.
 *
 *   - Klasor: yonetici ayarlar (settings 'sources.dir'); ayar yoksa `defaultDir` (varsayilan data/kaynak, yoksa olusturulur).
 *   - Dosyalar: klasordeki .xlsx / .csv (alt klasor yok; ~$ ve . ile baslayanlar atlanir). Turu ICERIKTEN (sayfa basliklarindan) anlasilir;
 *     tanimadigi dosya/sayfa atlanir. Eskiden yeniye islenir: ayni turden iki dosyada en yeni dosya kazanir.
 *   - Degisiklik tespiti: dosyanin boyutu + degistirilme zamani son iceri alinanla ayniysa dokunulmaz; farkliysa icerik ozeti (SHA-256) de bakilir
 *     (dosya yeniden kaydedilmis ama icerigi ayniysa islenmez). Okunamayan/yarim yazilmis dosya kaydedilmez: bir sonraki yenilemede yeniden denenir.
 *   - Sonuc: dosya basina durum, toplamlar ve NE DEGISTI listeleri (siparis satirlari, urun kartlari, korunan elle duzenlenmis kartlar, GKK ...).
 *   - Siparis satirlari dosyada yoksa GIZLENMEZ (Mikro'dan silinen/kapanan siparis uygulamada kalir; "tam dokum" yuklemesi elle yapilir).
 *
 * Not: sunucu bir zamanlanmis gorev olarak SYSTEM hesabiyla calisir; ag paylasimi (\\sunucu\paylasim) SYSTEM'e acik degilse okunamaz.
 * Mikro dosyasini YEREL bir klasore yazdirin ya da kopyalayin.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { PlanningError } from './errors.js';

const EXTENSIONS = new Set(['.xlsx', '.csv']);
const MAX_FILES = 50;
const MAX_BYTES = 64 * 1024 * 1024;
const SETTING_DIR = 'sources.dir';
const SETTING_LAST = 'sources.last-refresh';

const emptyTotals = () => ({
  lines: { added: 0, updated: 0 }, products: { added: 0, updated: 0, protected: 0 }, gkk: { added: 0, updated: 0 }, approvals: { added: 0, updated: 0 },
  stock: { added: 0, updated: 0, removed: 0 },
});
const emptyChanges = () => ({
  lines: { added: [], updated: [] }, products: { added: [], updated: [], protected: [] }, gkk: { added: [], updated: [] }, approvals: { added: [], updated: [] },
});
const CAP = 40;
const addCapped = (list, items) => { for (const it of items ?? []) if (list.length < CAP) list.push(it); };

export class Sources {
  /**
   * @param {{planning: import('./planning.js').Planning, defaultDir?: string|null}} deps
   *   defaultDir verilmezse (testler) klasor ayarlanana dek kaynak yok sayilir.
   */
  constructor({ planning, defaultDir = null }) {
    this.planning = planning;
    this.defaultDir = defaultDir ? resolve(defaultDir) : null;
    this.busy = false;
  }

  get #db() { return this.planning.db; }

  /** Gecerli kaynak klasoru: yoneticinin ayari, yoksa varsayilan. */
  dir() {
    return this.#db.getSetting(SETTING_DIR) ?? this.defaultDir;
  }

  /** @returns {{dir: string|null, defaultDir: string|null, isDefault: boolean}} */
  config() {
    const dir = this.dir();
    return { dir, defaultDir: this.defaultDir, isDefault: dir === this.defaultDir };
  }

  /** Klasoru ayarlar (bos/null = varsayilana don). Klasor var olan, mutlak yollu bir dizin olmali. */
  setDir(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '') {
      this.#db.setSetting(SETTING_DIR, null);
      return this.config();
    }
    if (raw.length > 260) throw new PlanningError('Klasör yolu en fazla 260 karakter olabilir.');
    if (!isAbsolute(raw)) throw new PlanningError('Klasör yolu tam (mutlak) olmalı, ör. C:\\CNC-Telemetri\\data\\kaynak');
    const dir = resolve(raw);
    let st;
    try { st = statSync(dir); } catch { throw new PlanningError(`Klasör bulunamadı ya da okunamıyor: ${dir}`, 400, 'no-dir'); }
    if (!st.isDirectory()) throw new PlanningError(`Bu bir klasör değil: ${dir}`, 400, 'no-dir');
    this.#db.setSetting(SETTING_DIR, dir);
    return this.config();
  }

  /** Varsayilan klasor henuz yoksa olusturur (kullanici dosyayi oraya koyabilsin). Ayarli klasor ASLA olusturulmaz. */
  #ensureDefault(dir) {
    if (dir && dir === this.defaultDir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Klasordeki aday dosyalar, ESKIDEN YENIYE (en yeni en son islenir). */
  #files(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('~$') || e.name.startsWith('.') || !EXTENSIONS.has(extname(e.name).toLowerCase())) continue;
      const path = join(dir, e.name);
      let st;
      try { st = statSync(path); } catch { continue; }
      out.push({ name: e.name, path, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
    out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    return out.slice(-MAX_FILES);
  }

  /**
   * Yenilemeden bakilan durum: klasor, dosyalar ve her birinin son iceri almaya gore durumu.
   * @returns {{dir: string|null, defaultDir: string|null, isDefault: boolean, exists: boolean, files: object[], pending: number, last: object|null}}
   */
  status() {
    const cfg = this.config();
    const base = { ...cfg, exists: false, files: [], pending: 0, last: this.#last() };
    if (!cfg.dir) return base;
    this.#ensureDefault(cfg.dir);
    if (!existsSync(cfg.dir)) return base;
    const files = this.#files(cfg.dir).map((f) => {
      const rec = this.#db.getSourceFile(f.path);
      const state = !rec ? 'yeni' : rec.size === f.size && rec.mtimeMs === f.mtimeMs ? 'ayni' : 'degisti';
      return { name: f.name, size: f.size, mtimeMs: f.mtimeMs, state, importedAt: rec?.importedAt ?? null };
    });
    return { ...base, exists: true, files, pending: files.filter((f) => f.state !== 'ayni').length };
  }

  #last() {
    const v = this.#db.getSetting(SETTING_LAST);
    return v ? JSON.parse(v) : null;
  }

  /**
   * Klasoru okur, degisen dosyalari iceri alir.
   * @param {{by?: string|null, force?: boolean, now?: number}} [opts] force: degismemis dosyalari da yeniden isle
   */
  refresh({ by = null, force = false, now = Date.now() } = {}) {
    if (this.busy) throw new PlanningError('Bir yenileme zaten sürüyor, bitmesini bekleyin.', 409, 'busy');
    this.busy = true;
    try {
      const dir = this.dir();
      if (!dir) throw new PlanningError('Kaynak klasörü ayarlanmadı. "Kaynak klasörü…" ile belirleyin.', 409, 'no-dir');
      this.#ensureDefault(dir);
      if (!existsSync(dir)) throw new PlanningError(`Kaynak klasörü bulunamadı: ${dir}`, 409, 'no-dir');

      const totals = emptyTotals();
      const changes = emptyChanges();
      const files = [];
      const candidates = this.#files(dir);
      for (const f of candidates) {
        const rec = this.#db.getSourceFile(f.path);
        const entry = { name: f.name, size: f.size, mtimeMs: f.mtimeMs, state: 'degismedi', parts: [], skippedSheets: [], error: null };
        files.push(entry);
        if (!force && rec && rec.size === f.size && rec.mtimeMs === f.mtimeMs) continue;
        if (f.size > MAX_BYTES) { entry.state = 'okunamadi'; entry.error = `Dosya çok büyük (en fazla ${Math.round(MAX_BYTES / 1048576)} MB).`; continue; }

        let buf;
        try { buf = readFileSync(f.path); } catch (err) {
          entry.state = 'okunamadi';
          entry.error = `Dosya okunamadı (başka bir program yazıyor ya da kilitlemiş olabilir): ${err.code ?? err.message}`;
          continue;
        }
        const sha256 = createHash('sha256').update(buf).digest('hex');
        if (!force && rec && rec.sha256 === sha256) {
          // yeniden kaydedilmis ama icerigi ayni: islenmez, yalniz zamani yenilenir
          this.#db.saveSourceFile(f.path, { size: f.size, mtimeMs: f.mtimeMs, sha256, importedAt: rec.importedAt, summary: rec.summary });
          continue;
        }

        let result;
        try {
          result = this.planning.importFile(buf, { filename: f.name, by, now, keepOld: true });
        } catch (err) {
          if (err.code === 'unrecognized') {
            // Bilinen hicbir bicime uymayan dosya (ilgisiz bir Excel): bir kez "atlandi" denir ve kaydedilir, degismedikce yeniden denenmez.
            entry.state = 'atlandi';
            entry.error = err.message;
            this.#db.saveSourceFile(f.path, { size: f.size, mtimeMs: f.mtimeMs, sha256, importedAt: now, summary: { unrecognized: true } });
            continue;
          }
          entry.state = 'okunamadi';
          entry.error = `${err.message}${/bozuk|kesik|ZIP|sağlama/i.test(err.message) ? ' Dosya şu an yazılıyor olabilir; biraz sonra yeniden deneyin.' : ''}`;
          continue; // kaydedilmez: bir sonraki yenilemede yeniden denenir
        }
        entry.state = 'islendi';
        const parts = result.format === 'xlsx' ? result.sheets : [result];
        entry.skippedSheets = result.format === 'xlsx' ? result.skippedSheets : [];
        entry.parts = parts.map((p) => ({
          sheet: p.sheet ?? null, format: p.format, totalRows: p.totalRows, added: p.added, updated: p.updated, unchanged: p.unchanged, skipped: p.skipped,
          products: p.products ?? null, warnings: p.warnings ?? [],
        }));
        for (const p of parts) this.#accumulate(totals, changes, p);
        this.#db.saveSourceFile(f.path, { size: f.size, mtimeMs: f.mtimeMs, sha256, importedAt: now, summary: { parts: entry.parts.map(({ sheet, format, added, updated }) => ({ sheet, format, added, updated })) } });
      }

      const processed = files.filter((f) => f.state === 'islendi').length;
      const last = { at: now, by, files: files.length, processed, totals };
      this.#db.setSetting(SETTING_LAST, JSON.stringify(last));
      return {
        dir, at: now, force, files, totals, changes, processed, unchanged: files.filter((f) => f.state === 'degismedi').length,
        skipped: files.filter((f) => f.state === 'atlandi').length, failed: files.filter((f) => f.state === 'okunamadi').length,
      };
    } finally {
      this.busy = false;
    }
  }

  /** Bir sayfanin sonucunu toplamlara ve "ne degisti" listelerine katar. */
  #accumulate(totals, changes, p) {
    if (p.format === 'siparis') {
      totals.lines.added += p.added; totals.lines.updated += p.updated;
      totals.products.added += p.products?.added ?? 0; totals.products.updated += p.products?.updated ?? 0;
      addCapped(changes.lines.added, p.changes?.lines?.added); addCapped(changes.lines.updated, p.changes?.lines?.updated);
      addCapped(changes.products.added, p.changes?.products?.added); addCapped(changes.products.updated, p.changes?.products?.updated);
      addCapped(changes.products.protected, p.changes?.products?.protected);
      totals.products.protected += p.protectedCards ?? 0;
    } else if (p.format === 'isemri') {
      totals.products.added += p.products?.added ?? 0; totals.products.updated += p.products?.updated ?? 0;
      addCapped(changes.products.added, p.changes?.products?.added); addCapped(changes.products.updated, p.changes?.products?.updated);
    } else if (p.format === 'gkk') {
      totals.gkk.added += p.added; totals.gkk.updated += p.updated;
      addCapped(changes.gkk.added, p.changes?.added); addCapped(changes.gkk.updated, p.changes?.updated);
    } else if (p.format === 'ilkonay') {
      totals.approvals.added += p.added; totals.approvals.updated += p.updated;
      addCapped(changes.approvals.added, p.changes?.added); addCapped(changes.approvals.updated, p.changes?.updated);
    } else if (p.format === 'stok') {
      // Depo stogu (F): tam degistirme, gecmis tutulmaz -> yalniz sayilar, satir bazli "ne degisti" listesi yok.
      totals.stock.added += p.added; totals.stock.updated += p.updated; totals.stock.removed += p.removed ?? 0;
    }
  }
}
