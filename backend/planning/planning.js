/**
 * Planlama modulu (iki urunden ikincisi): urun kartlari, siparisler, program <-> urun eslemesi. Is emri, hammadde ve verimlilik
 * sonraki asamalarda bu temel uzerine kurulur (bkz. PLANLAMA-TASARIM.md).
 *
 * Telemetri kodunu IMPORT ETMEZ: tornalarda gorulen program adlari disaridan verilen `listSeenPrograms()` ile gelir
 * (program kutuphanesiyle ayni ayrim). Tum uclar yalniz yonetici icindir (izin tablosunda varsayilan reddet).
 */
import { PlanningDb } from './planning-db.js';
import { PlanningError } from './errors.js';
import { Quality } from './quality.js';
import { buildWorkOrderFormPdf } from './wo-form-pdf.js';
import { parseSteps, parseReject, stepsToColumns, stepsText } from './card-steps.js';
import { mergePdfs, PdfError } from '../pdf-merge.js';
import { importFile } from './importers.js';
import { foldTr, cleanCode, parseDate } from './normalize.js';
import { programKey, suggestProducts } from './program-map.js';
import { rawMaterial, plannedHours, machineNumber } from './calc.js';
import { computeProgress } from './progress.js';
import { buildStops, attachReasons, DEFAULT_MIN_STOP_MS } from './downtime.js';
import { shiftOf, dateKey, parseDateKey, addDays, daysBetween } from '../../shared/shifts.js';
import { consumptionOf, groupByMaterial } from './material.js';
import { csvDocument } from '../csv.js';
import { orderSegments, summarize, matrixRows, productRows, dayRows, splitByShift } from './efficiency.js';
import { slotOf, slotPosition, parseValue, normalizePlan, evaluate, limits, CHECK_KINDS, CHECK_LABEL, SLOT_MIN } from './measure.js';

export { PlanningError };

const fmtTime = (ms) => new Date(ms).toLocaleString('tr-TR', { hour12: false });
const STOCK_CODE = /^[^\s/\\;,]{1,40}$/;

/** Bos metin -> null, ayrica uzunluk siniri. */
function text(value, label, max) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  if (t === '') return null;
  if (t.length > max) throw new PlanningError(`${label} en fazla ${max} karakter olabilir.`);
  return t;
}

/** Bos -> null; sayi degilse ya da aralik disindaysa hata. */
function number(value, label, { max }) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new PlanningError(`${label} 0 ile ${max} arasında bir sayı olmalı.`);
  return n;
}

/** API alanlari -> dogrulanmis urun alanlari. Verilmeyen alan sonuca girmez (guncellemede dokunulmaz). */
function productFields(input) {
  const out = {};
  const has = (k) => Object.hasOwn(input, k);
  if (has('name')) out.name = text(input.name, 'Ürün adı', 200);
  if (has('customerCode')) out.customerCode = input.customerCode == null ? null : text(cleanCode(input.customerCode), 'Müşteri ürün kodu', 40);
  if (has('material')) out.material = text(input.material, 'Hammadde', 80);
  if (has('altMaterial')) out.altMaterial = text(input.altMaterial, 'Alternatif hammadde', 80);
  if (has('note')) out.note = text(input.note, 'Not', 500);
  if (has('lengthMm')) out.lengthMm = number(input.lengthMm, 'Tam boy (mm)', { max: 10000 });
  if (has('netKg')) out.netKg = number(input.netKg, 'Net ağırlık (kg)', { max: 100 });
  if (has('grossKg')) out.grossKg = number(input.grossKg, 'Brüt ağırlık (kg)', { max: 100 });
  if (has('plannedSec')) out.plannedSec = number(input.plannedSec, 'Planlanan süre (sn)', { max: 36000 });
  return out;
}

/** Tezgah basindan (operator) duzenlenebilen is emri alanlari. */
export const OPERATOR_EDIT_FIELDS = new Set(['usedMaterial', 'gkkReportNo', 'firstApprovalNo', 'measuredNetKg', 'note']);

export class Planning {
  /**
   * @param {{dbFile?: string, listSeenPrograms?: () => {program: string, parts: number, machines: string[], lastTs: number|null}[],
   *          listMachines?: () => {id: string, name?: string}[],
   *          productionEvents?: (machineId: string, fromMs: number, toMs: number) => {ts: number, program: string|null, qty: number, cycleSec: number|null, gapMs: number, suspect: boolean}[],
   *          liveMachine?: (machineId: string) => {connected: boolean, state: string|null, program: string|null, partTotal: number|null}|null}} [opts]
   *   listMachines: is emrine atanabilecek tezgahlar (envanter). productionEvents / liveMachine: telemetri (gerceklesen adet, canli durum);
   *   Telemetri kodu import edilmez, server.js bu islevleri baglar.
   *   spans: tezgahin durum araliklari (olculmus duruslar icin); downtimeConfig: {groups, codes} (config/downtime-codes.json);
   *   downtimeMinMs: bundan kisa duruslar sorulmaz.
   */
  constructor({
    dbFile = 'data/planlama.db', listSeenPrograms = () => [], listMachines = () => [], productionEvents = () => [], liveMachine = () => null,
    spans = () => [], downtimeConfig = { groups: [], codes: [] }, downtimeMinMs = DEFAULT_MIN_STOP_MS,
  } = {}) {
    this.db = new PlanningDb(dbFile);
    /** GKK rapor numaralari, ilk onay raporlari ve teknik resimler (ayni veritabani dosyasi). */
    this.quality = new Quality({ planning: this, db: this.db.db });
    this.listSeenPrograms = listSeenPrograms;
    this.listMachines = listMachines;
    this.productionEvents = productionEvents;
    this.liveMachine = liveMachine;
    this.spans = spans;
    this.downtimeGroups = downtimeConfig.groups ?? [];
    this.downtimeMinMs = downtimeMinMs;
    if ((downtimeConfig.codes ?? []).length > 0) this.db.syncDowntimeCodes(downtimeConfig.codes);
  }

  summary() {
    return {
      ...this.db.stats(),
      lastImports: this.db.lastBatches(5),
      seenPrograms: this.listPrograms().counts,
      machines: this.listMachines().map((m) => ({ id: m.id, name: m.name ?? m.id })),
      nextWorkOrder: this.nextWorkOrderNo(),
    };
  }

  /* -------------------------------------------------------------- iceri alma */

  /** Excel'den CSV ya da .xlsx (dosya turu içerikten anlaşılır; .xlsx'te tüm sayfalar taranır). */
  importFile(buffer, opts) {
    return importFile(this.db, buffer, { ...opts, quality: this.quality });
  }

  /** Eski ad (testler): `importFile` ile aynı. */
  importCsv(buffer, opts) {
    return this.importFile(buffer, opts);
  }

  /* ----------------------------------------------------------------- urunler */

  listProducts(query) {
    return this.db.listProducts(query);
  }

  getProduct(stockCode) {
    const p = this.db.getProduct(foldTr(stockCode));
    if (!p) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
    return { ...p, programs: this.db.programsOfProduct(p.codeKey) };
  }

  createProduct(input, { by = null } = {}) {
    const stockCode = String(input?.stockCode ?? '').trim();
    if (!STOCK_CODE.test(stockCode)) throw new PlanningError('Stok kodu 1–40 karakter olmalı; boşluk, virgül, noktalı virgül ve eğik çizgi içeremez.');
    const key = foldTr(stockCode);
    if (this.db.getProduct(key)) throw new PlanningError(`Bu stok kodu zaten var: ${stockCode}`, 409, 'exists');
    const fields = productFields(input);
    this.#checkWeights(fields);
    return this.db.saveProduct(key, { stockCode, ...fields }, { source: 'elle', by, edited: true });
  }

  updateProduct(stockCode, input, { by = null } = {}) {
    const key = foldTr(stockCode);
    const cur = this.db.getProduct(key);
    if (!cur) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
    const fields = productFields(input);
    this.#checkWeights({ netKg: 'netKg' in fields ? fields.netKg : cur.netKg, grossKg: 'grossKg' in fields ? fields.grossKg : cur.grossKg });
    // Elle duzenleme: iceri alma bu kartin dolu alanlarini bir daha ezmez.
    return this.db.saveProduct(key, fields, { source: cur.source, by, edited: true });
  }

  #checkWeights({ netKg, grossKg }) {
    if (netKg != null && grossKg != null && netKg > grossKg) {
      throw new PlanningError('Net ağırlık brüt ağırlıktan büyük olamaz (dara = brüt − net).');
    }
  }

  /* --------------------------------------------------------------- siparisler */

  searchOrders(query) {
    return this.db.searchOrders(query);
  }

  orderLines(keys) {
    return this.db.orderLines(keys);
  }

  /* ---------------------------------------------------------- program eslemesi */

  #lookup() {
    return {
      productByCodeKey: (k) => this.db.getProduct(k),
      productsByCustomerCode: (c) => this.db.productsByCustomerCode(c),
      productsByNamePrefix: (p) => this.db.productsByNamePrefix(p),
    };
  }

  /**
   * Tornalarda parca uretmis programlar + esleme durumu. Durum: 'esli' (urune bagli), 'oneri' (kural bir urun/urunler buldu,
   * onay bekliyor), 'yok' (oneri yok, elle secilmeli).
   */
  listPrograms() {
    // Ayni program farkli yazimlarla (buyuk/kucuk) gelmis olabilir: katlanmis anahtarla birlestirilir.
    const merged = new Map();
    for (const s of this.listSeenPrograms()) {
      const key = programKey(s.program);
      const cur = merged.get(key);
      if (!cur) merged.set(key, { program: s.program, parts: s.parts ?? 0, machines: new Set(s.machines ?? []), lastTs: s.lastTs ?? null, seen: true });
      else {
        cur.parts += s.parts ?? 0;
        for (const m of s.machines ?? []) cur.machines.add(m);
        cur.lastTs = Math.max(cur.lastTs ?? 0, s.lastTs ?? 0) || null;
      }
    }
    const map = this.db.getProgramMap();
    for (const [key, m] of map) {
      if (!merged.has(key)) merged.set(key, { program: m.programName, parts: 0, machines: new Set(), lastTs: null, seen: false });
    }

    const lookup = this.#lookup();
    const rows = [...merged.entries()].map(([key, p]) => {
      const mapped = map.get(key);
      const base = { programKey: key, program: p.program, parts: p.parts, machines: [...p.machines].sort(), lastTs: p.lastTs, seen: p.seen };
      if (mapped) {
        return { ...base, status: 'esli', mapped: { stockCode: mapped.stockCode, productName: mapped.productName, source: mapped.source }, suggestions: [] };
      }
      const sug = suggestProducts(p.program, lookup);
      const candidates = sug.candidates.slice(0, 8).map((c) => ({ stockCode: c.stockCode, name: c.name }));
      return { ...base, status: sug.kind ? 'oneri' : 'yok', mapped: null, suggestionKind: sug.kind, suggestions: candidates };
    });
    const order = { oneri: 0, yok: 1, esli: 2 };
    rows.sort((a, b) => order[a.status] - order[b.status] || b.parts - a.parts || a.program.localeCompare(b.program, 'tr'));
    const counts = { total: rows.length, mapped: 0, suggested: 0, unmatched: 0 };
    for (const r of rows) counts[r.status === 'esli' ? 'mapped' : r.status === 'oneri' ? 'suggested' : 'unmatched'] += 1;
    return { programs: rows, counts };
  }

  /** Programi urune baglar. Onerilen urunlerden biriyse kaynak 'oneri-onay', degilse 'elle'. */
  mapProgram(programName, stockCode, { by = null } = {}) {
    const name = String(programName ?? '').trim();
    if (name === '' || name.length > 80) throw new PlanningError('Program adı 1–80 karakter olmalı.');
    const product = this.db.getProduct(foldTr(stockCode));
    if (!product) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
    const sug = suggestProducts(name, this.#lookup());
    const source = sug.candidates.some((c) => c.codeKey === product.codeKey) ? 'oneri-onay' : 'elle';
    this.db.setProgramMap(programKey(name), name, product.codeKey, { source, by });
    return { program: name, stockCode: product.stockCode, source };
  }

  unmapProgram(programName) {
    if (!this.db.deleteProgramMap(programKey(programName))) throw new PlanningError('Bu program için eşleme yok.', 404);
  }

  /** Belirsizlik olmayan (tek ve kesin: stok koduyla birebir) onerilerin hepsini onaylar. */
  confirmExactSuggestions({ by = null } = {}) {
    let n = 0;
    for (const row of this.listPrograms().programs) {
      if (row.status === 'oneri' && row.suggestionKind === 'kod' && row.suggestions.length === 1) {
        this.mapProgram(row.program, row.suggestions[0].stockCode, { by });
        n += 1;
      }
    }
    return n;
  }

  /* -------------------------------------------------------------- is emirleri */

  /** Siradaki is emri numarasi (yil + 6 haneli sira, ör. 2026001055). */
  nextWorkOrderNo(now = Date.now()) {
    const year = new Date(now).getFullYear();
    const info = this.db.seqInfo(year);
    return { no: `${year}${String(info.next).padStart(6, '0')}`, year, floor: info.floor, max: info.max };
  }

  /**
   * Numara tabanini ayarlar: Excel'de EN SON verilen is emri numarasi (ör. 2026001109): yeni numaralar ondan devam eder.
   * Kucultulemez; bu uygulamada bu yila zaten daha buyuk numara verildiyse reddedilir.
   */
  setWorkOrderSequence(last, { now = Date.now() } = {}) {
    const digits = String(last ?? '').trim();
    if (!/^\d{10}$/.test(digits)) throw new PlanningError('Numara 10 haneli olmalı: yıl + 6 haneli sıra (ör. 2026001109).');
    const year = Number(digits.slice(0, 4));
    const seq = Number(digits.slice(4));
    if (year < 2000 || year > 2100) throw new PlanningError('Yıl 2000–2100 arasında olmalı.');
    const info = this.db.seqInfo(year);
    if (seq < info.max) throw new PlanningError(`Bu yıl için ${year}${String(info.max).padStart(6, '0')} numarasına kadar zaten iş emri verilmiş.`, 409);
    this.db.raiseSeqFloor(year, seq);
    return this.nextWorkOrderNo(new Date(year, 5, 1).getTime());
  }

  #machine(value) {
    const id = String(value ?? '').trim();
    if (id === '') throw new PlanningError('Tezgah seçilmedi.');
    const known = this.listMachines().map((m) => m.id);
    if (known.length > 0 ? !known.includes(id) : !/^[A-Za-z0-9._-]{1,20}$/.test(id)) throw new PlanningError(`Bilinmeyen tezgah: ${id}`);
    return id;
  }

  /** Is emri alan dogrulamalari (olusturma ve guncelleme ortak). Yalniz verilen anahtarlar sonuca girer. */
  #woFields(input) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    const int = (v, label, min, max) => {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isInteger(n) || n < min || n > max) throw new PlanningError(`${label} ${min} ile ${max} arasında bir tam sayı olmalı.`);
      return n;
    };
    if (has('targetQty')) out.targetQty = int(input.targetQty, 'Hedef adet', 1, 10_000_000);
    if (has('sampleQty')) out.sampleQty = input.sampleQty === null || input.sampleQty === '' ? null : int(input.sampleQty, 'Numune adedi', 1, 10_000_000);
    if (has('dueDate')) {
      const v = input.dueDate;
      if (v === null || v === '') out.dueDate = null;
      else {
        const ms = typeof v === 'number' ? v : parseDate(v);
        if (!Number.isFinite(ms)) throw new PlanningError('Termin tarihi gg.aa.yyyy ya da yyyy-aa-gg olmalı.');
        out.dueDate = ms;
      }
    }
    // Tezgah bos olabilir (tezgah baslatirken secilir); bos ya da null = atanmamis.
    if (has('machineId')) out.machineId = input.machineId === null || String(input.machineId ?? '').trim() === '' ? null : this.#machine(input.machineId);
    if (has('note')) out.note = text(input.note, 'Açıklama', 500);
    if (has('usedMaterial')) out.usedMaterial = text(input.usedMaterial, 'Kullanılan hammadde', 80);
    if (has('gkkReportNo')) out.gkkReportNo = text(input.gkkReportNo, 'GKK rapor no', 40);
    if (has('firstApprovalNo')) out.firstApprovalNo = text(input.firstApprovalNo, 'İlk onay rapor no', 40);
    if (has('measuredNetKg')) out.measuredNetKg = number(input.measuredNetKg, 'Ölçülen net ağırlık (kg)', { max: 100 });
    // Is emrinin KENDI kopya degerleri (urun kartindan alinir, burada is emrine ozel duzeltilebilir)
    Object.assign(out, productFields(Object.fromEntries(
      ['material', 'altMaterial', 'lengthMm', 'netKg', 'grossKg', 'plannedSec'].filter(has).map((k) => [k, input[k]]),
    )));
    return out;
  }

  /** Is emri + hesaplanan degerler (hammadde kg, cubuk sayisi, planlanan saat, tezgah numarasi). */
  #woView(w) {
    return {
      ...w,
      machineNumber: machineNumber(w.machineId),
      rawKg: rawMaterial({ qty: w.targetQty, grossKg: w.grossKg, lengthMm: w.lengthMm }).kg,
      bars: rawMaterial({ qty: w.targetQty, grossKg: w.grossKg, lengthMm: w.lengthMm }).bars,
      plannedHours: plannedHours(w.targetQty, w.plannedSec),
    };
  }

  /**
   * Yeni is emri. `lineId` (siparis satiri) ya da `stockCode` (siparissiz) verilir; urun karti ZORUNLU.
   * Urun degerleri is emrine KOPYALANIR (kart sonra degisse eski is emri degismez).
   */
  createWorkOrder(input, { by = null, now = Date.now() } = {}) {
    const f = this.#woFields(input);
    if (f.targetQty === undefined) throw new PlanningError('Hedef adet gerekli.');

    let line = null;
    let product;
    if (input.lineId !== undefined && input.lineId !== null && input.lineId !== '') {
      line = this.db.getLine(Number(input.lineId));
      if (!line) throw new PlanningError('Sipariş satırı bulunamadı.', 404);
      if (line.stale) throw new PlanningError('Bu sipariş satırı son içeri almada dosyada yok (eski). Güncel sipariş dosyasını yükleyin.', 409, 'stale-line');
      product = this.db.getProduct(line.codeKey);
      if (!product) throw new PlanningError(`${line.stockCode} için ürün kartı yok. Önce Ürünler sekmesinden kartı açın.`, 409, 'no-product');
    } else {
      const code = String(input.stockCode ?? '').trim();
      if (code === '') throw new PlanningError('Sipariş satırı ya da stok kodu gerekli.');
      product = this.db.getProduct(foldTr(code));
      if (!product) throw new PlanningError(`${code} için ürün kartı yok. Önce Ürünler sekmesinden kartı açın.`, 409, 'no-product');
    }

    const pick = (key) => (key in f ? f[key] : product[key]);
    const snap = {
      material: pick('material'), altMaterial: pick('altMaterial'), lengthMm: pick('lengthMm'),
      netKg: pick('netKg'), grossKg: pick('grossKg'), plannedSec: pick('plannedSec'),
    };
    this.#checkWeights(snap);
    if (f.sampleQty != null && f.sampleQty > f.targetQty) throw new PlanningError('Numune adedi hedef adetten büyük olamaz.');
    const dueDate = 'dueDate' in f ? f.dueDate : line?.dueDate ?? null;

    const warnings = [];
    if (line && f.targetQty > line.unplanned) {
      warnings.push(`Hedef adet (${f.targetQty}) bu satırın planlanmamış kalanından (${line.unplanned}) fazla.`);
    }

    const created = this.db.tx(() => {
      const year = new Date(now).getFullYear();
      const info = this.db.seqInfo(year);
      const no = `${year}${String(info.next).padStart(6, '0')}`;
      this.db.insertWorkOrder({
        no, year, seq: info.next, machineId: f.machineId ?? null, codeKey: product.codeKey, stockCode: product.stockCode,
        lineId: line?.id ?? null, docNo: line?.docNo ?? '', custOrderNo: line?.custOrderNo ?? '', customer: line?.customer ?? '',
        targetQty: f.targetQty, dueDate, sampleQty: f.sampleQty ?? null, productName: product.name, customerCode: product.customerCode,
        ...snap, usedMaterial: f.usedMaterial ?? null, gkkReportNo: f.gkkReportNo ?? null,
        firstApprovalNo: f.firstApprovalNo ?? null, measuredNetKg: f.measuredNetKg ?? null, note: f.note ?? null, now, by,
      });
      // Olcu plani: urun kartindaki kalici plan ile ayni urunun en son duzenlenen is emri plani arasindan DAHA YENI olan kopyalanir
      const fromCard = product.measurePlan?.length > 0 ? { plan: JSON.stringify(product.measurePlan), at: product.measurePlanAt ?? 0 } : null;
      const fromOrder = this.db.latestMeasurePlan(product.codeKey);
      const last = fromCard && (!fromOrder || fromCard.at >= fromOrder.at) ? fromCard : fromOrder;
      if (last) this.db.updateWorkOrder(no, { measure_plan: last.plan, measure_plan_at: last.at }, { by, now });
      this.quality.inheritDrawings(no, product.codeKey, { by, now }); // ayni urunun teknik resimleri (dosya kopyalanmaz, baglanir)
      this.db.addWorkOrderEvent(no, 'olusturuldu', `${product.stockCode} · ${f.targetQty} adet · ${f.machineId ?? 'tezgah atanmadı (başlatırken seçilir)'}`, { by, now });
      return no;
    });
    return { ...this.#woView(this.db.getWorkOrder(created)), warnings };
  }

  #get(no) {
    const w = this.db.getWorkOrder(String(no));
    if (!w) throw new PlanningError(`İş emri bulunamadı: ${no}`, 404);
    return w;
  }

  /** Zaman girdisi (ms ya da yerel 'yyyy-aa-ggTss:dd'); bos -> null. Gelecekte olamaz, en fazla maxAgeMs geriye alinabilir. */
  #instant(value, now, label, maxAgeMs = 72 * 3_600_000) {
    if (value === undefined || value === null || value === '') return null;
    const ms = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(ms)) throw new PlanningError(`${label} geçerli bir tarih-saat olmalı.`);
    if (ms > now + 60_000) throw new PlanningError(`${label} gelecekte olamaz.`);
    if (ms < now - maxAgeMs) throw new PlanningError(`${label} en fazla ${Math.round(maxAgeMs / 3_600_000)} saat geriye alınabilir.`);
    return ms;
  }

  /** Gerceklesen uretim: uretimde -> canli; bitti / uretimdeyken iptal -> kapanista DONDURULMUS sonuc. Baslamamissa null. */
  #progressOf(w, now = Date.now()) {
    if (w.startedAt == null) return null;
    if (w.status !== 'uretimde') {
      const r = w.result;
      if (!r) return null;
      return {
        ...r, open: false, frozen: true, eta: null, live: null,
        remaining: Math.max(0, w.targetQty - r.produced), overBy: Math.max(0, r.produced - w.targetQty),
        pct: w.targetQty > 0 ? Math.round((r.produced / w.targetQty) * 1000) / 10 : null,
      };
    }
    return { ...this.#compute(w, w.startedAt, now, true, now), frozen: false };
  }

  #compute(w, from, to, open, now) {
    return computeProgress({
      wo: w, events: this.productionEvents(w.machineId, from, to), programMap: this.db.getProgramMap(),
      hasMapping: this.db.programsOfProduct(w.codeKey).length > 0, from, to, open, now, live: open ? this.liveMachine(w.machineId) : null,
    });
  }

  /** Kapanista dondurulacak sonuc (canli alanlar ve tahmin disarida). */
  #frozenResult(w, from, to, now) {
    const { eta, live, remaining, pct, overBy, ...core } = this.#compute(w, from, to, false, now);
    return core;
  }

  /**
   * İş emri formu (ön sayfa) + varsa teknik resimler (arka sayfalar) TEK PDF'te: ekranda gösterilen ve tek yazdırma işinde basılan dosya.
   * @returns {Buffer}
   */
  workOrderPrintPdf(no, { now = Date.now() } = {}) {
    const w = this.getWorkOrder(no, { now });
    const form = buildWorkOrderFormPdf(w, { now });
    const merged = this.quality.mergedDrawings(w.no);
    if (!merged) return form;
    try { return mergePdfs([form, merged.buffer]); } catch (err) {
      if (err instanceof PdfError) throw new PlanningError(`Form ve çizimler birleştirilemedi: ${err.message}`, 422, 'merge-failed');
      throw err;
    }
  }

  /** @param {{now?: number}} [o] now: canli uretimin hesaplandigi an (testler sabitler) */
  getWorkOrder(no, { now = Date.now() } = {}) {
    const w = this.#get(no);
    const progress = this.#progressOf(w, now);
    return {
      ...this.#woView(w),
      progress,
      crates: this.#cratesSummary(w, progress, now),
      // hammadde sarfiyati (D): alan adi `material` is emrinin kendi hammadde metni oldugu icin `consumption`
      consumption: { ...consumptionOf(w, progress ? progress.produced : null), fis: this.#fisOf(w) },
      events: this.db.workOrderEvents(w.no),
      line: w.lineId == null ? null : this.db.getLine(w.lineId),
      drawings: this.quality.listDrawings(w.no),
      approvals: this.quality.approvalsOfWo(w.no),
    };
  }

  listWorkOrders(query, { now = Date.now() } = {}) {
    const r = this.db.listWorkOrders(query);
    return {
      total: r.total,
      items: r.items.map((w) => {
        const p = this.#progressOf(w, now);
        return { ...this.#woView(w), produced: p ? p.produced : null, pct: p ? p.pct : null };
      }),
    };
  }

  /** Alan degisikliklerini sutunlara ve okunur gecmis metnine cevirir (guncelleme ve baslatma ortak). */
  #diffFields(cur, f) {
    const COLS = {
      machineId: 'machine_id', targetQty: 'target_qty', dueDate: 'due_date', sampleQty: 'sample_qty', note: 'note', usedMaterial: 'used_material',
      gkkReportNo: 'gkk_report_no', firstApprovalNo: 'first_approval_no', measuredNetKg: 'measured_net_kg',
      material: 'material', altMaterial: 'alt_material', lengthMm: 'length_mm', netKg: 'net_kg', grossKg: 'gross_kg', plannedSec: 'planned_sec',
    };
    // Gecmis kaydi okunur olsun: Turkce alan adi, agirliklar gram
    const LABEL = {
      machineId: 'tezgah', targetQty: 'hedef adet', dueDate: 'termin', sampleQty: 'numune adedi', note: 'açıklama', usedMaterial: 'kullanılan hammadde',
      gkkReportNo: 'GKK rapor no', firstApprovalNo: 'ilk onay rapor no', measuredNetKg: 'ölçülen net gramaj (g)',
      material: 'hammadde', altMaterial: 'alternatif hammadde', lengthMm: 'tam boy (mm)', netKg: 'net ağırlık (g)', grossKg: 'brüt ağırlık (g)', plannedSec: 'planlanan çevrim (sn)',
    };
    const KG = new Set(['measuredNetKg', 'netKg', 'grossKg']);
    const show = (k, v) => {
      if (v === null || v === undefined || v === '') return '—';
      if (KG.has(k)) return String(Number((v * 1000).toFixed(4)));
      if (k === 'dueDate') return new Date(v).toLocaleDateString('tr-TR');
      return String(v);
    };
    const cols = {};
    const changed = [];
    for (const [k, v] of Object.entries(f)) {
      if ((cur[k] ?? null) === (v ?? null)) continue;
      cols[COLS[k]] = v;
      changed.push(`${LABEL[k] ?? k}: ${show(k, cur[k])} → ${show(k, v)}`);
    }
    return { cols, changed };
  }

  /**
   * Operatorun (Tezgah basi) is emrinde DUZENLEYEBILDIGI alanlar: ilk parca yapildiktan sonra belli olan degerler (ilk onay rapor no, olculen net gramaj,
   * GKK rapor no) ile kullanilan hammadde ve aciklama. Planlama alanlari (hedef, hammadde kodu, agirlik, sure...) yoneticiye ozeldir.
   * Gecmise "guncellendi" olarak yazilir (kim, hangi alan, eski -> yeni).
   */
  updateWorkOrderFields(no, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.#get(no);
    if (cur.status === 'iptal') throw new PlanningError('İptal edilmiş iş emri değiştirilemez.', 409, 'cancelled');
    const bad = Object.keys(input).filter((k) => !OPERATOR_EDIT_FIELDS.has(k));
    if (bad.length > 0) throw new PlanningError(`Bu alanlar buradan değiştirilemez: ${bad.join(', ')}.`, 403);
    return this.updateWorkOrder(no, input, { by, now });
  }

  /** Planlandi / uretimde / bitti durumundaki is emrini gunceller (iptal edilmis degistirilemez). Baslamis is emrinin tezgahi degismez. */
  updateWorkOrder(no, input, { by = null, now = Date.now() } = {}) {
    const cur = this.#get(no);
    if (cur.status === 'iptal') throw new PlanningError('İptal edilmiş iş emri değiştirilemez.', 409, 'cancelled');
    const f = this.#woFields(input);
    if (f.machineId !== undefined && f.machineId !== cur.machineId && cur.status !== 'planlandi') {
      throw new PlanningError('Üretime başlamış iş emrinin tezgahı değiştirilemez (adet o tezgahın sayacından sayılıyor).', 409, 'machine-locked');
    }
    const next = { ...cur, ...f };
    this.#checkWeights({ netKg: next.netKg, grossKg: next.grossKg });
    if (next.sampleQty != null && next.sampleQty > next.targetQty) throw new PlanningError('Numune adedi hedef adetten büyük olamaz.');

    const { cols, changed } = this.#diffFields(cur, f);
    if (changed.length > 0) {
      this.db.tx(() => {
        this.db.updateWorkOrder(cur.no, cols, { by, now });
        this.db.addWorkOrderEvent(cur.no, 'guncellendi', changed.join('; ').slice(0, 500), { by, now });
      });
    }
    return this.getWorkOrder(cur.no, { now });
  }

  /**
   * Uretime baslat ("bu tezgahta baslatiyorum"). Tezgah verilmezse is emrindeki; ayni tezgahta baska uretimde is emri varsa 409;
   * baslangic zamani (varsayilan simdi, en fazla 72 saat geriye) baska bir is emrinin penceresiyle cakisamaz.
   * `fields`: ayni anda girilen is emri alanlari (gercek hammadde, GK no, ilk onay no ...; guncellemedeki kurallarla).
   * @param {{machineId?: string, startAt?: number|string, person?: string, fields?: object}} [input]
   */
  startWorkOrder(no, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.#get(no);
    if (cur.status !== 'planlandi') {
      throw new PlanningError(cur.status === 'uretimde' ? 'Bu iş emri zaten üretimde.' : cur.status === 'bitti' ? 'Bu iş emri bitmiş.' : 'İptal edilmiş iş emri başlatılamaz.', 409, 'bad-status');
    }
    const f = this.#woFields(Object.fromEntries(Object.entries(input.fields ?? {}).filter(([k]) => k !== 'machineId')));
    const machineId = input.machineId ? this.#machine(input.machineId) : cur.machineId;
    if (!machineId) throw new PlanningError('Tezgah seçilmedi: üretime başlatırken tezgahı seçin.', 400, 'no-machine');
    const startAt = this.#instant(input.startAt, now, 'Başlangıç zamanı') ?? now;
    const person = text(input.person, 'Yapan kişi', 60);
    const next = { ...cur, ...f };
    this.#checkWeights({ netKg: next.netKg, grossKg: next.grossKg });
    if (next.sampleQty != null && next.sampleQty > next.targetQty) throw new PlanningError('Numune adedi hedef adetten büyük olamaz.');

    for (const o of this.db.machineWindows(machineId, cur.no)) {
      if (o.status === 'uretimde') throw new PlanningError(`${machineId} tezgahında ${o.no} numaralı iş emri üretimde. Önce onu bitirin.`, 409, 'machine-busy');
      if (o.finishedAt > startAt) {
        throw new PlanningError(`${machineId} tezgahında ${o.no} numaralı iş emri ${fmtTime(o.startedAt)} – ${fmtTime(o.finishedAt)} arasında çalışmış: başlangıç zamanı bitişinden sonra olmalı.`, 409, 'overlap');
      }
    }

    const live = Math.abs(now - startAt) <= 120_000 ? this.liveMachine(machineId) : null;
    const startTotal = live?.connected && Number.isInteger(live.partTotal) ? live.partTotal : null;
    const { cols, changed } = this.#diffFields(cur, f);

    const warnings = [];
    const liveNow = this.liveMachine(machineId);
    const hasMapping = this.db.programsOfProduct(cur.codeKey).length > 0;
    if (liveNow == null) warnings.push(`${machineId} için telemetri verisi yok: adet sayılamaz.`);
    else if (!liveNow.connected) warnings.push(`${machineId} tezgahından şu an veri gelmiyor: sayım, veri gelince (kopukluktan sonra) tamamlanır.`);
    if (!hasMapping) warnings.push('Bu ürün için program eşlemesi yok: adet tezgah ve zamana göre sayılır, program doğrulanamaz.');
    else if (liveNow?.connected && liveNow.program) {
      const m = this.db.getProgramMap().get(programKey(liveNow.program));
      if (m && m.codeKey !== cur.codeKey) warnings.push(`Tezgahta şu an başka ürüne eşli program çalışıyor (${liveNow.program} → ${m.stockCode}).`);
    }

    this.db.tx(() => {
      this.db.updateWorkOrder(cur.no, {
        ...cols, status: 'uretimde', machine_id: machineId, started_at: startAt, started_by: by, started_person: person, start_total: startTotal,
      }, { by, now });
      const parts = [machineId];
      if (cur.machineId && machineId !== cur.machineId) parts.push(`tezgah ${cur.machineId} → ${machineId}`);
      if (person) parts.push(person);
      if (startAt !== now) parts.push(`başlangıç ${fmtTime(startAt)}`);
      if (startTotal != null) parts.push(`sayaç ${startTotal}`);
      this.db.addWorkOrderEvent(cur.no, 'baslatildi', parts.join(' · '), { by, now });
      if (changed.length > 0) this.db.addWorkOrderEvent(cur.no, 'guncellendi', changed.join('; ').slice(0, 500), { by, now });
    });
    return { ...this.getWorkOrder(cur.no, { now }), warnings };
  }

  /** Bitir: gerceklesen uretim [baslangic, bitis] araligindan hesaplanip DONDURULUR. @param {{endAt?: number|string, person?: string}} [input] */
  finishWorkOrder(no, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.#get(no);
    if (cur.status !== 'uretimde') {
      throw new PlanningError(cur.status === 'planlandi' ? 'Bu iş emri henüz başlatılmadı.' : cur.status === 'bitti' ? 'Bu iş emri zaten bitmiş.' : 'İptal edilmiş iş emri bitirilemez.', 409, 'bad-status');
    }
    const endAt = this.#instant(input.endAt, now, 'Bitiş zamanı', 400 * 86_400_000) ?? now;
    if (endAt < cur.startedAt) throw new PlanningError(`Bitiş zamanı başlangıçtan (${fmtTime(cur.startedAt)}) önce olamaz.`);
    const person = text(input.person, 'Yapan kişi', 60);
    const result = this.#frozenResult(cur, cur.startedAt, endAt, now);
    const live = Math.abs(now - endAt) <= 120_000 ? this.liveMachine(cur.machineId) : null;
    const finishTotal = live?.connected && Number.isInteger(live.partTotal) ? live.partTotal : null;

    const warnings = [];
    if (result.produced === 0) warnings.push('Hiç parça sayılmadı: tezgah verisi ya da zaman aralığı kontrol edilmeli.');
    else if (result.produced < cur.targetQty) warnings.push(`Hedefin altında bitirildi: ${result.produced} / ${cur.targetQty} adet.`);
    else if (result.produced > cur.targetQty) warnings.push(`Hedefin üzerinde: ${result.produced} / ${cur.targetQty} adet (${result.produced - cur.targetQty} fazla).`);
    for (const w of result.warnings) if (w.level === 'warn') warnings.push(w.text);

    this.db.tx(() => {
      const openCrate = this.db.openCrateOfWo(cur.no);
      if (openCrate) this.#closeCrateRow(openCrate, { by, person: null, to: Math.max(endAt, openCrate.openedAt), now, auto: true });
      this.db.updateWorkOrder(cur.no, {
        status: 'bitti', finished_at: endAt, finished_by: by, finished_person: person, finish_total: finishTotal, result_json: JSON.stringify(result),
      }, { by, now });
      const parts = [`${result.produced} adet · hedef ${cur.targetQty}`];
      if (person) parts.push(person);
      if (endAt !== now) parts.push(`bitiş ${fmtTime(endAt)}`);
      if (finishTotal != null) parts.push(`sayaç ${finishTotal}`);
      this.db.addWorkOrderEvent(cur.no, 'bitirildi', parts.join(' · '), { by, now });
    });
    return { ...this.getWorkOrder(cur.no, { now }), warnings };
  }

  /** Yanlislikla bitirilen is emrini uretime geri alir (donmus sonuc silinir; aralik yeniden acik). Sonraki bir is emriyle cakisiyorsa 409. */
  reopenWorkOrder(no, { by = null, now = Date.now() } = {}) {
    const cur = this.#get(no);
    if (cur.status !== 'bitti') throw new PlanningError('Yalnız biten iş emri üretime geri alınabilir.', 409, 'bad-status');
    for (const o of this.db.machineWindows(cur.machineId, cur.no)) {
      if (o.status === 'uretimde') throw new PlanningError(`${cur.machineId} tezgahında ${o.no} numaralı iş emri üretimde: önce onu bitirin.`, 409, 'machine-busy');
      if (o.startedAt >= cur.startedAt) throw new PlanningError(`${cur.machineId} tezgahında bundan sonra ${o.no} numaralı iş emri çalışmış: geri alınamaz.`, 409, 'overlap');
    }
    this.db.tx(() => {
      this.db.updateWorkOrder(cur.no, { status: 'uretimde', finished_at: null, finished_by: null, finished_person: null, finish_total: null, result_json: null }, { by, now });
      this.db.addWorkOrderEvent(cur.no, 'yeniden-acildi', `bitiş (${fmtTime(cur.finishedAt)}) geri alındı`, { by, now });
    });
    return this.getWorkOrder(cur.no, { now });
  }

  /** İptal: planli ya da uretimdeki is emri (uretimdeyse o ana kadarki adet dondurulur). Biten iptal edilmez (once geri alinir). */
  cancelWorkOrder(no, { reason, by = null, now = Date.now() } = {}) {
    const cur = this.#get(no);
    if (cur.status === 'iptal') throw new PlanningError('İş emri zaten iptal edilmiş.', 409, 'cancelled');
    if (cur.status === 'bitti') throw new PlanningError('Biten iş emri iptal edilemez. Hatalıysa önce "Üretime geri al".', 409, 'finished');
    const why = text(reason, 'İptal nedeni', 200);
    if (why === null || why.length < 3) throw new PlanningError('İptal nedeni gerekli (en az 3 karakter).');
    this.db.tx(() => {
      const cols = { status: 'iptal', cancelled_at: now, cancel_reason: why };
      if (cur.status === 'uretimde') {
        const openCrate = this.db.openCrateOfWo(cur.no);
        if (openCrate) this.#closeCrateRow(openCrate, { by, person: null, to: now, now, auto: true });
        cols.finished_at = now;
        cols.result_json = JSON.stringify(this.#frozenResult(cur, cur.startedAt, now, now));
      }
      this.db.updateWorkOrder(cur.no, cols, { by, now });
      this.db.addWorkOrderEvent(cur.no, 'iptal', why, { by, now });
    });
    return this.getWorkOrder(cur.no, { now });
  }

  /* --------------------------------------------------------- hammadde (D) */

  /** Mikro sarfiyat fisi durumu: yalniz biten is emri icin anlamli (bekliyor | girildi). */
  #fisOf(w) {
    if (w.fisAt != null) return { status: 'girildi', at: w.fisAt, by: w.fisBy, docNo: w.fisDocNo, kg: w.fisKg, note: w.fisNote };
    return { status: w.status === 'bitti' ? 'bekliyor' : null };
  }

  /** 'yyyy-aa-gg' araligi (dahil) -> yerel gun sinirlari; varsayilan: bu ayin basindan bugune. */
  #dayRange(from, to, now) {
    const today = dateKey(new Date(now));
    const toKey = to ? String(to) : today;
    const fromKey = from ? String(from) : `${today.slice(0, 8)}01`;
    const p = parseDateKey(fromKey);
    const q = parseDateKey(toKey);
    if (!p || !q) throw new PlanningError('Tarih yyyy-aa-gg biçiminde olmalı.');
    if (fromKey > toKey) throw new PlanningError('Başlangıç tarihi bitişten sonra olamaz.');
    if (daysBetween(fromKey, toKey) > 400) throw new PlanningError('Aralık en fazla 400 gün olabilir.');
    const next = parseDateKey(addDays(toKey, 1));
    return { fromKey, toKey, fromMs: new Date(p.y, p.m - 1, p.d).getTime(), toMs: new Date(next.y, next.m - 1, next.d).getTime() };
  }

  /** Sarfiyat satiri: is emri + hesaplanan hammadde (adet = gerceklesen). */
  #consumptionRow(w, produced) {
    const c = consumptionOf(w, produced);
    return {
      no: w.no, status: w.status, machineId: w.machineId, stockCode: w.stockCode, productName: w.productName, targetQty: w.targetQty,
      finishedAt: w.finishedAt, grossKg: w.grossKg, netKg: w.netKg, lengthMm: w.lengthMm,
      material: c.material, plannedMaterial: c.plannedMaterial, usedMaterial: c.usedMaterial, isAlt: c.isAlt, differs: c.differs,
      produced: c.qty, qty: c.qty, kg: c.kg, bars: c.bars, scrapKg: c.scrapKg, fis: this.#fisOf(w),
    };
  }

  /**
   * Hammadde IHTIYACI: planlanan + uretimdeki (kalan adet) is emirleri; hammadde kodu bazinda kg ve cubuk. (Mikro okuma gelince depo bakiyesiyle
   * karsilastirilip eksik uyarisi verilecek: F asamasi.) Brut agirligi olmayan is emri kg'a katilmaz, ayrica sayilir.
   */
  materialNeed({ now = Date.now() } = {}) {
    const open = [...this.db.listWorkOrders({ status: 'uretimde', limit: 500 }).items, ...this.db.listWorkOrders({ status: 'planlandi', limit: 500 }).items];
    const rows = open.map((w) => {
      const done = w.status === 'uretimde' ? this.#progressOf(w, now)?.produced ?? 0 : 0;
      const remaining = Math.max(0, w.targetQty - done);
      const c = consumptionOf(w, remaining);
      return {
        no: w.no, status: w.status, machineId: w.machineId, stockCode: w.stockCode, productName: w.productName, targetQty: w.targetQty, remaining,
        dueDate: w.dueDate, altMaterial: w.altMaterial, material: c.material, kg: c.kg, bars: c.bars, scrapKg: c.scrapKg, qty: c.qty,
      };
    });
    return {
      now, rows, byMaterial: groupByMaterial(rows),
      totals: {
        orders: rows.length, kg: Math.round(rows.reduce((a, r) => a + (r.kg ?? 0), 0) * 1000) / 1000,
        bars: Math.round(rows.reduce((a, r) => a + (r.bars ?? 0), 0) * 100) / 100, noWeight: rows.filter((r) => r.kg == null).length,
        noMaterial: rows.filter((r) => !r.material).length,
      },
    };
  }

  /**
   * GERCEKLESEN sarfiyat: bitis tarihi [from, to] (dahil) olan BITEN is emirleri; adet = dondurulmus gerceklesen (sayac) adet. `fis`: bekleyen | girildi | tumu.
   * `inProgress`: o an uretimdeki is emirlerinin simdiye kadarki sarfiyati (henuz fis kesilemez; bilgi).
   */
  materialConsumption({ from, to, fis = 'tumu', now = Date.now() } = {}) {
    const range = this.#dayRange(from, to, now);
    const all = this.db.listFinishedBetween(range.fromMs, range.toMs).map((w) => this.#consumptionRow(w, w.result?.produced ?? null));
    const rows = all.filter((r) => fis === 'tumu' || (fis === 'bekleyen' ? r.fis.status === 'bekliyor' : r.fis.status === 'girildi'));
    const grouped = groupByMaterial(rows.map((r) => ({ ...r, pendingKg: r.fis.status === 'bekliyor' ? r.kg ?? 0 : 0 })));
    const sum = (key, list = rows) => Math.round(list.reduce((a, r) => a + (r[key] ?? 0), 0) * 1000) / 1000;
    const pending = rows.filter((r) => r.fis.status === 'bekliyor');
    return {
      from: range.fromKey, to: range.toKey, fis,
      rows,
      byMaterial: grouped,
      totals: {
        orders: rows.length, qty: rows.reduce((a, r) => a + (r.produced ?? 0), 0), kg: sum('kg'), bars: Math.round(sum('bars') * 100) / 100, scrapKg: sum('scrapKg'),
        pendingOrders: pending.length, pendingKg: sum('kg', pending), noWeight: rows.filter((r) => r.kg == null).length,
        differs: rows.filter((r) => r.differs).length,
      },
      inProgress: this.db.listWorkOrders({ status: 'uretimde', limit: 500 }).items.map((w) => this.#consumptionRow(w, this.#progressOf(w, now)?.produced ?? 0)),
    };
  }

  /** Sarfiyat dokumu (Excel CSV): is emri bazli ya da hammadde bazli (ay sonu fisini hazirlamak icin). */
  materialCsv(query = {}, view = 'is-emri') {
    const r = this.materialConsumption(query);
    const num = (v) => (v == null ? null : v);
    if (view === 'hammadde') {
      return {
        filename: `hammadde-sarfiyat-${r.from}_${r.to}.csv`,
        text: csvDocument(
          ['Hammadde', 'İş emri', 'Adet', 'Sarfiyat (kg)', 'Çubuk (BOY)', 'Beklenen talaş (kg)', 'Fişi bekleyen (kg)', 'Ağırlığı bilinmeyen iş emri'],
          r.byMaterial.map((g) => [g.material, g.orders, g.qty, g.kg, g.bars, g.scrapKg, g.pendingKg, g.unknownKg]),
        ),
      };
    }
    return {
      filename: `sarfiyat-is-emirleri-${r.from}_${r.to}.csv`,
      text: csvDocument(
        ['İş emri', 'Bitiş', 'Tezgah', 'Stok kodu', 'Ürün', 'Hammadde (kullanılan)', 'Planlanan hammadde', 'Adet', 'Brüt (g)', 'Sarfiyat (kg)', 'Çubuk (BOY)', 'Beklenen talaş (kg)', 'Fiş durumu', 'Mikro evrak no', 'Fiş kg'],
        r.rows.map((x) => [
          x.no, x.finishedAt ? new Date(x.finishedAt).toLocaleString('tr-TR', { hour12: false }) : null, x.machineId, x.stockCode, x.productName, x.material, x.plannedMaterial, num(x.produced),
          x.grossKg == null ? null : Math.round(x.grossKg * 1_000_000) / 1000, x.kg, x.bars, x.scrapKg, x.fis.status === 'girildi' ? 'girildi' : 'bekliyor', x.fis.docNo ?? null, x.fis.kg ?? null,
        ]),
      ),
    };
  }

  /**
   * Biten is emirlerinin sarfiyat fisinin Mikro'ya ELLE girildigini isaretle (API dogrulanana kadar: PLANLAMA-TASARIM.md 7.2). Cift fis olmasin diye
   * girilmis is emri yeniden isaretlenmez. Fis kg varsayilan = hesaplanan sarfiyat; yalnizca TEK is emri icin elle degistirilebilir (Mikro'ya yazilan fiilî kg).
   * @param {{orders: string[], docNo?: string, kg?: number|string, note?: string}} input
   */
  markFis(input = {}, { by = null, now = Date.now() } = {}) {
    const nos = [...new Set((Array.isArray(input.orders) ? input.orders : []).map((x) => String(x)))];
    if (nos.length === 0 || nos.length > 200) throw new PlanningError('1–200 iş emri seçilmeli.');
    const docNo = text(input.docNo, 'Mikro evrak no', 40);
    const note = text(input.note, 'Not', 200);
    let override = null;
    if (input.kg !== undefined && input.kg !== null && input.kg !== '') {
      if (nos.length !== 1) throw new PlanningError('Fiş kg yalnız tek iş emri için elle girilebilir.');
      override = number(input.kg, 'Fiş kg', { max: 10_000_000 });
    }
    let total = 0;
    this.db.tx(() => {
      for (const no of nos) {
        const w = this.#get(no);
        if (w.status !== 'bitti') throw new PlanningError(`${no} bitmemiş: sarfiyat fişi yalnız biten iş emri için girilir.`, 409, 'bad-status');
        if (w.fisAt != null) throw new PlanningError(`${no} için fiş zaten girilmiş${w.fisDocNo ? ` (evrak ${w.fisDocNo})` : ''}: önce geri alın.`, 409, 'fis-exists');
        const kg = override ?? consumptionOf(w, w.result?.produced ?? null).kg;
        if (kg == null) throw new PlanningError(`${no} için sarfiyat hesaplanamadı (brüt ağırlık ya da gerçekleşen adet yok): kg'ı elle girin.`, 409, 'no-weight');
        this.db.updateWorkOrder(no, { fis_at: now, fis_by: by, fis_doc_no: docNo, fis_kg: kg, fis_note: note }, { by, now });
        this.db.addWorkOrderEvent(no, 'fis-girildi', `${kg} kg${docNo ? ` · evrak ${docNo}` : ''}${note ? ` · ${note}` : ''}`, { by, now });
        total += kg;
      }
    });
    return { marked: nos.length, kg: Math.round(total * 1000) / 1000 };
  }

  /** Yanlislikla girildi isaretlenen fisi geri alir. @param {{orders: string[]}} input */
  clearFis(input = {}, { by = null, now = Date.now() } = {}) {
    const nos = [...new Set((Array.isArray(input.orders) ? input.orders : []).map((x) => String(x)))];
    if (nos.length === 0 || nos.length > 200) throw new PlanningError('1–200 iş emri seçilmeli.');
    this.db.tx(() => {
      for (const no of nos) {
        const w = this.#get(no);
        if (w.fisAt == null) throw new PlanningError(`${no} için fiş girilmemiş.`, 409, 'no-fis');
        this.db.updateWorkOrder(no, { fis_at: null, fis_by: null, fis_doc_no: null, fis_kg: null, fis_note: null }, { by, now });
        this.db.addWorkOrderEvent(no, 'fis-geri-alindi', `${w.fisKg} kg${w.fisDocNo ? ` · evrak ${w.fisDocNo}` : ''}`, { by, now });
      }
    });
    return { cleared: nos.length };
  }

  /* ------------------------------------------------------ verimlilik (E) */

  /**
   * Verimlilik raporu: iş emri penceresi x vardiya parcalari uzerinden (efficiency.js). Aralik varsayilan: bu ayin basindan bugune.
   * @param {{from?: string, to?: string, machine?: string}} [q]
   */
  efficiencyReport({ from, to, machine = '', now = Date.now() } = {}) {
    const range = this.#dayRange(from, to, now);
    const machineId = machine ? this.#machine(machine) : '';
    const rangeFrom = range.fromMs;
    const rangeTo = Math.min(range.toMs, now);
    const segs = [];
    if (rangeTo > rangeFrom) {
      for (const wo of this.db.listOrdersOverlapping(rangeFrom, rangeTo, machineId)) {
        const s = Math.max(wo.startedAt, rangeFrom);
        const e = Math.min(wo.finishedAt ?? now, rangeTo);
        if (e <= s) continue;
        segs.push(...orderSegments({
          wo, from: s, to: e, events: this.productionEvents(wo.machineId, s, e), spans: this.spans(wo.machineId, s, e),
          eventAfter: wo.startedAt >= rangeFrom ? wo.startedAt : -Infinity,
        }));
      }
    }
    const total = summarize(segs);
    const days = new Set(segs.filter((x) => x.qty > 0).map((x) => x.date)).size;
    const inv = this.listMachines().filter((m) => !machineId || m.id === machineId);
    const machines = inv.map((m) => ({ machineId: m.id, name: m.name ?? m.id, ...summarize(segs.filter((x) => x.machineId === m.id)) }));
    const atRisk = this.db.listWorkOrders({ status: 'uretimde', limit: 500 }).items
      .map((w) => ({ w, p: this.#progressOf(w, now) })).filter(({ p }) => p?.eta?.lateRisk)
      .map(({ w, p }) => ({ no: w.no, machineId: w.machineId, stockCode: w.stockCode, productName: w.productName, dueDate: w.dueDate, etaMs: p.eta.ms, remaining: p.remaining }));
    const warnings = [];
    if (total.noPlanned > 0) warnings.push(`${total.noPlanned} iş emri parçasında planlanan çevrim yok: verimliliğe katılmadı (ürün kartına planlanan süreyi girin).`);
    const lowCoverage = segs.filter((x) => x.allottedSec > 0 && x.observedSec / x.allottedSec < 0.8);
    if (lowCoverage.length > 0) warnings.push(`${lowCoverage.length} iş emri × vardiya parçasında tezgah verisi ayrılan sürenin %80'inden azını kapsıyor: kullanılabilirlik ve adet eksik olabilir.`);
    if (total.approxQty > 0) warnings.push(`${total.approxQty} adet veri kopukluğundan sonra sayıldı (adet gerçek, vardiyası yaklaşık).`);
    return {
      from: range.fromKey, to: range.toKey, machine: machineId || null, now,
      totals: { ...total, days, avgDailyQty: days > 0 ? Math.round(total.qty / days) : null },
      segments: segs, matrix: matrixRows(segs, { rangeFrom, rangeTo }), days: dayRows(segs), machines, products: productRows(segs), atRisk, warnings,
    };
  }

  /**
   * Durus raporu: nedenlerin dakikalari (tezgah x uretim gunu x kod) ve nedeni belirsiz kalan olculmus durus. Dakika telemetriden, neden insandan.
   * @param {{from?: string, to?: string, machine?: string}} [q]
   */
  downtimeReport({ from, to, machine = '', now = Date.now() } = {}) {
    const range = this.#dayRange(from, to, now);
    const machineId = machine ? this.#machine(machine) : '';
    const rangeFrom = range.fromMs;
    const rangeTo = Math.min(range.toMs, now);
    const codeInfo = new Map(this.db.listDowntimeCodes({ activeOnly: false }).map((c) => [c.code, c]));
    const rows = new Map();
    const unknown = new Map();
    const stats = new Map();
    const add = (map, key, ms) => map.set(key, (map.get(key) ?? 0) + ms);
    const inv = this.listMachines().filter((m) => !machineId || m.id === machineId);
    for (const m of inv) {
      const st = { machineId: m.id, name: m.name ?? m.id, stopMs: 0, reasonMs: 0, unknownMs: 0 };
      stats.set(m.id, st);
      if (rangeTo <= rangeFrom) continue;
      const reasons = this.db.downtimeReasonsBetween(rangeFrom, rangeTo, m.id);
      for (const rs of reasons) {
        for (const part of splitByShift(Math.max(rs.from, rangeFrom), Math.min(rs.to, rangeTo))) {
          const ms = part.to - part.from;
          add(rows, `${part.date}|${m.id}|${rs.code}`, ms);
          st.reasonMs += ms;
        }
      }
      for (const stop of attachReasons(buildStops(this.spans(m.id, rangeFrom, rangeTo), { minMs: this.downtimeMinMs, now }), reasons)) {
        st.stopMs += stop.durationMs;
        for (const u of stop.uncovered) {
          for (const part of splitByShift(u.from, u.to)) {
            const ms = part.to - part.from;
            add(unknown, `${part.date}|${m.id}`, ms);
            st.unknownMs += ms;
          }
        }
      }
    }
    const min = (ms) => Math.round((ms / 60_000) * 10) / 10;
    const dataRows = [...rows.entries()].map(([k, ms]) => {
      const [date, mid, code] = k.split('|');
      const c = codeInfo.get(code);
      return { date, machineId: mid, code, name: c?.name ?? code, group: c?.group ?? null, kind: c?.kind ?? code[0], minutes: min(ms) };
    }).sort((a, b) => (a.date === b.date ? a.machineId.localeCompare(b.machineId) || a.code.localeCompare(b.code, 'tr', { numeric: true }) : a.date < b.date ? -1 : 1));
    const unknownRows = [...unknown.entries()].map(([k, ms]) => { const [date, mid] = k.split('|'); return { date, machineId: mid, minutes: min(ms) }; })
      .sort((a, b) => (a.date === b.date ? a.machineId.localeCompare(b.machineId) : a.date < b.date ? -1 : 1));
    const byCode = new Map();
    for (const x of dataRows) {
      const c = byCode.get(x.code) ?? { code: x.code, name: x.name, group: x.group, kind: x.kind, minutes: 0 };
      c.minutes = Math.round((c.minutes + x.minutes) * 10) / 10;
      byCode.set(x.code, c);
    }
    const totalReason = dataRows.reduce((a, x) => a + x.minutes, 0);
    const totalUnknown = unknownRows.reduce((a, x) => a + x.minutes, 0);
    return {
      from: range.fromKey, to: range.toKey, machine: machineId || null, minStopMinutes: Math.round(this.downtimeMinMs / 60_000),
      codes: [...byCode.values()].sort((a, b) => b.minutes - a.minutes),
      rows: dataRows, unknown: unknownRows,
      machines: [...stats.values()].map((s) => ({
        machineId: s.machineId, name: s.name, stopMin: min(s.stopMs), reasonMin: min(s.reasonMs), unknownMin: min(s.unknownMs),
        coverage: s.stopMs > 0 ? Math.round(Math.min(1, s.reasonMs / s.stopMs) * 1000) / 1000 : null,
      })),
      totals: {
        stopMin: Math.round((totalReason + totalUnknown) * 10) / 10, reasonMin: Math.round(totalReason * 10) / 10, unknownMin: Math.round(totalUnknown * 10) / 10,
        coverage: totalReason + totalUnknown > 0 ? Math.round((totalReason / (totalReason + totalUnknown)) * 1000) / 1000 : null,
      },
    };
  }

  /** Verimlilik / durus dokumu (Excel CSV). view: gunluk | matris | urun | tezgah | durus | durus-kod-gun */
  efficiencyCsv(query = {}, view = 'gunluk') {
    const pct = (v) => (v == null ? null : Math.round(v * 1000) / 10);
    const hours = (sec) => (sec == null ? null : Math.round((sec / 3600) * 100) / 100);
    if (view === 'durus' || view === 'durus-kod-gun') {
      const d = this.downtimeReport(query);
      const range = `${d.from}_${d.to}`;
      if (view === 'durus') {
        return {
          filename: `durus-${range}.csv`,
          text: csvDocument(['Tarih', 'Tezgah', 'Kod', 'Duruş nedeni', 'Grup', 'Tür', 'Dakika'], [
            ...d.rows.map((x) => [x.date, x.machineId, x.code, x.name, x.group, x.kind, x.minutes]),
            ...d.unknown.map((x) => [x.date, x.machineId, '—', 'Nedeni belirsiz (ölçülmüş duruş)', null, null, x.minutes]),
          ]),
        };
      }
      // kod x gun (Excel DURUS sayfasinin duzeni): satir = kod, sutun = gun; secili tezgah ya da tum tezgahlarin toplami
      const days = [...new Set([...d.rows.map((x) => x.date), ...d.unknown.map((x) => x.date)])].sort();
      const cell = new Map();
      for (const x of d.rows) cell.set(`${x.code}|${x.date}`, (cell.get(`${x.code}|${x.date}`) ?? 0) + x.minutes);
      for (const x of d.unknown) cell.set(`—|${x.date}`, (cell.get(`—|${x.date}`) ?? 0) + x.minutes);
      const codes = [...d.codes.map((c) => [c.code, c.name]), ['—', 'Nedeni belirsiz']];
      return {
        filename: `durus-kod-gun-${range}.csv`,
        text: csvDocument(['Kod', 'Duruş nedeni', ...days, 'Toplam'], codes.map(([code, name]) => {
          const vals = days.map((day) => (cell.has(`${code}|${day}`) ? Math.round(cell.get(`${code}|${day}`) * 10) / 10 : null));
          return [code, name, ...vals, Math.round(vals.reduce((a, v) => a + (v ?? 0), 0) * 10) / 10];
        })),
      };
    }
    const e = this.efficiencyReport(query);
    const range = `${e.from}_${e.to}`;
    if (view === 'matris') {
      return {
        filename: `verimlilik-matris-${range}.csv`,
        text: csvDocument(['Tarih', 'Vardiya', 'Tezgah', 'Ürünler', 'Ayrılan süre (sa)', 'Atanmamış süre (sa)', 'Adet', 'Verimlilik (%)', 'Kullanılabilirlik (%)', 'Performans (%)'],
          e.matrix.map((x) => [x.date, x.label, x.machineId, x.products.join(' + '), hours(x.allottedSec), hours(x.unassignedSec), x.qty, pct(x.efficiency), pct(x.availability), pct(x.performance)])),
      };
    }
    if (view === 'urun') {
      return {
        filename: `verimlilik-urun-${range}.csv`,
        text: csvDocument(['Stok kodu', 'Ürün', 'Ayrılan süre (sa)', 'Adet', 'Planlanan çevrim (sn)', 'Ölçülen çevrim (sn)', 'Gerçekleşen (ayrılan ÷ adet, sn)', 'Verimlilik (%)', 'Kullanılabilirlik (%)', 'Performans (%)', 'Öneri'],
          e.products.map((x) => [x.stockCode, x.productName, hours(x.allottedSec), x.qty, x.plannedSec, x.measuredCycleSec, x.realizedSec, pct(x.efficiency), pct(x.availability), pct(x.performance),
            x.suggestion ? `planlanan süre fazla temkinli olabilir: ölçülen çevrim ${x.suggestion.plannedSec} sn` : null])),
      };
    }
    if (view === 'tezgah') {
      return {
        filename: `verimlilik-tezgah-${range}.csv`,
        text: csvDocument(['Tezgah', 'Ayrılan süre (sa)', 'Adet', 'Verimlilik (%)', 'Kullanılabilirlik (%)', 'Performans (%)', 'Brüt (kg)', 'Net (kg)', 'Talaş (kg)'],
          e.machines.map((x) => [x.machineId, hours(x.allottedSec), x.qty, pct(x.efficiency), pct(x.availability), pct(x.performance), x.grossKg, x.netKg, x.scrapKg])),
      };
    }
    // gunluk: "Aylik Uretim Karti" gunluk satirlari (tezgah x vardiya x urun)
    return {
      filename: `uretim-karti-gunluk-${range}.csv`,
      text: csvDocument(['Tarih', 'Vardiya', 'Tezgah', 'İş emri', 'Stok kodu', 'Ürün', 'Ayrılan süre (sn)', 'Planlanan çevrim (sn)', 'Hedef adet', 'Adet', 'Verimlilik (%)', 'Kullanılabilirlik (%)', 'Performans (%)', 'Brüt birim (g)', 'Net birim (g)', 'Brüt toplam (kg)', 'Net toplam (kg)', 'Talaş (kg)'],
        e.segments.map((x) => {
          const sum = summarize([x]);
          return [x.date, x.label, x.machineId, x.woNo, x.stockCode, x.productName, x.allottedSec, x.plannedSec, x.plannedSec ? Math.round(x.allottedSec / x.plannedSec) : null, x.qty, pct(sum.efficiency), pct(sum.availability), pct(sum.performance),
            x.grossKg == null ? null : Math.round(x.grossKg * 1_000_000) / 1000, x.netKg == null ? null : Math.round(x.netKg * 1_000_000) / 1000, sum.grossKg, sum.netKg, sum.scrapKg];
        })),
    };
  }

  /* ------------------------------------------------------------- kasalar (K) */

  /** (from, to] araliginda o tezgahta sayilan adet (supheli sayac sicramalari haric) ve veri kopuklugundan sonra sayilan (zamani kesin olmayan) kismi. */
  #countBetween(machineId, from, to) {
    const evs = this.productionEvents(machineId, from + 1, to).filter((e) => !e.suspect);
    return { qty: evs.reduce((a, e) => a + e.qty, 0), approx: evs.reduce((a, e) => a + (e.gapMs > 0 ? e.qty : 0), 0) };
  }

  /** Kasa + hesaplananlar: acik kasanin adedi canli sayilir; sayac farki; paketlenen - sayilan fark. */
  #crateView(c, now) {
    const open = c.state === 'acik';
    const live = open ? this.#countBetween(c.machineId, c.openedAt, now) : null;
    const countedQty = open ? live.qty : c.countedQty;
    return {
      ...c,
      countedQty,
      shift: (({ date, label }) => ({ date, label }))(shiftOf(c.openedAt)), // kartta TARIH / VARDIYA (kasanin acildigi vardiya)
      approxQty: open ? live.approx : c.approxQty,
      counterDiff: c.startTotal != null && c.endTotal != null ? c.endTotal - c.startTotal : null,
      packDiff: c.packedQty != null && countedQty != null ? c.packedQty - countedQty : null,
    };
  }

  /** Is emrinin kasalari ve toplamlar; `unassigned`: telemetrinin saydigi ama hicbir kasaya atanmayan adet (kasa acik degilken uretilenler). */
  #cratesSummary(w, progress, now) {
    const items = this.db.cratesOfWo(w.no).map((c) => this.#crateView(c, now));
    const counted = items.reduce((a, c) => a + (c.countedQty ?? 0), 0);
    return {
      items,
      totals: {
        count: items.length,
        open: items.some((c) => c.state === 'acik'),
        unpacked: items.filter((c) => c.state === 'kapali').length,
        rejected: items.filter((c) => c.state === 'ret').length, // ret edilen kasalar paketlemeye gitmez
        rejectedCounted: items.filter((c) => c.state === 'ret').reduce((a, c) => a + (c.countedQty ?? 0), 0),
        counted,
        packed: items.reduce((a, c) => a + (c.packedQty ?? 0), 0),
        unassigned: progress ? progress.produced - counted : null,
      },
    };
  }

  /** Kasayi kapatir (islem icinde cagrilir): sayilan adet telemetriden, bitis sayaci canliysa tezgahtan. */
  #closeCrateRow(c, { by, person, to, now, auto = false, event = 'kasa-kapandi', extra = '' }) {
    const { qty, approx } = this.#countBetween(c.machineId, c.openedAt, to);
    const live = Math.abs(now - to) <= 120_000 ? this.liveMachine(c.machineId) : null;
    const endTotal = live?.connected && Number.isInteger(live.partTotal) ? live.partTotal : null;
    this.db.updateCrate(c.id, { closed_at: to, closed_by: by, closed_person: person, end_total: endTotal, counted_qty: qty, approx_qty: approx });
    const parts = [`${c.cardNo} · ~${qty} adet (sayaç)`];
    if (person) parts.push(person);
    if (extra) parts.push(extra);
    if (auto) parts.push('iş emri kapanırken otomatik kapatıldı');
    this.db.addWorkOrderEvent(c.woNo, event, parts.join(' · '), { by, now });
  }

  #crate(id) {
    const c = this.db.getCrate(Number(id));
    if (!c) throw new PlanningError('Kasa bulunamadı.', 404);
    return c;
  }

  /**
   * Yeni kasa ac ("kasaya doluyor"): yalniz URETIMDEKI is emrinde, ayni anda tek acik kasa. Kart numarasini sistem verir (K000001...),
   * tezgahin o anki omur boyu sayaci kaydedilir (canliysa).
   * @param {{person?: string, note?: string}} [input]
   */
  openCrate(woNo, input = {}, { by = null, now = Date.now() } = {}) {
    const w = this.#get(woNo);
    if (w.status !== 'uretimde') throw new PlanningError('Kasa yalnız üretimdeki iş emrinde açılır.', 409, 'bad-status');
    const open = this.db.openCrateOfWo(w.no);
    if (open) throw new PlanningError(`${open.cardNo} numaralı kasa zaten açık: önce onu kapatın.`, 409, 'crate-open');
    const person = text(input.person, 'Yapan kişi', 60);
    const note = text(input.note, 'Not', 200);
    const live = this.liveMachine(w.machineId);
    const startTotal = live?.connected && Number.isInteger(live.partTotal) ? live.partTotal : null;
    const id = this.db.tx(() => {
      const { next } = this.db.nextCrateSeq();
      const cid = this.db.insertCrate({ seq: next, woNo: w.no, machineId: w.machineId, openedAt: now, openedBy: by, openedPerson: person, startTotal, note });
      this.db.addWorkOrderEvent(w.no, 'kasa-acildi', `K${String(next).padStart(6, '0')}${person ? ` · ${person}` : ''}${startTotal != null ? ` · sayaç ${startTotal}` : ''}`, { by, now });
      return cid;
    });
    const warnings = [];
    if (startTotal == null) warnings.push(`${w.machineId} tezgahından şu an veri gelmiyor: başlangıç sayacı kaydedilemedi; kasanın adedi tahmin edilemeyebilir (kesin adet paketlemede girilir).`);
    return { ...this.#crateView(this.db.getCrate(id), now), warnings };
  }

  /**
   * ÜRÜN TANITIM KARTI BAS (tek adım): kasa doldu, usta o üretimin iş emrinden kartı basar, kartı kasaya atıp paketlemeye yollar.
   * Her basış bir KASA kaydıdır (kart numarasını sistem verir, K000001...): önceki kartın basıldığı andan (ilk kartta iş emrinin
   * başlangıcından) şimdiye kadar tezgahın saydığı adet (telemetri, TAHMİN) ve tezgah sayacı kaydedilir; kesin adet paketlemede girilir.
   * Üretimdeki ya da bitmiş iş emrinde basılır (kasa iş emri bitirildikten sonra da doldurulabilir). Eski akıştan kalma AÇIK kasa varsa
   * o kapatılır ve kart olur. Kartta GKK rapor no boşsa basarken yazılabilir (iş emrine işlenir, geçmişe yazılır).
   * @param {{person?: string, gkkReportNo?: string, steps?: {washTo?: boolean, washDone?: boolean, dryTo?: boolean, dryDone?: boolean, annealTo?: boolean, annealDone?: boolean}}} [input]
   *   steps: kartta tiklenen işlemler (yıkamaya gidecek/yıkandı, kurutmaya gidecek/kurutuldu, tavlamaya gidecek/tavlandı); verilmezse hiçbiri işaretli değil
   *   reject: kartta "ÜRÜN RET" tiki: ret edilen kasa PAKETLEMEYE GİTMEZ (tekrar işleme ya da hurdaya ayrılır); verilmezse ret değil
   */
  issueCard(woNo, input = {}, { by = null, now = Date.now() } = {}) {
    const w = this.#get(woNo);
    if (w.status !== 'uretimde' && w.status !== 'bitti') {
      throw new PlanningError('Ürün tanıtım kartı yalnız üretimdeki ya da bitmiş iş emri için basılır.', 409, 'bad-status');
    }
    const person = text(input.person, 'Yapan kişi', 60);
    const gkk = input.gkkReportNo === undefined ? undefined : text(input.gkkReportNo, 'GKK rapor no', 40);
    const steps = parseSteps(input.steps) ?? parseSteps({}); // işaretler her kartta açıkça yazılır (verilmeyen = işaretsiz)
    const reject = parseReject(input.reject);
    const items = this.db.cratesOfWo(w.no); // iptal edilmiş değil, kart numarası sırasıyla
    const open = items.find((c) => c.state === 'acik') ?? null;
    const last = [...items].reverse().find((c) => c.closedAt != null) ?? null;
    const to = Math.max(w.status === 'bitti' ? (w.finishedAt ?? now) : now, open?.openedAt ?? 0);
    const openedAt = Math.min(last?.closedAt ?? w.startedAt ?? to, to);
    const startTotal = last ? last.endTotal : (w.startTotal ?? null);

    const id = this.db.tx(() => {
      let cid;
      if (open) cid = open.id;
      else {
        const { next } = this.db.nextCrateSeq();
        cid = this.db.insertCrate({ seq: next, woNo: w.no, machineId: w.machineId, openedAt, openedBy: by, openedPerson: person, startTotal, note: null });
      }
      if (gkk !== undefined && gkk !== null && gkk !== (w.gkkReportNo ?? null)) {
        const { cols, changed } = this.#diffFields(w, { gkkReportNo: gkk });
        if (changed.length > 0) {
          this.db.updateWorkOrder(w.no, cols, { by, now });
          this.db.addWorkOrderEvent(w.no, 'guncellendi', `${changed.join('; ')} (ürün tanıtım kartı basılırken)`.slice(0, 500), { by, now });
        }
      }
      this.db.updateCrate(cid, { ...stepsToColumns(steps), reject: reject ? 1 : 0 });
      this.#closeCrateRow(this.db.getCrate(cid), { by, person, to, now, event: 'kart-basildi', extra: [reject ? 'ÜRÜN RET (paketlemeye gitmez)' : '', stepsText(steps)].filter(Boolean).join(' · ') });
      return cid;
    });

    const v = this.#crateView(this.db.getCrate(id), now);
    const warnings = [];
    if (reject) warnings.push(`${v.cardNo} RET olarak basıldı: bu kasa paketlemeye gitmez (Paketleme listesine düşmez); tekrar işleme ya da hurdaya ayrılır.`);
    if (v.countedQty === 0) warnings.push('Önceki karttan bu yana tezgahta hiç parça sayılmadı: kart gereksiz basılmış olabilir (tezgah verisi geliyor mu, doğru iş emri mi?).');
    if (last && !open && to - last.closedAt < 120_000) warnings.push(`Az önce (${Math.max(1, Math.round((to - last.closedAt) / 1000))} sn önce) ${last.cardNo} basıldı: aynı kasa için ikinci kart basıyor olabilirsiniz. Yanlışsa kartı iptal edin.`);
    if (v.endTotal == null && w.status === 'uretimde') warnings.push(`${w.machineId} tezgahından şu an veri gelmiyor: sayaç kaydedilemedi; kasanın adedi tahmin edilemeyebilir (kesin adet paketlemede girilir).`);
    return { ...v, issuedAt: v.closedAt, warnings };
  }

  /** Kasayi kapat: sayilan adet (telemetri) ve bitis sayaci kaydedilir. Kesin adet paketlemede girilir. @param {{person?: string}} [input] */
  closeCrate(id, input = {}, { by = null, now = Date.now() } = {}) {
    const c = this.#crate(id);
    if (c.state === 'iptal') throw new PlanningError('İptal edilmiş kasa kapatılamaz.', 409, 'bad-status');
    if (c.state !== 'acik') throw new PlanningError(`${c.cardNo} numaralı kasa zaten kapalı.`, 409, 'bad-status');
    const person = text(input.person, 'Yapan kişi', 60);
    this.db.tx(() => this.#closeCrateRow(c, { by, person, to: now, now }));
    const v = this.#crateView(this.db.getCrate(c.id), now);
    const warnings = [];
    if (v.countedQty === 0) warnings.push('Bu kasa için hiç parça sayılmadı: tezgah verisi ya da kasa açma/kapama zamanı kontrol edilmeli.');
    return { ...v, warnings };
  }

  /**
   * Paketleme sayimi: paketlemede belli bir adetle paketlenen KESIN adet (kasa kapandiktan sonra). Duzeltme icin yeniden girilebilir.
   * @param {{qty: number|string, person?: string}} input
   */
  packCrate(id, input = {}, { by = null, now = Date.now() } = {}) {
    const c = this.#crate(id);
    if (c.state === 'iptal') throw new PlanningError('İptal edilmiş kasa paketlenemez.', 409, 'bad-status');
    if (c.state === 'acik') throw new PlanningError(`${c.cardNo} numaralı kasa hâlâ açık: önce kapatın.`, 409, 'crate-open');
    if (c.state === 'ret') throw new PlanningError(`${c.cardNo} numaralı kasa RET edilmiş: paketlemeye gitmez (tekrar işleme ya da hurdaya ayrılır).`, 409, 'rejected');
    const q = typeof input.qty === 'number' ? input.qty : Number(String(input.qty ?? '').trim().replace(/\./g, '').replace(',', '.'));
    if (!Number.isInteger(q) || q < 1 || q > 1_000_000) throw new PlanningError('Paketlenen adet 1 ile 1.000.000 arasında bir tam sayı olmalı.');
    const person = text(input.person, 'Yapan kişi', 60);
    this.db.tx(() => {
      this.db.updateCrate(c.id, { packed_qty: q, packed_at: now, packed_by: by, packed_person: person });
      const parts = [`${c.cardNo} · ${q} adet${c.packedQty != null ? ` (önceki ${c.packedQty})` : ''}`];
      if (person) parts.push(person);
      this.db.addWorkOrderEvent(c.woNo, 'kasa-paketlendi', parts.join(' · '), { by, now });
    });
    return this.#crateView(this.db.getCrate(c.id), now);
  }

  /** Yanlis acilan kasayi iptal et (paketlenmis kasa iptal edilemez). @param {{reason: string}} input */
  voidCrate(id, input = {}, { by = null, now = Date.now() } = {}) {
    const c = this.#crate(id);
    if (c.state === 'iptal') throw new PlanningError('Kasa zaten iptal edilmiş.', 409, 'bad-status');
    if (c.packedQty != null) throw new PlanningError('Paketlenmiş kasa iptal edilemez (paketleme adedi girilmiş).', 409, 'packed');
    const why = text(input.reason, 'İptal nedeni', 200);
    if (why === null || why.length < 3) throw new PlanningError('İptal nedeni gerekli (en az 3 karakter).');
    this.db.tx(() => {
      this.db.updateCrate(c.id, { voided_at: now, voided_by: by, void_reason: why });
      this.db.addWorkOrderEvent(c.woNo, 'kasa-iptal', `${c.cardNo} · ${why}`, { by, now });
    });
    return this.#crateView(this.db.getCrate(c.id), now);
  }

  getCrate(id, { now = Date.now() } = {}) {
    return this.#crateView(this.#crate(id), now);
  }

  /** @param {{woNo?: string, machineId?: string, state?: string, limit?: number, offset?: number}} [query] */
  listCrates(query = {}, { now = Date.now() } = {}) {
    const r = this.db.listCrates(query);
    return { total: r.total, items: r.items.map((c) => this.#crateView(c, now)) };
  }

  /** Kart numarasi sirasinin tabani: kagit defterdeki son numara degil, sistemin kendi sirasi (K + 6 hane); yalniz yonetici. */
  setCrateSequence(last) {
    const n = Number(String(last ?? '').trim());
    if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new PlanningError('Sıra 0 ile 999999 arasında bir tam sayı olmalı.');
    const info = this.db.nextCrateSeq();
    if (n < info.max) throw new PlanningError(`K${String(info.max).padStart(6, '0')} numarasına kadar zaten kart verilmiş.`, 409);
    this.db.raiseSeqFloor(0, n);
    const next = this.db.nextCrateSeq().next;
    return { next, nextCardNo: `K${String(next).padStart(6, '0')}` };
  }

  /* --------------------------------------------------- olcu kontrolu (EYS.FR.005) */

  /** Is emrinin olcu plani (satir tanimlari): ayni urunun plani yeni is emrine kopyalanir; burada duzenlenir. @param {{label: string, nominal?: any, lower?: any, upper?: any}[]} rows */
  setMeasurePlan(no, rows, { by = null, now = Date.now(), saveToProduct = false } = {}) {
    const w = this.#get(no);
    if (w.status === 'iptal') throw new PlanningError('İptal edilmiş iş emrinin ölçü planı değiştirilemez.', 409, 'cancelled');
    let plan;
    try { plan = normalizePlan(rows); } catch (err) { throw new PlanningError(err.message); }
    const used = this.db.maxMeasuredRow(w.no);
    if (plan.length < used) throw new PlanningError(`${used}. satırda ölçüm kaydı var: ölçü satırları silinemez (satırı yeniden adlandırabilirsiniz).`, 409, 'rows-in-use');
    this.db.tx(() => {
      this.db.updateWorkOrder(w.no, { measure_plan: JSON.stringify(plan), measure_plan_at: now }, { by, now });
      this.db.addWorkOrderEvent(w.no, 'olcu-plani', (plan.length === 0 ? 'ölçü planı boşaltıldı' : `${plan.length} ölçü: ${plan.map((r) => r.label).join(', ')}`).slice(0, 280) + (saveToProduct ? ' · ürün kartına da kaydedildi' : ''), { by, now });
      if (saveToProduct && this.db.getProduct(w.codeKey)) this.db.setProductMeasurePlan(w.codeKey, JSON.stringify(plan), now);
    });
    return this.getMeasurements(w.no, { now });
  }

  /** Urun kartinin KALICI olcu plani: her urunun olculeri (adi, nominal, sapmalar) ve sayisi farklidir; yeni is emirleri bunu kopyalar. */
  setProductMeasurePlan(stockCode, rows, { now = Date.now() } = {}) {
    const p = this.db.getProduct(foldTr(stockCode));
    if (!p) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
    let plan;
    try { plan = normalizePlan(rows); } catch (err) { throw new PlanningError(err.message); }
    this.db.setProductMeasurePlan(p.codeKey, JSON.stringify(plan), now);
    return this.getProduct(p.stockCode);
  }

  /** Slot (30 dk sutun) verisi: degerler (+ tolerans durumu), kontrol satirlari, kim/ne zaman. */
  #buildSlots(rows, plan) {
    const bySlot = new Map();
    for (const r of rows) {
      let s = bySlot.get(r.slot);
      if (!s) {
        s = { slot: r.slot, position: slotPosition(r.slot), measuredAt: r.measuredAt, by: r.by, person: r.person, values: {}, checks: { gorsel: null, gecer: null, gecmez: null }, outOfTol: [] };
        bySlot.set(r.slot, s);
      }
      if (r.measuredAt >= s.measuredAt) { s.measuredAt = r.measuredAt; s.by = r.by; s.person = r.person; }
      if (r.kind === 'olcu') {
        const status = evaluate(plan[r.rowNo - 1], r.value);
        s.values[r.rowNo] = { value: r.value, status };
        if (status === 'dusuk' || status === 'yuksek') s.outOfTol.push(r.rowNo);
      } else if (CHECK_KINDS.includes(r.kind)) s.checks[r.kind] = r.ok;
    }
    return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
  }

  /** Olcumun hangi kartin (kasanin) araligina dustugu: (acilis, kapanis]; acik ya da biten is emrinin son kartinda sonrasi da. null = henuz kart basilmamis. */
  #cardOfMeasurement(crates, w, ts) {
    for (let i = 0; i < crates.length; i += 1) {
      const c = crates[i];
      const isLast = i === crates.length - 1;
      const to = c.closedAt == null || (isLast && w.status === 'bitti') ? Infinity : c.closedAt;
      if (ts > c.openedAt && ts <= to) return c;
    }
    return null;
  }

  /** Is emrinin olcu kontrolu: plan (satir + tolerans sinirlari), tum slotlar (hangi karta ait oldugu ile) ve su anki sutun. */
  getMeasurements(no, { now = Date.now() } = {}) {
    const w = this.#get(no);
    const plan = w.measurePlan;
    const crates = this.db.cratesOfWo(w.no);
    const slots = this.#buildSlots(this.db.measurementsOfWo(w.no), plan).map((s) => {
      const c = this.#cardOfMeasurement(crates, w, s.measuredAt);
      return { ...s, card: c ? { id: c.id, cardNo: c.cardNo } : null };
    });
    return {
      woNo: w.no, status: w.status, stockCode: w.stockCode, productName: w.productName, machineId: w.machineId,
      plan: plan.map((r) => ({ ...r, ...limits(r) })), checks: CHECK_KINDS.map((k) => ({ kind: k, label: CHECK_LABEL[k] })),
      slots, currentSlot: slotOf(now), slotMinutes: SLOT_MIN, pending: slots.filter((s) => s.card === null).length,
    };
  }

  /**
   * Bir sutunun (varsayilan: su an) olcumlerini kaydeder (ayni sutun yeniden kaydedilirse guncellenir; bos birakilan deger silinir).
   * @param {{slot?: number|string, values?: Record<string, number|string|null>, checks?: {gorsel?: boolean|null, gecer?: boolean|null, gecmez?: boolean|null}, person?: string}} input
   */
  saveMeasurements(no, input = {}, { by = null, now = Date.now() } = {}) {
    const w = this.#get(no);
    if (w.status !== 'uretimde' && w.status !== 'bitti') throw new PlanningError('Ölçü kontrolü yalnız üretimdeki ya da bitmiş iş emrinde girilir.', 409, 'bad-status');
    const plan = w.measurePlan;
    if (plan.length === 0) throw new PlanningError('Önce ölçüleri tanımlayın (satır adı, nominal ve sapmalar).', 409, 'no-plan');
    const person = text(input.person, 'Yapan kişi', 60);
    const rawSlot = input.slot === undefined || input.slot === null || input.slot === '' ? now : Number(input.slot);
    if (!Number.isFinite(rawSlot)) throw new PlanningError('Ölçü zamanı geçersiz.');
    const slot = slotOf(rawSlot);
    if (slot > now + 20 * 60_000) throw new PlanningError('Ölçü zamanı gelecekte olamaz.');
    if (slot < now - 72 * 3_600_000) throw new PlanningError('Ölçü en fazla 72 saat geriye girilebilir.');

    const ops = [];
    for (const [key, raw] of Object.entries(input.values ?? {})) {
      const rowNo = Number(key);
      if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > plan.length) throw new PlanningError(`Ölçü satırı geçersiz: ${key} (1 ile ${plan.length} arası).`);
      const v = parseValue(raw);
      if (Number.isNaN(v)) throw new PlanningError(`${rowNo}. satır (${plan[rowNo - 1].label}): sayı olmalı (ör. 34,13).`);
      if (v !== null && Math.abs(v) > 1_000_000) throw new PlanningError(`${rowNo}. satır: değer çok büyük.`);
      ops.push(v === null ? { del: true, kind: 'olcu', rowNo } : { kind: 'olcu', rowNo, value: v });
    }
    for (const [kind, raw] of Object.entries(input.checks ?? {})) {
      if (!CHECK_KINDS.includes(kind)) throw new PlanningError(`Kontrol satırı geçersiz: ${kind}.`);
      if (raw === undefined) continue;
      if (raw !== null && typeof raw !== 'boolean') throw new PlanningError(`${CHECK_LABEL[kind]}: uygun / uygun değil / boş olmalı.`);
      ops.push(raw === null ? { del: true, kind, rowNo: 0 } : { kind, rowNo: 0, ok: raw ? 1 : 0 });
    }
    if (ops.length === 0) throw new PlanningError('Kaydedilecek ölçü ya da kontrol yok.');

    this.db.tx(() => {
      for (const o of ops) {
        if (o.del) this.db.deleteMeasurement(w.no, slot, o.kind, o.rowNo);
        else this.db.upsertMeasurement({ woNo: w.no, slot, kind: o.kind, rowNo: o.rowNo, value: o.value ?? null, ok: o.ok ?? null, measuredAt: now, by, person });
      }
      const nVal = ops.filter((o) => o.kind === 'olcu' && !o.del).length;
      const marks = ops.filter((o) => o.kind !== 'olcu' && !o.del).map((o) => `${CHECK_LABEL[o.kind].split(' ')[0].toLocaleLowerCase('tr-TR')} ${o.ok ? '✓' : '✕'}`);
      this.db.addWorkOrderEvent(w.no, 'olcu-kontrol', [slotPosition(slot).label, nVal ? `${nVal} ölçü` : null, ...marks, person].filter(Boolean).join(' · '), { by, now });
    });
    const view = this.getMeasurements(w.no, { now });
    const s = view.slots.find((x) => x.slot === slot) ?? null;
    const warnings = [];
    for (const rowNo of s?.outOfTol ?? []) {
      const r = plan[rowNo - 1];
      const st = s.values[rowNo];
      warnings.push(`${rowNo}. ölçü (${r.label}): ${String(st.value).replace('.', ',')} tolerans dışı (${st.status === 'dusuk' ? 'düşük' : 'yüksek'}). Makine durdurulur, bölüm sorumlusuna bilgi verilir.`);
    }
    for (const k of CHECK_KINDS) if (s?.checks[k] === false) warnings.push(`${CHECK_LABEL[k]}: uygun değil. Makine durdurulur, bölüm sorumlusuna bilgi verilir.`);
    return { ...view, saved: s, warnings };
  }

  /**
   * ÖLÇÜ RAPORLARI listesi (kalite kontrol ve paketlemeye giden raporlar): ölçüm girilmiş iş emirleri, en son ölçüm üstte. Her satırda sütun sayısı,
   * tolerans dışı sütun sayısı, karta bağlanmamış (kart bekleyen) sütun ve kartlar (kart başına sütun sayısı).
   */
  measureReports({ q = '', limit = 50, offset = 0 } = {}, { now = Date.now() } = {}) {
    const r = this.db.measureReportRows({ q, limit, offset });
    return {
      total: r.total,
      items: r.items.map((row) => {
        const w = this.#get(row.no);
        const m = this.getMeasurements(row.no, { now });
        return {
          no: w.no, status: w.status, stockCode: w.stockCode, productName: w.productName, machineId: w.machineId, machineNumber: machineNumber(w.machineId),
          planRows: w.measurePlan.length, columns: row.columns, lastAt: row.lastAt, pending: m.pending,
          flagged: m.slots.filter((s) => s.outOfTol.length > 0 || CHECK_KINDS.some((k) => s.checks[k] === false)).length,
          cards: this.db.cratesOfWo(w.no).map((c) => ({ id: c.id, cardNo: c.cardNo, state: c.state, columns: m.slots.filter((s) => s.card?.id === c.id).length })),
        };
      }),
    };
  }

  /** Bir iş emrinin TÜM ölçümleri tek raporda (kartlara bölünmeden); her sütun hangi karta düştüğünü taşır. */
  measureReport(no, { now = Date.now() } = {}) {
    const w = this.#get(no);
    const m = this.getMeasurements(w.no, { now });
    return {
      scope: 'is-emri', card: null,
      wo: { no: w.no, status: w.status, stockCode: w.stockCode, productName: w.productName, customerCode: w.customerCode, machineId: w.machineId, machineNumber: machineNumber(w.machineId), firstApprovalNo: w.firstApprovalNo, gkkReportNo: w.gkkReportNo },
      plan: m.plan, checks: m.checks, slots: m.slots, pending: m.pending,
      cards: this.db.cratesOfWo(w.no).map((c) => ({ id: c.id, cardNo: c.cardNo, state: c.state, columns: m.slots.filter((s) => s.card?.id === c.id).length })),
    };
  }

  /**
   * ÜRÜN TANITIM KARTININ ÖLÇÜ KONTROL FÖYÜ: kartın (kasanın) zaman aralığındaki ölçümler; kâğıt formun konumlarıyla (gündüz/gece blokları).
   * İş emri bitmişse son kartta bitişten sonra girilen ölçümler de görünür.
   */
  measureSheet(crateId, { now = Date.now() } = {}) {
    const c = this.#crate(crateId);
    const w = this.#get(c.woNo);
    const m = this.getMeasurements(w.no, { now });
    const slots = m.slots.filter((s) => s.card?.id === c.id);
    const view = this.#crateView(c, now);
    return {
      card: { id: c.id, cardNo: c.cardNo, state: view.state, openedAt: c.openedAt, closedAt: c.closedAt, issuedAt: c.closedAt ?? c.openedAt },
      wo: { no: w.no, stockCode: w.stockCode, productName: w.productName, customerCode: w.customerCode, machineId: w.machineId, machineNumber: machineNumber(w.machineId) },
      plan: m.plan, checks: m.checks, slots,
    };
  }

  /* ------------------------------------------------------------ duruslar (T) */

  /** Neden kodlari (aktif olanlar, gosterim sirasiyla) ve gruplar. */
  downtimeCodes() {
    return { groups: this.downtimeGroups, codes: this.db.listDowntimeCodes(), minStopMinutes: Math.round(this.downtimeMinMs / 60_000) };
  }

  /**
   * Bir tezgahin son `hours` saatteki OLCULMUS duruslari ve baglanmis nedenleri (en yeni uste). Durus = boşta/alarm/kapali araliklarin birlesimi,
   * esik suresinden uzun; veri yok (NO_DATA) durus degildir.
   */
  machineStops(machineId, { hours = 24, now = Date.now() } = {}) {
    const id = this.#machine(machineId);
    const h = Math.min(24 * 8, Math.max(1, Number(hours) || 24));
    const from = now - h * 3_600_000;
    const stops = buildStops(this.spans(id, from, now), { minMs: this.downtimeMinMs, now });
    return attachReasons(stops, this.db.downtimeReasonsFor(id, from, now)).reverse();
  }

  /**
   * Fabrika PC'si (operator) ana ekrani: tezgah basina canli durum, uretimdeki is emri ve ilerlemesi, sirada bekleyen (planlandi) is emirleri,
   * nedeni sorulmamis duruslar. Yalniz okur.
   */
  shopOverview({ now = Date.now() } = {}) {
    const running = this.db.listWorkOrders({ status: 'uretimde', limit: 500 }).items;
    const planned = this.db.listWorkOrders({ status: 'planlandi', limit: 500 }).items;
    // Son 24 saatte biten is emirleri: son kasa is emri bittikten SONRA da dolabilir, kart buradan basilir.
    const finishedRecent = this.db.listWorkOrders({ status: 'bitti', limit: 500 }).items.filter((x) => x.finishedAt != null && now - x.finishedAt < 24 * 3_600_000);
    return {
      now,
      minStopMinutes: Math.round(this.downtimeMinMs / 60_000),
      packing: { waiting: this.db.listCrates({ state: 'kapali', limit: 1 }).total }, // paketleme bekleyen (kapanmis, adedi girilmemis) kasa sayisi
      machines: this.listMachines().map((m) => {
        const w = running.find((x) => x.machineId === m.id) ?? null;
        const p = w ? this.#progressOf(w, now) : null;
        const stops = this.machineStops(m.id, { hours: 24, now });
        const open = stops.filter((st) => !st.answered);
        return {
          id: m.id, name: m.name ?? m.id,
          live: this.liveMachine(m.id) ? (({ connected, state, program }) => ({ connected, state, program }))(this.liveMachine(m.id)) : null,
          active: w ? {
            no: w.no, stockCode: w.stockCode, productName: w.productName, targetQty: w.targetQty, startedAt: w.startedAt, produced: p?.produced ?? 0, pct: p?.pct ?? 0,
            remaining: p?.remaining ?? w.targetQty, eta: p?.eta ?? null, sample: p?.sample ?? null, warnings: (p?.warnings ?? []).filter((x) => x.level === 'warn').length,
            crate: (() => {
              const c = this.db.openCrateOfWo(w.no);
              if (!c) return null;
              const v = this.#crateView(c, now);
              return { id: v.id, cardNo: v.cardNo, openedAt: v.openedAt, countedQty: v.countedQty };
            })(),
            crateCount: this.db.cratesOfWo(w.no).length,
            measure: { rows: w.measurePlan.length, last: this.db.lastMeasurementAt(w.no) },
            gkkReportNo: w.gkkReportNo, firstApprovalNo: w.firstApprovalNo, material: w.usedMaterial ?? w.material,
            // basilan kartlar (tek adimli akis): sayi ve en son kart
            cards: (() => {
              const items = this.db.cratesOfWo(w.no).filter((c) => c.closedAt != null);
              const lastCard = items.at(-1) ?? null;
              return { count: items.length, last: lastCard ? { id: lastCard.id, cardNo: lastCard.cardNo, at: lastCard.closedAt } : null };
            })(),
          } : null,
          finished: (() => {
            const f = finishedRecent.filter((x) => x.machineId === m.id).sort((a, b) => b.finishedAt - a.finishedAt)[0];
            return f ? { no: f.no, stockCode: f.stockCode, productName: f.productName, finishedAt: f.finishedAt } : null;
          })(),
          planned: planned.filter((x) => x.machineId === m.id).slice(0, 8)
            .map((x) => ({ no: x.no, stockCode: x.stockCode, productName: x.productName, targetQty: x.targetQty, dueDate: x.dueDate })),
          stops: { pending: open.length, pendingMs: open.reduce((a, st) => a + st.uncoveredMs, 0), ongoing: stops.find((st) => st.ongoing)?.from ?? null },
        };
      }),
    };
  }

  /**
   * Olculmus bir durusun alt araligina neden baglar. Aralik bir durusun (>= esik) icinde olmali (sinirlarda 60 sn hosgoru; durusa kirpilir),
   * ayni tezgahta baska nedenle cakisamaz. Kayit, o anda acik is emrine (varsa) baglanir.
   * @param {{machineId: string, from: number|string, to: number|string, code: string, note?: string, person?: string}} input
   */
  addDowntimeReason(input, { by = null, now = Date.now() } = {}) {
    const machineId = this.#machine(input.machineId);
    const code = this.db.listDowntimeCodes().find((c) => c.code === String(input.code ?? '').trim());
    if (!code) throw new PlanningError('Bilinmeyen duruş nedeni kodu.');
    const ms = (v, label) => {
      const n = typeof v === 'number' ? v : Date.parse(String(v));
      if (!Number.isFinite(n)) throw new PlanningError(`${label} geçerli bir tarih-saat olmalı.`);
      return n;
    };
    let from = ms(input.from, 'Başlangıç');
    let to = ms(input.to, 'Bitiş');
    if (to > now + 60_000) throw new PlanningError('Bitiş gelecekte olamaz.');
    if (to <= from) throw new PlanningError('Bitiş, başlangıçtan sonra olmalı.');
    if (from < now - 7 * 86_400_000) throw new PlanningError('Duruş nedeni en fazla 7 gün geriye girilebilir.');
    const note = text(input.note, 'Not', 200);
    const person = text(input.person, 'Yapan kişi', 60);

    const stop = this.machineStops(machineId, { hours: 7 * 24 + 1, now }).find((st) => from >= st.from - 60_000 && to <= st.to + 60_000);
    if (!stop) throw new PlanningError(`Bu aralık ölçülmüş bir duruşun içinde değil (en az ${Math.round(this.downtimeMinMs / 60_000)} dakikalık boşta/alarm duruşu olmalı).`, 400, 'no-stop');
    from = Math.max(from, stop.from);
    to = Math.min(to, stop.to);
    if (to - from < 1000) throw new PlanningError('Aralık çok kısa.');
    const clash = stop.reasons.find((r) => r.to > from && r.from < to);
    if (clash) throw new PlanningError(`${clash.code} nedeniyle çakışıyor (${fmtTime(clash.from)} – ${fmtTime(clash.to)}). Önce onu kaldırın ya da aralığı daraltın.`, 409, 'overlap');

    const wo = this.db.machineWindows(machineId).find((o) => o.startedAt <= from && (o.finishedAt == null || o.finishedAt >= from));
    const id = this.db.insertDowntimeReason({ machineId, from, to, code: code.code, note, woNo: wo?.no ?? null, person, by, now });
    return this.db.getDowntimeReason(id);
  }

  /** Nedeni kaldirir (yumusak silme: kim/ne zaman kayitli kalir). */
  removeDowntimeReason(id, { by = null, now = Date.now() } = {}) {
    const r = this.db.getDowntimeReason(Number(id));
    if (!r || r.deletedAt != null) throw new PlanningError('Duruş nedeni bulunamadı.', 404);
    this.db.deleteDowntimeReason(r.id, { by, now });
    return { ok: true };
  }

  close() {
    this.db.close();
  }
}
