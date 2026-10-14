/**
 * Kalite kayıtları: GKK rapor numarası takibi (EYS.FR.011), ilk onay raporu / numune takip listesi (EYS.FR.013) ve iş emrinin teknik resim PDF'leri.
 *
 *   GKK        ustalar iş emrinin hammaddesi için GK numarasını buradan bulup iş emrine yazar (iş emrinin ERP hammadde koduyla eşleşenler önerilir)
 *   İlk onay   ilk parça yapılıp ölçülünce usta tezgah başında numara alır (İ26-1281); kayıt ürün, GK kodu, iş emri, tarih, operatör ve CNC no'yu taşır,
 *              iş emrinin "ilk onay rapor no" alanı kendiliğinden yazılır
 *   Çizimler   iş emrine yüklenen PDF'ler; formun arka sayfası için tek PDF'te birleştirilir (pdf-merge.js)
 */
import { createHash } from 'node:crypto';
import { PlanningError } from './errors.js';
import { QualityDb } from './quality-db.js';
import { parseGkNo, formatGkNo, compactKey, matchMaterials, compareMaterials, readGkkSheet } from './gkk.js';
import { parseApprovalCode, formatApprovalCode, readApprovalSheet } from './first-approval.js';
import { parseDate } from './normalize.js';
import { machineNumber } from './calc.js';
import { inspectPdf, mergePdfs, PdfError } from '../pdf-merge.js';

/** Bir iş emrine en çok bu kadar çizim; her biri en çok bu kadar bayt. */
export const MAX_DRAWINGS = 8;
export const MAX_DRAWING_BYTES = 20 * 1024 * 1024;

function text(value, label, max) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  if (t === '') return null;
  if (t.length > max) throw new PlanningError(`${label} en fazla ${max} karakter olabilir.`);
  return t;
}

/** ms / 'yyyy-aa-gg' / 'gg.aa.yyyy' → yerel gece yarısı (ms) | null; geçersizse hata. */
function day(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : parseDate(value);
  if (!Number.isFinite(ms)) throw new PlanningError(`${label} gg.aa.yyyy ya da yyyy-aa-gg olmalı.`);
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const localMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

export class Quality {
  /** @param {{planning: import('./planning.js').Planning, db: import('node:sqlite').DatabaseSync}} deps */
  constructor({ planning, db }) {
    this.planning = planning;
    this.db = new QualityDb(db);
    /** Birleştirilmiş çizim PDF'i önbelleği: iş emri → {key, buffer, pages} (en çok 16 iş emri). */
    this.mergeCache = new Map();
  }

  /* ================================================================== GKK rapor numaraları */

  /** Sıradaki GK numarası: bu yıl kullanılan en büyük sıra + 1 (ya da elle verilen taban). */
  gkkNext(now = Date.now()) {
    const year = new Date(now).getFullYear();
    const max = this.db.gkkMaxSeq(year);
    const floor = this.db.floor('gkk', year);
    const seq = Math.max(max, floor) + 1;
    return { year, seq, no: formatGkNo(year, seq), floor, max };
  }

  /**
   * Liste + arama. `erpMaterial` (iş emrinin hammadde kodu) ve/veya `stockCode` verilirse `matches` o iş emri için öne çıkan kayıtları
   * (tam / aynı ölçü işlem farklı / dövme ürün) sınıflı verir; ustalar numarayı oradan seçer.
   */
  listGkk({ q = '', erpMaterial = '', stockCode = '', limit = 300, offset = 0 } = {}, { now = Date.now() } = {}) {
    const rows = this.db.gkkSearch(q).sort((a, b) => compareMaterials(a.material, b.material) || b.year - a.year || b.seq - a.seq);
    let matches = [];
    if (erpMaterial !== '' || stockCode !== '') {
      matches = matchMaterials(this.db.gkkAll(), { erpMaterial: erpMaterial || null, stockCode: stockCode || null })
        .slice(0, 30).map(({ id, kind }) => ({ ...this.db.gkkGet(id), match: kind }));
    }
    return { total: rows.length, count: this.db.gkkCount(), items: rows.slice(offset, offset + limit), matches, next: this.gkkNext(now) };
  }

  #gkkFields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('material')) {
      const material = text(input.material, 'Hammadde cinsi', 80);
      if (!material) throw new PlanningError('Hammadde cinsi gerekli (ör. AA24 X 13 - PB3).');
      out.material = material.replace(/\s+/g, ' ');
    }
    if (has('reportNo') && String(input.reportNo ?? '').trim() !== '') {
      const no = parseGkNo(input.reportNo);
      if (!no) throw new PlanningError('Rapor numarası GK26.396 biçiminde olmalı (GK + yıl 2 hane + nokta + sıra).');
      out.reportNo = no.no; out.year = no.year; out.seq = no.seq;
    }
    if (has('producerDate')) out.producerDate = day(input.producerDate, 'Üretici rapor tarihi');
    if (has('note')) out.note = text(input.note, 'Açıklama', 200);
    if (has('sortNo')) out.sortNo = input.sortNo === null || input.sortNo === '' ? null : Number.isInteger(Number(input.sortNo)) && Number(input.sortNo) > 0 ? Number(input.sortNo) : (() => { throw new PlanningError('Sıra pozitif tam sayı olmalı.'); })();
    return out;
  }

  createGkk(input, { by = null, now = Date.now() } = {}) {
    const f = this.#gkkFields(input);
    if (!f.reportNo) { const nx = this.gkkNext(now); f.reportNo = nx.no; f.year = nx.year; f.seq = nx.seq; }
    if (this.db.gkkFind(compactKey(f.reportNo), compactKey(f.material))) {
      throw new PlanningError(`${f.reportNo} numarası bu hammadde için zaten kayıtlı.`, 409, 'duplicate');
    }
    const id = this.db.gkkInsert(f, { by, now });
    return this.db.gkkGet(id);
  }

  updateGkk(id, input, { by = null, now = Date.now() } = {}) {
    const cur = this.db.gkkGet(Number(id));
    if (!cur) throw new PlanningError('GKK kaydı bulunamadı.', 404);
    const f = this.#gkkFields(input, { partial: true });
    const next = { ...cur, ...f };
    const other = this.db.gkkFind(compactKey(next.reportNo), compactKey(next.material));
    if (other && other.id !== cur.id) throw new PlanningError(`${next.reportNo} numarası bu hammadde için zaten kayıtlı.`, 409, 'duplicate');
    this.db.gkkUpdate(cur.id, next, { by, now });
    return this.db.gkkGet(cur.id);
  }

  deleteGkk(id) {
    if (!this.db.gkkGet(Number(id))) throw new PlanningError('GKK kaydı bulunamadı.', 404);
    this.db.gkkDelete(Number(id));
    return { ok: true };
  }

  /** "En son verilen GK numarası" tabanı (listede kaydı olmayan, kâğıtta verilmiş numaralar için). */
  setGkkSequence(last) {
    const no = parseGkNo(last);
    if (!no) throw new PlanningError('Numara GK26.396 biçiminde olmalı.');
    const max = this.db.gkkMaxSeq(no.year);
    if (no.seq < max) throw new PlanningError(`Bu yıl için ${formatGkNo(no.year, max)} numarasına kadar zaten kayıt var.`, 409);
    this.db.raiseFloor('gkk', no.year, no.seq);
    return this.gkkNext(new Date(no.year, 5, 1).getTime());
  }

  /* ============================================================= ilk onay raporu / numune takip */

  approvalNext(now = Date.now()) {
    const year = new Date(now).getFullYear();
    const max = this.db.approvalMaxSeq(year);
    const floor = this.db.floor('ilkonay', year);
    const seq = Math.max(max, floor) + 1;
    return { year, seq, code: formatApprovalCode(year, seq), floor, max };
  }

  listApprovals({ q = '', year = null, limit = 200, offset = 0 } = {}, { now = Date.now() } = {}) {
    return { ...this.db.approvalList({ q, year: year || null, limit, offset }), next: this.approvalNext(now), years: this.db.approvalYears() };
  }

  /**
   * Yeni ilk onay kodu verir. `woNo` verilirse ürün, GK kodu, tezgah iş emrinden gelir ve iş emrinin "ilk onay rapor no" alanı yazılır
   * (usta tezgah başında bunu yapar). Aynı iş emrine daha önce kod verilmişse 409 `exists` (ürün değişimi vb. için `again: true` ile yeniden alınır).
   * `woNo` yoksa (yönetici, elle) ürün kodu gerekir.
   */
  createApproval(input, { by = null, now = Date.now() } = {}) {
    const woNo = text(input.woNo, 'İş emri no', 20);
    let w = null;
    if (woNo) {
      w = this.planning.db.getWorkOrder(woNo);
      if (!w) throw new PlanningError(`İş emri bulunamadı: ${woNo}`, 404);
      if (w.status === 'iptal') throw new PlanningError('İptal edilmiş iş emri için ilk onay alınamaz.', 409, 'cancelled');
      const existing = this.db.approvalsOfWo(w.no);
      if (existing.length > 0 && input.again !== true) {
        throw new PlanningError(`Bu iş emri için zaten ilk onay kodu verilmiş: ${existing.map((x) => x.code).join(', ')}. Yeni bir kod gerekiyorsa onaylayın.`, 409, 'exists');
      }
    }
    const stockCode = text(input.stockCode, 'Ürün kodu', 40) ?? w?.stockCode ?? null;
    if (!stockCode) throw new PlanningError('Ürün kodu gerekli.');
    const gk = text(input.gkCode, 'GK kodu', 40);
    const gkCode = gk ? (parseGkNo(gk)?.no ?? gk) : (w?.gkkReportNo ? (parseGkNo(w.gkkReportNo)?.no ?? w.gkkReportNo) : null);
    const operator = text(input.person ?? input.operator, 'Operatör', 60);
    const approvedOn = day(input.approvedOn, 'Tarih') ?? localMidnight(now);
    const machineId = text(input.machineId, 'Tezgah', 20) ?? w?.machineId ?? null;
    const nx = this.approvalNext(now);
    const id = this.db.approvalInsert({ code: nx.code, year: nx.year, seq: nx.seq, stockCode, gkCode, woNo: w?.no ?? null, approvedOn, operator, machineId, note: text(input.note, 'Not', 200) }, { by, now });
    if (w) {
      try {
        this.planning.updateWorkOrder(w.no, { firstApprovalNo: nx.code }, { by, now });
      } catch (err) {
        this.db.approvalDelete(id); // iş emri yazılamadıysa numara boşa gitmesin
        throw err;
      }
    }
    return this.#approvalView(this.db.approvalGet(id));
  }

  #approvalView(a) {
    return a ? { ...a, cncNo: machineNumber(a.machineId) } : a;
  }

  updateApproval(id, input, { by = null, now = Date.now() } = {}) {
    const cur = this.db.approvalGet(Number(id));
    if (!cur) throw new PlanningError('İlk onay kaydı bulunamadı.', 404);
    const has = (k) => Object.hasOwn(input, k);
    const next = { ...cur };
    if (has('stockCode')) next.stockCode = text(input.stockCode, 'Ürün kodu', 40);
    if (has('gkCode')) { const g = text(input.gkCode, 'GK kodu', 40); next.gkCode = g ? (parseGkNo(g)?.no ?? g) : null; }
    if (has('woNo')) next.woNo = text(input.woNo, 'İş emri no', 20);
    if (has('approvedOn')) next.approvedOn = day(input.approvedOn, 'Tarih');
    if (has('operator')) next.operator = text(input.operator, 'Operatör', 60);
    if (has('machineId')) next.machineId = text(input.machineId, 'Tezgah', 20);
    if (has('note')) next.note = text(input.note, 'Not', 200);
    this.db.approvalUpdate(cur.id, next, { by, now });
    return this.#approvalView(this.db.approvalGet(cur.id));
  }

  deleteApproval(id, { by = null, now = Date.now() } = {}) {
    const cur = this.db.approvalGet(Number(id));
    if (!cur) throw new PlanningError('İlk onay kaydı bulunamadı.', 404);
    this.db.approvalDelete(cur.id);
    // iş emrinde hâlâ bu kod yazılıysa boşalt (bağlantısız numara kalmasın)
    const w = cur.woNo ? this.planning.db.getWorkOrder(cur.woNo) : null;
    if (w && w.firstApprovalNo === cur.code && w.status !== 'iptal') this.planning.updateWorkOrder(w.no, { firstApprovalNo: null }, { by, now });
    return { ok: true };
  }

  setApprovalSequence(last) {
    const c = parseApprovalCode(last);
    if (!c) throw new PlanningError('Kod İ26-1281 biçiminde olmalı.');
    const max = this.db.approvalMaxSeq(c.year);
    if (c.seq < max) throw new PlanningError(`Bu yıl için ${formatApprovalCode(c.year, max)} koduna kadar zaten kayıt var.`, 409);
    this.db.raiseFloor('ilkonay', c.year, c.seq);
    return this.approvalNext(new Date(c.year, 5, 1).getTime());
  }

  /** Bir iş emrine verilmiş ilk onay kayıtları (iş emri ayrıntısında gösterilir). */
  approvalsOfWo(woNo) {
    return this.db.approvalsOfWo(woNo).map((a) => this.#approvalView(a));
  }

  /* ======================================================================== CSV içeri alma */

  /** FR.011 sayfası (GKK rapor numaraları). @returns {object} içeri alma sonucu */
  importGkk(parsed, { warn, now = Date.now(), by = null }) {
    const { records, freeNumbers, skipped } = readGkkSheet(parsed, warn);
    const tally = { added: 0, updated: 0, unchanged: 0 };
    this.planning.db.tx(() => {
      for (const r of records) {
        const cur = this.db.gkkFind(compactKey(r.reportNo), compactKey(r.material));
        if (!cur) {
          this.db.gkkInsert({ reportNo: r.reportNo, year: r.year, seq: r.seq, material: r.material, producerDate: r.producerDate, note: r.note, sortNo: r.sortNo }, { by, now });
          tally.added += 1;
          continue;
        }
        // dosyadaki dolu değerler güncellenir; dosyada boş olan mevcut değeri silmez
        const next = { ...cur, producerDate: r.producerDate ?? cur.producerDate, note: r.note ?? cur.note, sortNo: r.sortNo ?? cur.sortNo };
        const changed = next.producerDate !== cur.producerDate || next.note !== cur.note || next.sortNo !== cur.sortNo;
        if (changed) { this.db.gkkUpdate(cur.id, next, { by, now }); tally.updated += 1; } else tally.unchanged += 1;
      }
    });
    return { totalRows: records.length, skipped, freeNumbers, ...tally, next: this.gkkNext(now) };
  }

  /** FR.013 sayfası (ilk onay listesi). */
  importApprovals(parsed, { warn, now = Date.now(), by = null }) {
    const { records, firstBlank, skipped } = readApprovalSheet(parsed, warn);
    const tally = { added: 0, updated: 0, unchanged: 0 };
    const maxFilled = new Map();
    this.planning.db.tx(() => {
      for (const r of records) {
        maxFilled.set(r.year, Math.max(maxFilled.get(r.year) ?? 0, r.seq));
        const cur = this.db.approvalByCode(r.code);
        if (!cur) { this.db.approvalInsert(r, { by, now }); tally.added += 1; continue; }
        const next = {
          ...cur, stockCode: r.stockCode ?? cur.stockCode, gkCode: r.gkCode ?? cur.gkCode, woNo: r.woNo ?? cur.woNo, approvedOn: r.approvedOn ?? cur.approvedOn,
          operator: r.operator ?? cur.operator, machineId: r.machineId ?? cur.machineId,
        };
        const same = ['stockCode', 'gkCode', 'woNo', 'approvedOn', 'operator', 'machineId'].every((k) => (next[k] ?? null) === (cur[k] ?? null));
        if (same) tally.unchanged += 1; else { this.db.approvalUpdate(cur.id, next, { by, now }); tally.updated += 1; }
      }
      // sıradaki numara: kullanılmış en büyük kod ile önceden basılmış ilk BOŞ kodun bir öncesi
      const years = new Set([...maxFilled.keys(), ...firstBlank.keys()]);
      for (const y of years) this.db.raiseFloor('ilkonay', y, Math.max(maxFilled.get(y) ?? 0, (firstBlank.get(y) ?? 1) - 1));
    });
    return { totalRows: records.length, skipped, ...tally, next: this.approvalNext(now) };
  }

  /* =============================================================== teknik resimler (PDF) */

  listDrawings(woNo) {
    return this.db.drawingsOfWo(woNo).map(({ sha, ...d }) => d);
  }

  /**
   * İş emrine PDF ekler (yalnız yönetici). Geçerli, şifresiz, sayfası olan PDF olmalı; aynı dosya aynı iş emrine ikinci kez eklenmez.
   * @param {string} woNo @param {{name?: string, data: Buffer}} file
   */
  addDrawing(woNo, { name, data }, { by = null, now = Date.now() } = {}) {
    const w = this.planning.db.getWorkOrder(woNo);
    if (!w) throw new PlanningError(`İş emri bulunamadı: ${woNo}`, 404);
    if (w.status === 'iptal') throw new PlanningError('İptal edilmiş iş emrine çizim eklenemez.', 409, 'cancelled');
    if (!Buffer.isBuffer(data) || data.length === 0) throw new PlanningError('Dosya boş.');
    if (data.length > MAX_DRAWING_BYTES) throw new PlanningError(`PDF çok büyük (en fazla ${Math.round(MAX_DRAWING_BYTES / 1048576)} MB).`, 413);
    const have = this.db.drawingsOfWo(w.no);
    if (have.length >= MAX_DRAWINGS) throw new PlanningError(`Bir iş emrine en çok ${MAX_DRAWINGS} PDF eklenebilir.`, 409, 'too-many');
    let info;
    try { info = inspectPdf(data); } catch (err) {
      if (err instanceof PdfError) throw new PlanningError(`PDF kabul edilmedi: ${err.message}`, 422, 'bad-pdf');
      throw err;
    }
    const sha = createHash('sha256').update(data).digest('hex');
    if (have.some((d) => d.sha === sha)) throw new PlanningError('Bu PDF zaten ekli.', 409, 'duplicate');
    const clean = (String(name ?? '').split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || `${w.stockCode}-resim.pdf`;
    this.db.addDrawing(w.no, { name: clean, sha, size: data.length, pages: info.pages, data }, { by, now });
    this.planning.db.addWorkOrderEvent(w.no, 'cizim-eklendi', `${clean} (${info.pages} sayfa, ${Math.round(data.length / 1024)} KB)`, { by, now });
    return this.listDrawings(w.no);
  }

  deleteDrawing(woNo, id, { by = null, now = Date.now() } = {}) {
    const d = this.db.drawingGet(Number(id));
    if (!d || d.woNo !== woNo) throw new PlanningError('Çizim bulunamadı.', 404);
    this.db.deleteDrawing(d.id);
    this.planning.db.addWorkOrderEvent(woNo, 'cizim-silindi', d.name, { by, now });
    return this.listDrawings(woNo);
  }

  /** Aynı ürünün en son çizimli iş emrinin çizimlerini yeni iş emrine bağlar (dosya kopyalanmaz). */
  inheritDrawings(newNo, codeKey, { by = null, now = Date.now() } = {}) {
    for (const d of this.db.drawingsOfLatestOrderOf(codeKey, newNo)) this.db.linkDrawing(newNo, d, { by, now });
  }

  /**
   * İş emrinin tüm çizimleri TEK PDF'te (formun arka sayfası). Çizim yoksa null. Birleştirme pahalı olabildiği için dosya kümesine göre önbelleğe alınır.
   * @returns {{buffer: Buffer, pages: number, count: number}|null}
   */
  mergedDrawings(woNo) {
    const list = this.db.drawingsOfWo(woNo);
    if (list.length === 0) return null;
    const key = list.map((d) => d.sha).join('+');
    const hit = this.mergeCache.get(woNo);
    if (hit?.key === key) return hit.value;
    const buffers = this.db.drawingBuffersOfWo(woNo);
    let buffer;
    try { buffer = mergePdfs(buffers); } catch (err) {
      if (err instanceof PdfError) throw new PlanningError(`Çizimler birleştirilemedi: ${err.message}`, 422, 'merge-failed');
      throw err;
    }
    const value = { buffer, pages: list.reduce((s, d) => s + d.pages, 0), count: list.length };
    this.mergeCache.delete(woNo);
    this.mergeCache.set(woNo, { key, value });
    if (this.mergeCache.size > 16) this.mergeCache.delete(this.mergeCache.keys().next().value);
    return value;
  }
}
