/**
 * Test icin kucuk .xlsx YAZICISI (depo herkese acik: gercek veri yok). Sentetik calisma kitaplari uretir; xlsx.test.js ve sources.test.js kullanir.
 * Kurulum paketine GIRMEZ (build-installer.ps1 backend/planning/test klasorunu siler).
 */
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ test .xlsx yazicisi */

export function zipOf(files, { store = false, flags = 0 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = store ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800 | flags, 6); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800 | flags, 8); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Stil indeksleri: 0 genel, 1 yerlesik tarih (14), 2 ozel tarih (gg/aa/yyyy), 3 gecen sure ([h]:mm), 4 sayi + tirnakli "mm" (tarih DEGIL). */
const STYLES =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3">' +
  '<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="[h]:mm"/><numFmt numFmtId="166" formatCode="0.00 &quot;mm&quot;"/></numFmts>' +
  '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>';

const colLetter = (i) => String.fromCharCode(65 + i);
export const serial = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000 + 25569;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{name: string, hidden?: boolean, rows: (any[] | {r: number, c: any[]})[]}[]} sheets
 *   hucre: metin -> sharedStrings, sayi -> n, {n, s} stilli sayi, {b}, {e}, {inline}, {str}, null -> bos
 */
export function xlsxOf(sheets, { store = false, date1904 = false, flags = 0 } = {}) {
  const shared = [];
  const sst = (text) => { let i = shared.indexOf(text); if (i < 0) { shared.push(text); i = shared.length - 1; } return i; };
  const files = {};
  sheets.forEach((sh, k) => {
    let rowNo = 0;
    const rowsXml = sh.rows.map((row) => {
      const cells = Array.isArray(row) ? row : row.c;
      rowNo = Array.isArray(row) ? rowNo + 1 : row.r;
      const cx = cells.map((v, i) => {
        if (v === null || v === undefined) return '';
        const ref = `${colLetter(i)}${rowNo}`;
        if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (v.b !== undefined) return `<c r="${ref}" t="b"><v>${v.b ? 1 : 0}</v></c>`;
        if (v.e !== undefined) return `<c r="${ref}" t="e"><v>${v.e}</v></c>`;
        if (v.inline !== undefined) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v.inline)}</t></is></c>`;
        if (v.str !== undefined) return `<c r="${ref}" t="str"><f>A1&amp;B1</f><v>${esc(v.str)}</v></c>`;
        return `<c r="${ref}" s="${v.s ?? 0}"><v>${v.n}</v></c>`;
      }).join('');
      return `<row r="${rowNo}">${cx}</row>`;
    }).join('');
    files[`xl/worksheets/sheet${k + 1}.xml`] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] =
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets>` +
    sheets.map((sh, k) => `<sheet name="${esc(sh.name)}" sheetId="${k + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${k + 1}"/>`).join('') + '</sheets></workbook>';
  files['xl/_rels/workbook.xml.rels'] =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('') + '</Relationships>';
  files['xl/styles.xml'] = STYLES;
  files['xl/sharedStrings.xml'] = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`;
  return zipOf(files, { store, flags });
}

