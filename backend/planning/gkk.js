/**
 * GKK (Giriş Kalite Kontrol) RAPOR NUMARASI TAKİP FORMU (EYS.FR.011) için SAF yardımcılar (testli):
 *   - rapor numarası biçimi: GK26.396 (GK + yıl 2 hane + nokta + sıra)
 *   - hammadde cinsi çözümleme: kayıttaki "AA24 X 13 - PB3" ile iş emrindeki ERP kodu "HM614.AA24.00XYU13.00" AYNI hammaddeyi anlatır;
 *     ustalar iş emrine yazılacak GK numarasını listeden bu eşleşmeyle bulur
 *   - formun CSV'sini (Excel'den kaydedilmiş) okuma
 *
 * Eşleşme kuralı (gerçek verideki iş emirlerinin %81'i bir kayıtla eşleşti; kalanı için listede zaten karşılığı yok):
 *   ERP kodu  HM{alaşım}.{şekil}{ölçü}.00[X{şekil}{iç ölçü}.00]      kayıt   {şekil}{ölçü} [X {iç ölçü}] - {alaşım adı}
 *   şekil     YU = yuvarlak (kayıtta YUV), AA = altıgen, SK = 8 köşe (kayıtta "8 KÖŞE")
 *   alaşım    614 → PB3, 617 → PB2, 602 → 602N, 603 → CW603N, 3604 → C3604BD
 *   Kayıtta ölçünün ardından gelen EK sözcükler (ISIL İŞLEMLİ, HB, TAVLI, R430S ...) ayrı işlemi gösterir: aynı ölçü ama farklı malzeme, bu yüzden
 *   ek sözcükleri ERP koduyla birebir tutanlar "tam eşleşme", tutmayanlar "aynı ölçü, işlem farklı" diye ayrı sınıflanır (ustaya gösterilir, seçtirilir).
 */
import { foldTr, headerKey, parseDate } from './normalize.js';

export const ALLOY_ERP = Object.freeze({ 614: 'PB3', 617: 'PB2', 602: '602N', 603: 'CW603N', 3604: 'C3604BD' });
const SHAPE_ORDER = ['YUV', 'AA', 'SK'];

const pad3 = (n) => String(n).padStart(3, '0');
export const formatGkNo = (year, seq) => `GK${String(year % 100).padStart(2, '0')}.${pad3(seq)}`;

/** 'GK26.396' (boşluk, küçük harf, '-' ya da '/' toleranslı) → {year, seq, no} | null */
export function parseGkNo(raw) {
  const t = foldTr(raw).replace(/\s+/g, '');
  const m = /^GK(\d{2})[.\-/](\d{1,4})$/.exec(t);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const seq = Number(m[2]);
  if (seq < 1) return null;
  return { year, seq, no: formatGkNo(year, seq) };
}

/** Arama/benzersizlik anahtarı: Türkçe harfler ASCII, yalnız harf-rakam ("AA24 X 13 - PB3" → "AA24X13PB3"). */
export const compactKey = (text) => foldTr(text).replace(/[^A-Z0-9]/g, '');

const num = (s) => Number(String(s).replace(',', '.'));
const extraKey = (s) => foldTr(s).replace(/[^A-Z0-9]/g, '');

/**
 * Kayıttaki hammadde metni → {shape, dims, alloy, extra} | null (tanınmayan biçim: ör. "ST014.013 - 900000185" dövme ürün satırı).
 * @param {string} text
 */
export function parseMaterial(text) {
  const t = foldTr(text).replace(/\s+/g, ' ').trim();
  const m = /^(YUV|YU|AA|SK|8 ?KOSE)\s*(\d+(?:[.,]\d+)?)(?:\s*X\s*(\d+(?:[.,]\d+)?))?\s*-\s*(PB2|PB3|CW603N|603N|602 ?N|C3604BD)\b\s*(.*)$/.exec(t);
  if (!m) return null;
  const shape = m[1].startsWith('Y') ? 'YUV' : m[1] === 'AA' ? 'AA' : 'SK';
  const alloy = { '603N': 'CW603N', '602 N': '602N' }[m[4]] ?? m[4];
  return { shape, dims: m[3] === undefined ? [num(m[2])] : [num(m[2]), num(m[3])], alloy, extra: extraKey(m[5]) };
}

/**
 * İş emrindeki ERP hammadde kodu ("HM614.YU23.00XYU16.00") → {shape, dims, alloy, extra} | null ("DÖVME ÜRÜN" gibi kodsuz değerler).
 * @param {string} code
 */
export function parseErpMaterial(code) {
  const t = foldTr(code).replace(/\s+/g, '');
  const m = /^HM(\d{3,4})([A-Z]{0,3})\.(YU|AA|SK)(\d+(?:\.\d+)?)(?:X(?:YU|AA|SK)?(\d+(?:\.\d+)?))?(.*)$/.exec(t);
  if (!m) return null;
  const alloy = ALLOY_ERP[Number(m[1])];
  if (!alloy) return null;
  const shape = m[3] === 'YU' ? 'YUV' : m[3];
  return { shape, dims: m[5] === undefined ? [num(m[4])] : [num(m[4]), num(m[5])], alloy, extra: extraKey(`${m[2]}${m[6]}`) };
}

const sameBase = (a, b) => a.shape === b.shape && a.alloy === b.alloy && a.dims.length === b.dims.length && a.dims.every((d, i) => Math.abs(d - b.dims[i]) < 1e-9);

/**
 * Bir iş emrinin hammaddesi için kayıtlardan eşleşenleri sınıflar ve sıralar.
 *   'tam'      : ölçü, şekil, alaşım ve ek işlem aynı
 *   'islemli'  : ölçü/şekil/alaşım aynı, kayıtta ek işlem var (ISIL İŞLEMLİ, HB ...) ya da iş emrinde var, kayıtta yok
 *   'urun'     : dövme ürünler için: kayıtta ürünün stok kodu geçiyor
 * Sıra: tam, ürün, işlemli; her grupta yeni rapor (üretici tarihi, sonra numara) önce.
 * @param {{id: number, material: string, producerDate: number|null, year: number|null, seq: number|null}[]} items
 * @param {{erpMaterial?: string|null, stockCode?: string|null}} q
 * @returns {{id: number, kind: 'tam'|'islemli'|'urun'}[]}
 */
export function matchMaterials(items, { erpMaterial = null, stockCode = null } = {}) {
  const erp = erpMaterial ? parseErpMaterial(erpMaterial) : null;
  const stock = stockCode ? foldTr(stockCode) : null;
  const out = [];
  for (const it of items) {
    const reg = parseMaterial(it.material);
    if (erp && reg && sameBase(erp, reg)) out.push({ id: it.id, kind: erp.extra === reg.extra ? 'tam' : 'islemli', it });
    else if (stock && !reg && foldTr(it.material).includes(stock)) out.push({ id: it.id, kind: 'urun', it });
  }
  const rank = { tam: 0, urun: 1, islemli: 2 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind]
    || (b.it.producerDate ?? 0) - (a.it.producerDate ?? 0)
    || (b.it.year ?? 0) - (a.it.year ?? 0) || (b.it.seq ?? 0) - (a.it.seq ?? 0));
  return out.map(({ id, kind }) => ({ id, kind }));
}

/** Liste sırası: formdaki gibi (YUV…, AA…, 8 KÖŞE…, sonra diğerleri); aynı grupta ölçüye göre. */
export function compareMaterials(a, b) {
  const pa = parseMaterial(a);
  const pb = parseMaterial(b);
  if (pa && pb) {
    return SHAPE_ORDER.indexOf(pa.shape) - SHAPE_ORDER.indexOf(pb.shape) || pa.dims[0] - pb.dims[0] || (pa.dims[1] ?? 0) - (pb.dims[1] ?? 0)
      || pa.alloy.localeCompare(pb.alloy) || pa.extra.localeCompare(pb.extra);
  }
  if (pa) return -1;
  if (pb) return 1;
  return foldTr(a).localeCompare(foldTr(b), 'tr');
}

/* ------------------------------------------------------------------ form CSV'si */

/**
 * Excel'den CSV olarak kaydedilen EYS.FR.011 sayfası. İlk dolu satır başlık değil, form başlığıdır; sütun başlıkları birkaç satır aşağıdadır
 * (SIRA | ÜRÜN | RAPOR NO | ÜRETİCİ RAPOR TARİHİ | AÇIKLAMA). Sayfanın altında, ürünü yazılmamış, önceden basılmış BOŞ numaralar da vardır: bunlar
 * kayıt DEĞİLDİR (yalnız kullanılmış numaraların en büyüğü sıradaki numarayı belirler).
 * @param {{headers: string[], rows: string[][]}} parsed @returns {{index: Map<string, number>, headerRow: number}|null}
 */
export function findGkkHeader(parsed) {
  const all = [parsed.headers, ...parsed.rows];
  for (let r = 0; r < Math.min(all.length, 12); r += 1) {
    const keys = all[r].map(headerKey);
    if (keys.includes('RAPORNO') && keys.includes('URETICIRAPORTARIHI')) {
      return { index: new Map(keys.map((k, i) => [k, i]).filter(([k]) => k !== '').reverse()), headerRow: r };
    }
  }
  return null;
}

/**
 * @param {{headers: string[], rows: string[][]}} parsed @param {(msg: string) => void} warn
 * @returns {{records: {sortNo: number|null, material: string, reportNo: string, year: number, seq: number, producerDate: number|null, note: string|null}[],
 *            freeNumbers: number, skipped: number}}
 */
export function readGkkSheet(parsed, warn = () => {}) {
  const found = findGkkHeader(parsed);
  if (!found) return { records: [], freeNumbers: 0, skipped: 0 };
  const all = [parsed.headers, ...parsed.rows];
  const { index } = found;
  const get = (row, key) => (index.has(key) ? String(row[index.get(key)] ?? '').trim() : '');
  const records = [];
  let freeNumbers = 0;
  let skipped = 0;
  let badDate = 0;
  for (let r = found.headerRow + 1; r < all.length; r += 1) {
    const row = all[r];
    const rawNo = get(row, 'RAPORNO');
    const material = get(row, 'URUN').replace(/\s+/g, ' ');
    if (rawNo === '' && material === '') { skipped += 1; continue; }
    const no = parseGkNo(rawNo);
    if (!no) {
      skipped += 1;
      if (material !== '' || rawNo !== '') warn(`Satır ${r + 1}: rapor numarası okunamadı ("${rawNo}"), atlandı.`);
      continue;
    }
    if (material === '') { freeNumbers += 1; continue; } // önceden basılmış boş numara
    const rawDate = get(row, 'URETICIRAPORTARIHI');
    const date = rawDate === '' ? null : parseDate(rawDate);
    if (rawDate !== '' && date === null) badDate += 1;
    const sort = Number(get(row, 'SIRA'));
    records.push({
      sortNo: Number.isInteger(sort) && sort > 0 ? sort : null, material, reportNo: no.no, year: no.year, seq: no.seq,
      producerDate: date, note: get(row, 'ACIKLAMA') || null,
    });
  }
  if (badDate > 0) warn(`${badDate} satırda üretici rapor tarihi okunamadı (gg.aa.yyyy beklenir).`);
  return { records, freeNumbers, skipped };
}
