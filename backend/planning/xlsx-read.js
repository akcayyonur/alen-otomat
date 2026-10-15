/**
 * Bagimliliksiz .xlsx okuyucu (yalniz DEGERLERI okur; bicim/formul/grafik yok).
 *
 * Neden: Excel'den "CSV UTF-8" kaydi yalniz acik sayfayi yazar, 12 haneli kodlari bilimsel gosterime ("6,01E+11") ceviren
 * gorunen metni dışa verir ve bos bicimli satirlari sisirir. .xlsx dosyasi ise degerleri tam hassasiyetle ve TUM sayfalariyla tasir.
 *
 * Kapsam: ZIP (merkezi dizin; depolanmis ya da deflate), workbook.xml (sayfa adlari, gizli), iliski dosyasi, sharedStrings (zengin metin dahil),
 * styles.xml (hangi hucre stili TARIH), sayfa XML'i (t=s/str/inlineStr/n/b/e). Tarih hucreleri `gg.aa.yyyy [SS:dd]` metnine cevrilir
 * (CSV iceri almadaki ayni cozumleyiciler calissin). Sayilar tam hassasiyetle, nokta ondalikli metne cevrilir.
 *
 * Sifreli dosya ya da eski .xls (OLE2) okunamaz: acik bir iletiyle reddedilir.
 */
import zlib from 'node:zlib';

export class XlsxError extends Error {}

/** Bir ZIP girdisinin ya da toplam acilmis boyut siniri (zip bombasina karsi). */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export const isZip = (buf) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
/** OLE2 (eski .xls ya da SIFRELI .xlsx kabugu). */
export const isOle2 = (buf) => buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;

/* ------------------------------------------------------------------------------------ zip */

/** @returns {Map<string, () => Buffer>} ad -> acici (tembel: yalniz gereken girdiler acilir) */
export function readZip(buf) {
  // Merkezi dizin sonu: son 64 KB + 22 bayt icinde geriye dogru ara.
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('ZIP yapısı okunamadı (dosya bozuk ya da .xlsx değil).');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || pos === 0xffffffff) throw new XlsxError('ZIP64 biçimi desteklenmiyor.');
  if (count > MAX_ENTRIES) throw new XlsxError(`Dosyada çok fazla parça var (${count}).`);

  /** @type {Map<string, () => Buffer>} */
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new XlsxError('ZIP merkezi dizini bozuk.');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // klasor girdisi

    entries.set(name, () => {
      if ((flags & 1) !== 0) throw new XlsxError('Dosya şifreli, açılamıyor. Şifreyi kaldırıp yeniden kaydedin.');
      if (size > MAX_ENTRY_BYTES) throw new XlsxError(`"${name}" çok büyük (${Math.round(size / 1048576)} MB).`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError(`"${name}" yerel başlığı bozuk.`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + compSize);
      if (raw.length !== compSize) throw new XlsxError(`"${name}" eksik (dosya kesilmiş).`);
      let out;
      if (method === 0) out = raw;
      else if (method === 8) {
        try { out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }); } catch (err) { throw new XlsxError(`"${name}" açılamadı: ${err.message}`); }
      } else throw new XlsxError(`"${name}" desteklenmeyen sıkıştırma (${method}).`);
      if (typeof zlib.crc32 === 'function' && zlib.crc32(out) !== crc) throw new XlsxError(`"${name}" bozuk (sağlama toplamı tutmuyor).`);
      return out;
    });
  }
  return entries;
}

/* ------------------------------------------------------------------------------------ xml */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  if (!s.includes('&') && !s.includes('_x')) return s;
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e];
    })
    // Excel, XML'e sigmayan karakterleri _xHHHH_ olarak yazar (ör. _x000D_).
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** `<tag a="1" b='2'>` ozniteliklerini {a, b} yapar (ad alani oneki atilir: r:id -> id). */
function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].replace(/^.*:/, '')] = decodeXml(m[2] ?? m[3]);
  return out;
}

/** Bir `<si>` ya da `<is>` govdesindeki tum `<t>` metinlerini birlestirir (zengin metin parcalari; fonetik `<rPh>` haric). */
function textOf(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) s += m[1] ?? '';
  return decodeXml(s);
}

/* --------------------------------------------------------------------------------- stiller */

/** Yerlesik tarih/saat bicimleri (ECMA-376 18.8.30). */
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Ozel bicim kodu tarih/saat mi: tirnakli metinler, kacisli karakterler ve renk/yerel koseli bolumleri atilir, gun/ay/yil/saat/sn harfi kalir mi. */
function isDateFormatCode(code) {
  const first = code.split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/_./g, '')
    .replace(/\*./g, '');
  if (/\[(?:h+|m+|s+)\]/i.test(first)) return false; // gecen sure ([h]:mm) takvim tarihi degil: sayi olarak kalir
  return /[dmyhs]/i.test(first.replace(/\[[^\]]*\]/g, ''));
}

/** @returns {boolean[]} stil indeksi -> tarih mi */
function readDateStyles(xml) {
  if (!xml) return [];
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.numFmtId !== undefined && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const styles = [];
  for (const m of block.matchAll(/<xf\b([^>]*?)\/?>/g)) {
    const id = Number(attrs(m[1]).numFmtId ?? 0);
    styles.push(custom.has(id) ? isDateFormatCode(custom.get(id)) : BUILTIN_DATE_IDS.has(id));
  }
  return styles;
}

/* ------------------------------------------------------------------------------- degerler */

const pad = (n) => String(n).padStart(2, '0');

/** Excel seri tarihi -> "gg.aa.yyyy" (+ " SS:dd" kesir varsa). Saat-yalniz seri (< 1) "SS:dd". */
export function serialToText(serial, date1904 = false) {
  const total = Math.round((serial + (date1904 ? 1462 : 0)) * 86400); // saniye (kayan nokta gurultusunu yuvarlar)
  const days = Math.floor(total / 86400);
  const secs = total - days * 86400;
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}`;
  if (serial >= 0 && serial < 1) return time;
  const d = new Date((days - 25569) * 86400000); // 25569 = 1970-01-01'in Excel serisi (1900 sistemi, 61 ve sonrasi dogru)
  const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return secs === 0 ? date : `${date} ${time}`;
}

function numberText(v) {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? String(n) : v;
}

/** "AB12" -> 27 (sifir tabanli sutun indeksi). */
function columnIndex(ref) {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ----------------------------------------------------------------------------------- sayfa */

function readSheet(xml, { shared, dateStyles, date1904 }) {
  /** @type {string[][]} */
  const rows = [];
  /** `rows[k]` satirinin Excel'deki gercek satir numarasi (bos satirlar atlandigi icin dizi indeksiyle ayni degildir). */
  const rowNumbers = [];
  let rowNo = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNo = Number(attrs(rm[1]).r) || rowNo + 1;
    const body = rm[2];
    if (!body) continue;
    const row = [];
    let next = 0;
    let any = false;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]);
      let col = a.r ? columnIndex(a.r) : -1;
      if (col < 0) col = next;
      next = col + 1;
      const inner = cm[2];
      if (!inner) continue;
      const raw = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      switch (a.t) {
        case 's': value = raw === undefined ? '' : (shared[Number(raw)] ?? ''); break;
        case 'inlineStr': value = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? ''); break;
        case 'str': value = raw === undefined ? '' : decodeXml(raw); break;
        case 'b': value = raw === '1' ? 'DOĞRU' : raw === '0' ? 'YANLIŞ' : ''; break;
        case 'e': value = raw === undefined ? '' : decodeXml(raw); break;
        case 'd': value = raw === undefined ? '' : decodeXml(raw); break; // ISO tarih metni (nadir)
        default: {
          if (raw === undefined) break;
          const n = Number(raw);
          value = dateStyles[Number(a.s ?? 0)] && Number.isFinite(n) ? serialToText(n, date1904) : numberText(raw);
        }
      }
      if (value === '') continue;
      while (row.length < col) row.push('');
      row[col] = value;
      any = true;
    }
    if (any) { rows.push(row); rowNumbers.push(rowNo); }
  }
  return { rows, rowNumbers };
}

/** Hedef yolu `xl/` kokune gore cozer (`worksheets/sheet1.xml` ya da `/xl/worksheets/sheet1.xml`). */
const resolveTarget = (t) => (t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`);

/**
 * @param {Buffer} buffer
 * @returns {{sheets: {name: string, hidden: boolean, rows: string[][], rowNumbers: number[]}[]}} rows: yalniz DOLU satirlar (bos satirlar atilir),
 *          degerler metin; rowNumbers: her satirin Excel'deki gercek satir numarasi
 */
export function readXlsx(buffer) {
  if (isOle2(buffer)) {
    throw new XlsxError('Bu dosya eski .xls biçiminde ya da şifreli. Excel\'de Farklı Kaydet → "Excel Çalışma Kitabı (.xlsx)" ile (şifresiz) kaydedip yükleyin.');
  }
  if (!isZip(buffer)) throw new XlsxError('Dosya .xlsx (Excel çalışma kitabı) değil.');
  const zip = readZip(buffer);
  const text = (name) => (zip.has(name) ? zip.get(name)().toString('utf8') : null);

  const workbook = text('xl/workbook.xml');
  if (workbook === null) throw new XlsxError('Bu bir Excel çalışma kitabı değil (xl/workbook.xml yok).');
  const rels = new Map();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target && /\/worksheet$/.test(a.Type ?? '')) rels.set(a.Id, resolveTarget(a.Target));
  }

  const shared = [];
  for (const m of (text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(m[1] ?? ''));
  const dateStyles = readDateStyles(text('xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(?:1|true)"/i.test(workbook);

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const target = rels.get(a.id);
    if (!a.name || !target) continue; // grafik sayfasi vb.
    const xml = text(target);
    if (xml === null) continue;
    sheets.push({ name: a.name, hidden: (a.state ?? 'visible') !== 'visible', ...readSheet(xml, { shared, dateStyles, date1904 }) });
  }
  if (sheets.length === 0) throw new XlsxError('Çalışma kitabında okunabilir sayfa bulunamadı.');
  return { sheets };
}
