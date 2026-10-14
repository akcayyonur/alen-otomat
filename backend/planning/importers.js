/**
 * Excel'den "CSV" olarak kaydedilen iki dosyanin iceri alinmasi. Bicim BASLIKLARDAN otomatik tanınır:
 *
 *   is emirleri listesi (PLANLANAN sayfasi): ALEN KOD, MAMÜL ADI, MÜŞTERİ KODU, HAMMADDE, ALTERNATİF HM, ÜRETİM SN, BRÜT GR, NET GR ...
 *       -> URUN KARTLARI (her stok kodu icin EN SON is emrindeki degerler)
 *   siparis dosyasi (_SIPARIS sayfasi): Mamul_Kodu, Evrak_No, Must_Sip_No, Miktar, Sevk_Edilen_Miktar, Kalan_Miktar, HM, TAM BOY, BR, NT, SN ...
 *       -> SIPARIS SATIRLARI (+ urun kartlarinda eksik alanlar: tam boy, hammadde, agirliklar, sure)
 *
 * Kurallar:
 *   - Elle duzenlenmis urun kartinin (edited) alanlari iceri alma ile EZILMEZ; yalniz bos alanlar doldurulur.
 *   - Tekrar iceri alma guvenlidir (idempotent): satirlar `line_key` ile eslesir.
 *   - Bozuk veri sessizce yutulmaz: uyarilar sonucta listelenir (bilimsel gosterimli musteri kodu, gecersiz urun kodu ...).
 *   - Agirliklar KG (Excel basligi "GR" olsa da degerler kg: 0,0179 = 17,9 g).
 */
import { decodeCsv, parseCsv } from './csv-read.js';
import { cleanCode, foldTr, headerKey, isScientific, looseKey, parseDate, parseNumber } from './normalize.js';
import { findGkkHeader } from './gkk.js';
import { findApprovalHeader } from './first-approval.js';

export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_WARNINGS = 25;
/** Mikro stok kodu bicimi (SR001.013, Nİ002.001): bunlar urundur; PR-001 (talas), TM-001, HM... urun karti degildir. */
const PRODUCT_CODE = /^[A-ZİÇĞÖŞÜ]{2}\d{3}\.\d{3}$/i;
/** Urun kodunda bosluk, virgul, noktali virgul, egik cizgi olmaz (bozuk hucre). */
const SANE_CODE = /^[^\s,;/\\]{2,40}$/;

class Warnings {
  constructor() { this.items = []; this.dropped = 0; }
  add(message) { if (this.items.length < MAX_WARNINGS) this.items.push(message); else this.dropped += 1; }
  list() { return this.dropped > 0 ? [...this.items, `… ve ${this.dropped} uyarı daha`] : this.items; }
}

const indexOf = (headers) => new Map(headers.map((h, i) => [headerKey(h), i]));
const cell = (idx, row, key) => (idx.has(key) ? String(row[idx.get(key)] ?? '').trim() : '');
const positive = (n) => (n != null && n > 0 ? n : null);
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : (a ?? null) === (b ?? null));

/** Gelen alanlari mevcut karta uygular: duzenlenmis kartta yalniz bos alanlar, digerinde dolu gelenler. */
function applyIncoming(cur, incoming, { fillOnly = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined) continue; // dosyada yok: mevcut deger korunur
    if ((fillOnly || cur?.edited) && cur && cur[k] !== null && cur[k] !== undefined) continue;
    out[k] = v;
  }
  return out;
}

function saveIfChanged(db, key, stockCode, incoming, { source, by, now, fillOnly }) {
  const cur = db.getProduct(key);
  const fields = applyIncoming(cur, incoming, { fillOnly });
  if (!cur) {
    db.saveProduct(key, { stockCode, ...fields }, { source, by, now });
    return 'added';
  }
  const changed = Object.entries(fields).some(([k, v]) => !same(cur[k], v));
  if (!changed) return 'unchanged';
  db.saveProduct(key, fields, { source: cur.edited ? cur.source : source, by, now });
  return 'updated';
}

/**
 * Form sayfalari (EYS.FR.011 GKK rapor numaralari, EYS.FR.013 ilk baskı onay listesi): sutun basliklari ilk satirda degil, form basliginin
 * birkac satir altindadir; bu yuzden `detectFormat`tan once aranir.
 * @returns {'gkk'|'ilkonay'|null}
 */
export function detectForm(parsed) {
  if (findGkkHeader(parsed)) return 'gkk';
  if (findApprovalHeader(parsed)) return 'ilkonay';
  return null;
}

/** @returns {'isemri'|'siparis'|null} */
export function detectFormat(headers) {
  const keys = new Set(headers.map(headerKey));
  if (keys.has('ALENKOD') && keys.has('MAMULADI')) return 'isemri';
  if (keys.has('MAMULKODU') && keys.has('EVRAKNO')) return 'siparis';
  return null;
}

/* ------------------------------------------------------------ is emirleri -> urun kartlari */

function importIsEmri(db, parsed, ctx) {
  const idx = indexOf(parsed.headers);
  const warnings = ctx.warnings;
  /** @type {Map<string, {no: number, row: string[], stock: string}>} */
  const latest = new Map();
  /** Yil -> dosyada gorulen en buyuk is emri sirasi: yeni is emri numarasi buradan devam eder (Excel ile cakismasin). */
  const floors = new Map();
  let totalRows = 0;
  let skipped = 0;
  let noSec = 0;

  parsed.rows.forEach((row, i) => {
    const stock = cell(idx, row, 'ALENKOD');
    if (stock === '') { skipped += 1; return; } // numarasi onceden verilmis bos is emri satiri
    if (!SANE_CODE.test(stock)) {
      skipped += 1;
      warnings.add(`Satır ${i + 2}: ürün kodu geçersiz görünüyor ("${stock}"), atlandı.`);
      return;
    }
    totalRows += 1;
    const digits = cell(idx, row, 'URETIMEMRINO').replace(/\D/g, '');
    const no = digits === '' ? i : Number(digits);
    if (digits.length === 10) {
      const year = Number(digits.slice(0, 4));
      if (year >= 2000 && year <= 2100) floors.set(year, Math.max(floors.get(year) ?? 0, Number(digits.slice(4))));
    }
    const key = foldTr(stock);
    const prev = latest.get(key);
    if (!prev || no >= prev.no) latest.set(key, { no, row, stock });
  });

  const tally = { added: 0, updated: 0, unchanged: 0 };
  db.tx(() => {
    for (const [key, { row, stock }] of latest) {
      const rawCustomer = cell(idx, row, 'MUSTERIKODU');
      let customerCode = null;
      if (isScientific(rawCustomer)) {
        warnings.add(`${stock}: müşteri kodu bilimsel gösterimde ("${rawCustomer}"), değer kaybolmuş. Excel'de o sütunu "Sayı, 0 ondalık" yapıp yeniden kaydedin.`);
      } else if (rawCustomer !== '') customerCode = cleanCode(rawCustomer);

      const alt = cell(idx, row, 'ALTERNATIFHM');
      const sec = positive(parseNumber(cell(idx, row, 'URETIMSN')));
      if (sec === null) noSec += 1;
      const incoming = {
        name: cell(idx, row, 'MAMULADI') || null,
        customerCode,
        material: cell(idx, row, 'HAMMADDE') || null,
        altMaterial: alt === '' || alt === '0' ? null : alt,
        plannedSec: sec,
        grossKg: positive(parseNumber(cell(idx, row, 'BRUTGR'))),
        netKg: positive(parseNumber(cell(idx, row, 'NETGR'))),
      };
      tally[saveIfChanged(db, key, stock, incoming, { source: 'csv-isemri', by: ctx.by, now: ctx.now })] += 1;
    }
    for (const [year, seq] of floors) db.raiseSeqFloor(year, seq);
  });
  if (noSec > 0) warnings.add(`${noSec} üründe planlanan süre (ÜRETİM SN) boş.`);

  return { totalRows, skipped, ...tally, products: { ...tally }, staleMarked: 0, seqFloor: Object.fromEntries(floors) };
}

/* -------------------------------------------------------------- siparis -> siparis satirlari */

function importSiparis(db, parsed, ctx) {
  const idx = indexOf(parsed.headers);
  const warnings = ctx.warnings;
  const batchId = ctx.batchId;
  const seen = new Map(); // line_key tekrar sayaci
  /** @type {Map<string, object>} urun karti ipuclari: stok kodu anahtari -> en yeni satirin degerleri */
  const hints = new Map();
  const tally = { added: 0, updated: 0, unchanged: 0 };
  let totalRows = 0;
  let skipped = 0;
  let noDate = 0;

  db.tx(() => {
    parsed.rows.forEach((row, i) => {
      const code = cell(idx, row, 'MAMULKODU');
      const docNo = cleanCode(cell(idx, row, 'EVRAKNO'));
      if (code === '' && docNo === '') { skipped += 1; return; }
      if (code === '' || docNo === '') {
        skipped += 1;
        warnings.add(`Satır ${i + 2}: ${code === '' ? 'mamul kodu' : 'evrak no'} boş, atlandı.`);
        return;
      }
      totalRows += 1;
      const qty = parseNumber(cell(idx, row, 'MIKTAR'), { integer: true });
      const orderDate = parseDate(cell(idx, row, 'SIPTARIHI'));
      if (orderDate === null) noDate += 1;
      const customer = cell(idx, row, 'MUSTERI');
      const custOrderNo = cleanCode(cell(idx, row, 'MUSTSIPNO'));
      const codeKey = foldTr(code);
      const base = [looseKey(docNo), codeKey, qty ?? '', orderDate ?? ''].join('|');
      const n = (seen.get(base) ?? 0) + 1; // ayni evrakta ayni urun ayni miktar/tarihle birden cok satir olabilir
      seen.set(base, n);

      const material = cell(idx, row, 'HM') || null;
      const line = {
        lineKey: `${base}|${n}`, source: 'csv', docNo, docKey: looseKey(docNo), customer, customerKey: foldTr(customer),
        custOrderNo, custOrderKey: looseKey(custOrderNo), codeKey, stockCode: code,
        itemName: cell(idx, row, 'MAMULADI') || null, itemKey: foldTr(cell(idx, row, 'MAMULADI')), orderDate, qty,
        shipped: parseNumber(cell(idx, row, 'SEVKEDILENMIKTAR'), { integer: true }),
        remaining: parseNumber(cell(idx, row, 'KALANMIKTAR'), { integer: true }),
        dueDate: parseDate(cell(idx, row, 'TEYITEDILENTARIH')), material,
      };
      tally[db.upsertLine(line, batchId)] += 1;

      if (PRODUCT_CODE.test(code)) {
        const prev = hints.get(codeKey);
        if (!prev || (orderDate ?? 0) >= (prev.orderDate ?? 0)) {
          hints.set(codeKey, {
            orderDate, stock: code, name: cell(idx, row, 'MAMULADI') || null, material,
            lengthMm: positive(parseNumber(cell(idx, row, 'TAMBOY'))),
            grossKg: positive(parseNumber(cell(idx, row, 'BR'))), netKg: positive(parseNumber(cell(idx, row, 'NT'))),
            plannedSec: positive(parseNumber(cell(idx, row, 'SN'))),
          });
        }
      }
    });
  });

  // Urun kartlari: tam boy siparis dosyasindan guncellenir; digerleri yalniz bos kalmissa doldurulur.
  const products = { added: 0, updated: 0, unchanged: 0 };
  db.tx(() => {
    for (const [key, h] of hints) {
      const cur = db.getProduct(key);
      const incoming = { name: h.name, material: h.material, grossKg: h.grossKg, netKg: h.netKg, plannedSec: h.plannedSec };
      const result = saveIfChanged(db, key, h.stock, incoming, { source: 'csv-siparis', by: ctx.by, now: ctx.now, fillOnly: true });
      let outcome = result;
      if (h.lengthMm !== null && (!cur || !cur.edited) && cur?.lengthMm !== h.lengthMm) {
        db.saveProduct(key, { lengthMm: h.lengthMm }, { source: db.getProduct(key).source, by: ctx.by, now: ctx.now });
        if (outcome === 'unchanged') outcome = 'updated';
      }
      products[outcome] += 1;
    }
  });

  if (noDate > 0) warnings.add(`${noDate} satırda sipariş tarihi okunamadı (gg.aa.yyyy ya da yyyy-aa-gg beklenir).`);
  const staleMarked = ctx.keepOld ? 0 : db.markStale('csv', batchId);
  return { totalRows, skipped, ...tally, products, staleMarked };
}

/* ------------------------------------------------------------------------------- girdi */

/**
 * @param {import('./planning-db.js').PlanningDb} db
 * @param {Buffer} buffer
 * @param {{filename?: string|null, by?: string|null, keepOld?: boolean, now?: number}} [opts]
 */
export function importCsv(db, buffer, { filename = null, by = null, keepOld = false, now = Date.now(), quality = null } = {}) {
  if (!buffer || buffer.length === 0) throw new ImportError('Dosya boş.');
  const { text, encoding } = decodeCsv(buffer);
  const parsed = parseCsv(text);
  if (parsed.headers.length === 0) throw new ImportError('Dosyada başlık satırı bulunamadı.');

  const form = quality ? detectForm(parsed) : null;
  if (form) {
    const warnings = new Warnings();
    const batchId = db.beginBatch(form, { filename, by, now });
    const ctx = { warn: (m) => warnings.add(m), now, by };
    const result = form === 'gkk' ? quality.importGkk(parsed, ctx) : quality.importApprovals(parsed, ctx);
    db.finishBatch(batchId, { totalRows: result.totalRows, added: result.added, updated: result.updated, unchanged: result.unchanged, skipped: result.skipped, warnings: warnings.list() });
    return { format: form, encoding, delimiter: parsed.delimiter, batchId, ...result, warnings: warnings.list() };
  }

  const format = detectFormat(parsed.headers);
  if (!format) {
    throw new ImportError(
      'Dosya tanınmadı. Beklenen: iş emirleri listesi (ALEN KOD, MAMÜL ADI … başlıkları), sipariş dosyası (Mamul_Kodu, Evrak_No … başlıkları), GKK rapor numaraları (EYS.FR.011: RAPOR NO, ÜRETİCİ RAPOR TARİHİ) ya da ilk baskı onay listesi (EYS.FR.013: İLK BASKI ONAY KODU, ÜRÜN KODU). ' +
      `Bulunan ilk başlıklar: ${parsed.headers.slice(0, 6).join(', ')}`,
    );
  }

  const warnings = new Warnings();
  const batchId = db.beginBatch(format, { filename, by, now });
  const ctx = { by, now, warnings, batchId, keepOld };
  const result = format === 'isemri' ? importIsEmri(db, parsed, ctx) : importSiparis(db, parsed, ctx);
  db.finishBatch(batchId, {
    totalRows: result.totalRows, added: result.added, updated: result.updated, unchanged: result.unchanged,
    skipped: result.skipped, warnings: warnings.list(),
  });
  return { format, encoding, delimiter: parsed.delimiter, batchId, ...result, warnings: warnings.list() };
}
