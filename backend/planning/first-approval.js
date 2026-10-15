/**
 * İLK BASKI ONAY / NUMUNE TAKİP LİSTESİ (EYS.FR.013) için SAF yardımcılar (testli). Bu liste ilk onay raporunun KENDİSİDİR: her ilk onay bir kod alır
 * (İ26-1281) ve ürün kodu, GK kodu, iş emri no, tarih, operatör ve CNC no ile kaydedilir.
 */
import { foldTr, headerKey, parseDate, sheetRow } from './normalize.js';
import { parseGkNo } from './gkk.js';

export const formatApprovalCode = (year, seq) => `İ${String(year % 100).padStart(2, '0')}-${String(seq).padStart(3, '0')}`;

/** 'İ26-1281' (i/I/İ, '-' ya da '.', boşluk toleranslı) → {year, seq, code} | null */
export function parseApprovalCode(raw) {
  const t = foldTr(raw).replace(/\s+/g, '');
  const m = /^I(\d{2})[-.](\d{1,5})$/.exec(t);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const seq = Number(m[2]);
  if (seq < 1) return null;
  return { year, seq, code: formatApprovalCode(year, seq) };
}

/** Formda "GK-" önceden basılıdır: yalnız bu ya da boş ise GK kodu yazılmamıştır. */
function gkValue(raw) {
  const t = String(raw ?? '').trim();
  if (t === '' || /^GK-?$/i.test(t)) return null;
  const m = /GK\s*\d{2}\s*[.\-/]\s*\d{1,4}/i.exec(t);
  return (m && parseGkNo(m[0])?.no) || t.replace(/^GK-\s*/i, '') || null;
}

/** @returns {{index: Map<string, number>, headerRow: number}|null} */
export function findApprovalHeader(parsed) {
  const all = [parsed.headers, ...parsed.rows];
  for (let r = 0; r < Math.min(all.length, 12); r += 1) {
    const keys = all[r].map(headerKey);
    if (keys.includes('ILKBASKIONAYKODU') && keys.includes('URUNKODU')) {
      return { index: new Map(keys.map((k, i) => [k, i]).filter(([k]) => k !== '').reverse()), headerRow: r };
    }
  }
  return null;
}

/**
 * Excel'den CSV olarak kaydedilen EYS.FR.013 sayfası. Önceden basılmış BOŞ kodlar (yalnız İ26-1281 yazılı, "GK-" hariç başka alan boş) kayıt değildir:
 * bunlardan EN KÜÇÜĞÜ sıradaki numarayı gösterir (ondan önceki kodlar kullanılmış sayılır).
 * @param {{headers: string[], rows: string[][]}} parsed @param {(msg: string) => void} warn
 * @returns {{records: object[], firstBlank: Map<number, number>, skipped: number}} firstBlank: yıl → önceden basılmış en küçük boş sıra
 */
export function readApprovalSheet(parsed, warn = () => {}) {
  const found = findApprovalHeader(parsed);
  if (!found) return { records: [], firstBlank: new Map(), skipped: 0 };
  const all = [parsed.headers, ...parsed.rows];
  const { index } = found;
  const get = (row, key) => (index.has(key) ? String(row[index.get(key)] ?? '').trim() : '');
  const records = [];
  const firstBlank = new Map();
  let skipped = 0;
  let badDate = 0;
  for (let r = found.headerRow + 1; r < all.length; r += 1) {
    const row = all[r];
    const rawCode = get(row, 'ILKBASKIONAYKODU');
    if (rawCode === '') { skipped += 1; continue; }
    const code = parseApprovalCode(rawCode);
    if (!code) { skipped += 1; warn(`Satır ${sheetRow(parsed, r)}: ilk baskı onay kodu okunamadı ("${rawCode}"), atlandı.`); continue; }
    const stockCode = get(row, 'URUNKODU') || null;
    const gkCode = gkValue(get(row, 'GKKODU'));
    const woNo = get(row, 'ISEMRINO').replace(/\D/g, '') || null;
    const rawDate = get(row, 'TARIH');
    const date = rawDate === '' ? null : parseDate(rawDate);
    if (rawDate !== '' && date === null) badDate += 1;
    const operator = get(row, 'OPERATOR') || null;
    const cncRaw = get(row, 'CNCNO');
    const filled = stockCode || gkCode || woNo || date !== null || operator || cncRaw !== '';
    if (!filled) {
      firstBlank.set(code.year, Math.min(firstBlank.get(code.year) ?? Infinity, code.seq));
      continue;
    }
    const cnc = Number(cncRaw.replace(/\D/g, ''));
    records.push({
      code: code.code, year: code.year, seq: code.seq, stockCode, gkCode, woNo, approvedOn: date, operator,
      machineId: cncRaw === '' ? null : Number.isInteger(cnc) && cnc > 0 ? `CNC-${String(cnc).padStart(2, '0')}` : null,
    });
  }
  if (badDate > 0) warn(`${badDate} satırda tarih okunamadı (gg.aa.yyyy beklenir).`);
  return { records, firstBlank, skipped };
}
