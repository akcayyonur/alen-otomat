/**
 * .xlsx okuyucu ve cok sayfali iceri alma: ZIP/XML okuma, tarih stilleri, Excel satir numaralari, sayfa secimi, hata iletileri, HTTP ucu.
 * TUM veriler sentetiktir; test .xlsx dosyalari asagidaki kucuk yazicıyla uretilir (depo herkese acik).
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { isZip, readXlsx, readZip, serialToText, XlsxError } from './xlsx-read.js';
import { ImportError } from './importers.js';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

/* ------------------------------------------------------------------ test .xlsx yazicisi */

function zipOf(files, { store = false, flags = 0 } = {}) {
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
const serial = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000 + 25569;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{name: string, hidden?: boolean, rows: (any[] | {r: number, c: any[]})[]}[]} sheets
 *   hucre: metin -> sharedStrings, sayi -> n, {n, s} stilli sayi, {b}, {e}, {inline}, {str}, null -> bos
 */
function xlsxOf(sheets, { store = false, date1904 = false, flags = 0 } = {}) {
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

/* -------------------------------------------------------------------------- okuyucu */

test('serialToText: tarih, tarih+saat, saat; 1904 sistemi; kayan nokta gurultusu yuvarlanir', () => {
  assert.equal(serialToText(serial(2026, 10, 12)), '12.10.2026');
  assert.equal(serialToText(serial(2026, 10, 12) + 0.5), '12.10.2026 12:00');
  assert.equal(serialToText(serial(2026, 10, 12) + 0.7708333333333334), '12.10.2026 18:30');
  assert.equal(serialToText(0.25), '06:00');
  assert.equal(serialToText(serial(2026, 10, 12) - 1462, true), '12.10.2026', '1904 sisteminde seri 1462 gun kucuktur');
});

test('readXlsx: metin, sayi, tarih stilleri, mantiksal/hata/satir ici metin, XML kacislari, satir bosluklari ve Excel satir numaralari', () => {
  const buf = xlsxOf([{
    name: 'Veri',
    rows: [
      ['Ad', 'Sayı', 'Tarih'],
      ['A & B <x> "q" Ç', 12, { n: serial(2026, 10, 12), s: 1 }],
      [null, 0.017899999999999999, { n: serial(2026, 10, 12) + 0.5, s: 2 }],
      [{ n: 3.5, s: 4 }, { n: 1.5, s: 3 }, { b: true }],
      [{ e: '#REF!' }, { inline: 'satır içi' }, { str: 'formül sonucu' }],
      ['satır\r\nbirleşik_x000D_ö', 601000000123, 1e-7],
      { r: 9, c: ['Uzak satır'] }, // 6-8. satirlar yok
    ],
  }]);
  const [sh] = readXlsx(buf).sheets;
  assert.equal(sh.name, 'Veri');
  assert.deepEqual(sh.rows[0], ['Ad', 'Sayı', 'Tarih']);
  assert.deepEqual(sh.rows[1], ['A & B <x> "q" Ç', '12', '12.10.2026']);
  assert.deepEqual(sh.rows[2], ['', '0.0179', '12.10.2026 12:00'], 'bos hucre bos kalir; kayan nokta gurultusu 0.0179 olur');
  assert.deepEqual(sh.rows[3], ['3.5', '1.5', 'DOĞRU'], '"mm" tirnak icindeyse tarih degil; [h]:mm gecen sure sayi olarak kalir');
  assert.deepEqual(sh.rows[4], ['#REF!', 'satır içi', 'formül sonucu']);
  assert.deepEqual(sh.rows[5], ['satır\r\nbirleşik\rö', '601000000123', '1e-7'], '12 haneli sayi bilimsel gosterime DONMEZ');
  assert.deepEqual(sh.rows[6], ['Uzak satır']);
  assert.deepEqual(sh.rowNumbers, [1, 2, 3, 4, 5, 6, 9], 'satir numarasi Excel\'deki gercek satirdir (bos satirlar atlanir)');
});

test('readXlsx: depolanmis (sikistirmasiz) ZIP, gizli sayfa, 1904 tarih sistemi, bos sayfa', () => {
  const buf = xlsxOf([
    { name: 'Gizli', hidden: true, rows: [['x', { n: 1, s: 1 }]] },
    { name: 'Bos', rows: [] },
  ], { store: true, date1904: true });
  const book = readXlsx(buf);
  assert.deepEqual(book.sheets.map((s) => [s.name, s.hidden, s.rows.length]), [['Gizli', true, 1], ['Bos', false, 0]]);
  assert.equal(book.sheets[0].rows[0][1], '02.01.1904', '1904 sisteminde seri 1 = 02.01.1904');
});

test('readXlsx: hata iletileri — eski/sifreli OLE2, ZIP degil, kesik/bozuk dosya, sifreli girdi, workbook yok', () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
  assert.throws(() => readXlsx(ole), (e) => e instanceof XlsxError && /\.xls biçiminde ya da şifreli/.test(e.message));
  assert.throws(() => readXlsx(Buffer.from('düz metin')), (e) => e instanceof XlsxError && /\.xlsx/.test(e.message));
  const good = xlsxOf([{ name: 'A', rows: [['x']] }]);
  assert.equal(isZip(good), true);
  assert.throws(() => readXlsx(good.subarray(0, good.length - 40)), XlsxError, 'son dizin kesilmis');
  // veri bozulursa sağlama toplamı yakalar
  const corrupt = Buffer.from(xlsxOf([{ name: 'A', rows: [['x']] }], { store: true }));
  corrupt[corrupt.indexOf('<sst') + 10] ^= 0x20;
  assert.throws(() => readXlsx(corrupt), (e) => e instanceof XlsxError && /bozuk/.test(e.message));
  assert.throws(() => readXlsx(xlsxOf([{ name: 'A', rows: [['x']] }], { flags: 1 })), (e) => e instanceof XlsxError && /şifreli/.test(e.message));
  assert.throws(() => readXlsx(zipOf({ 'baska.txt': 'x' })), (e) => e instanceof XlsxError && /çalışma kitabı değil/.test(e.message));
  assert.equal(readZip(good).has('xl/workbook.xml'), true);
});

/* --------------------------------------------------------------------- iceri alma */

const ISEMRI_BASLIK = ['ÜRETİM EMRİ NO', 'TARİH', 'MAMÜL ADI', 'ALEN KOD', 'MÜŞTERİ KODU', 'MAKİNA NO', 'ADET', 'HAMMADDE', 'ALTERNATİF HM', 'ÜRETİM SN', 'HM TOPLAM', 'BRÜT GR', 'NET GR'];
const SIPARIS_BASLIK = ['Musteri', 'Mamul_Kodu', 'Mamul_Adi', 'Evrak_No', 'Sip_Tarihi', 'Miktar', 'Sevk_Edilen_Miktar', 'Kalan_Miktar', 'Must_Sip_No', 'BR', 'NT', 'SN', 'HM', 'TAM BOY'];

const planlanan = () => ({
  name: 'PLANLANAN',
  rows: [
    ISEMRI_BASLIK,
    [2026000001, { n: serial(2026, 1, 2), s: 1 }, 'TEST SOMUN A', 'SR001.013', 100000013, 'CNC', 3500, 'HM614.YU23.00', null, 24, 62.65, 0.0179, 0.0078],
    [2026000003, { n: serial(2026, 1, 6), s: 1 }, 'TEST NİPEL', 'Nİ002.001', 601000000123, 'CNC', 500, 'HM617.YU18.00', 0, 45, 53, 0.1065, 0.036],
    { r: 40, c: [2026000004, null, null, 'bozuk kod', null] }, // Excel'de 40. satir: uyari bunu soylemeli
    { r: 1043348, c: [null, null, null, '.'] }, // bicimli bos alanin ucunda unutulmus nokta
  ],
});
const siparis = (ad = '_SIPARIS', evrak = 'SPR-1') => ({
  name: ad,
  rows: [
    SIPARIS_BASLIK,
    ['FIRMA A', 'SR001.013', 'TEST SOMUN A', evrak, { n: serial(2025, 9, 13), s: 2 }, 8000, 3000, 5000, 2400000001, 0.0179, 0.0078, 24, 'HM614.YU23.00', 6.9],
    ['FIRMA A', 'Nİ002.001', 'TEST NİPEL', evrak, { n: serial(2025, 9, 13), s: 2 }, 4000, 4000, 0, 2400000001, 0.1065, 0.036, 27, 'HM617.YU18.00', 43],
  ],
});
const sablon = () => ({ name: 'İŞ EMRİ', rows: [['İŞ EMRİ', 'İŞ EMRİ NO:', 2026001110], ['MAMÜL ADI', 'XYZ']] });
const sevkiyat = () => ({ name: '_SEVKIYAT', rows: [['Musteri', 'Malzeme Kodu', 'Malzeme Adı', 'Tarih', 'Irs No'], ['FIRMA A', 'SR001.013', 'TEST', 'x', '1']] });

const yeni = () => new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null });

test('xlsx iceri alma: tum sayfalar taranir, taninanlar alinir, sablon/sevkiyat atlanir; tarih ve 12 haneli kod bozulmaz; uyari Excel satir numarasini verir', () => {
  const p = yeni();
  const r = p.importFile(xlsxOf([planlanan(), sablon(), siparis(), sevkiyat()]), { filename: 'kitap.xlsx', by: 'ayse', keepOld: true });
  assert.equal(r.format, 'xlsx');
  assert.deepEqual(r.sheets.map((s) => [s.sheet, s.format]), [['PLANLANAN', 'isemri'], ['_SIPARIS', 'siparis']]);
  assert.deepEqual(r.skippedSheets.map((s) => s.name), ['İŞ EMRİ', '_SEVKIYAT']);
  assert.match(r.skippedSheets[1].reason, /tanınmadı/);

  const [is, sip] = r.sheets;
  assert.deepEqual([is.products.added, is.skipped], [2, 2], 'iki urun karti; bozuk kodlu iki satir atlandi');
  assert.ok(is.warnings.some((w) => w.startsWith('Satır 40:') && w.includes('bozuk kod')), is.warnings.join(' | '));
  assert.ok(is.warnings.some((w) => w.startsWith('Satır 1043348:')), 'Excel\'in gercek satir numarasi');
  assert.ok(!is.warnings.some((w) => /bilimsel/.test(w)), '12 haneli musteri kodu sayi hucresinden tam gelir');
  assert.equal(p.getProduct('Nİ002.001').customerCode, '601000000123');
  assert.equal(p.getProduct('SR001.013').grossKg, 0.0179);

  assert.deepEqual([sip.added, sip.skipped, sip.warnings.length], [2, 0, 0], 'tarih hucreleri (stilli seri sayi) siparis tarihi olarak okundu: uyari yok');
  const orders = p.searchOrders({ q: 'SPR-1' });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderDate, new Date(2025, 8, 13).getTime());
  assert.equal(orders[0].qty, 12000, '8000 + 4000 (sayi hucreleri, binlik ayirici sorunu yok)');
  assert.equal(r.warnings.length, is.warnings.length + sip.warnings.length);
  assert.ok(r.warnings.every((w) => /^(PLANLANAN|_SIPARIS): /.test(w)), 'birlesik uyarilar sayfa adini tasir');
  assert.deepEqual(p.summary().lastImports.map((b) => b.filename).sort(), ['kitap.xlsx › PLANLANAN', 'kitap.xlsx › _SIPARIS']);

  // tekrar yukleme guvenli (idempotent)
  const again = p.importFile(xlsxOf([planlanan(), siparis()]), { by: 'ayse', keepOld: true });
  assert.deepEqual([again.sheets[0].products.added, again.sheets[0].products.updated, again.sheets[1].added, again.sheets[1].updated, again.sheets[1].unchanged], [0, 0, 0, 0, 2]);
  p.close();
});

test('xlsx iceri alma: ayni kitapta ikinci siparis sayfasi birincinin satirlarini gizlemez (tam dokum isaretli olsa da)', () => {
  const p = yeni();
  const r = p.importFile(xlsxOf([siparis('SIP1', 'SPR-1'), siparis('SIP2', 'SPR-2')]), { keepOld: false });
  assert.equal(r.sheets.length, 2);
  assert.equal(r.sheets[1].staleMarked, 0);
  assert.equal(p.searchOrders({ q: '' }).length, 2, 'iki evrak da gorunur');
  p.close();
});

test('xlsx iceri alma: GKK ve ilk onay form sayfalari da taninir (baslik satiri unvanin altinda)', () => {
  const p = yeni();
  const r = p.importFile(xlsxOf([
    { name: 'GKK', rows: [['GİRİŞ KALİTE KONTROL RAPOR NUMARASI TAKİP FORMU'], [], ['SIRA', 'ÜRÜN', 'RAPOR NO', 'ÜRETİCİ RAPOR TARİHİ', 'AÇIKLAMA'], [1, 'AA24 X 13 - PB3', 'GK26.001', { n: serial(2026, 9, 1), s: 1 }, 'not'], [2, 'YUV 18 - PB3', 'GK26.002', 'bozuk-tarih']] },
    { name: 'ONAY', rows: [['İLK BASKI ONAY / NUMUNE TAKİP LİSTESİ'], ['İLK BASKI ONAY KODU', 'ÜRÜN KODU', 'GK- KODU', 'İŞ EMRİ NO', 'TARİH'], ['İ26-001', 'SR001.013', 'GK26.001', '2026000001', { n: serial(2026, 10, 1), s: 1 }]] },
  ]), { by: 'ayse' });
  assert.deepEqual(r.sheets.map((s) => [s.sheet, s.format, s.added]), [['GKK', 'gkk', 2], ['ONAY', 'ilkonay', 1]]);
  p.close();
});

test('xlsx iceri alma: hicbir sayfa taninmazsa sayfa adlari ve beklenen basliklarla reddedilir; eski .xls acik iletiyle', () => {
  const p = yeni();
  assert.throws(
    () => p.importFile(xlsxOf([sablon(), sevkiyat()])),
    (e) => e instanceof ImportError && e.status === 400 && /İŞ EMRİ, _SEVKIYAT/.test(e.message) && /ALEN KOD/.test(e.message),
  );
  assert.throws(
    () => p.importFile(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)])),
    (e) => e instanceof ImportError && /\.xls/.test(e.message),
  );
  // ZIP olmayan her sey eskisi gibi CSV yolundan gecer
  assert.throws(() => p.importFile(Buffer.from('A;B\n1;2')), (e) => e instanceof ImportError && /tanınmadı/.test(e.message));
  assert.equal(p.importFile(Buffer.from('ALEN KOD;MAMÜL ADI\nSR009.001;DENEME', 'utf8')).format, 'isemri');
  p.close();
});

test('HTTP: .xlsx govdesi Content-Type\'a bakilmadan icerikten taninir (POST /api/planning/import)', async () => {
  const planning = yeni();
  const routes = createPlanningRoutes({ planning });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const post = async (body, type) => {
      const r = await fetch(`${base}/api/planning/import?filename=k.xlsx`, { method: 'POST', headers: { 'content-type': type }, body });
      return { status: r.status, json: await r.json() };
    };
    const ok = await post(xlsxOf([planlanan(), sablon(), siparis()]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.format, 'xlsx');
    assert.equal(ok.json.sheets.length, 2);
    assert.equal(ok.json.skippedSheets.length, 1);
    assert.equal((await post(xlsxOf([planlanan()]), 'application/octet-stream')).status, 200, 'baska Content-Type de olur');
    const bad = await post(xlsxOf([sablon()]), 'text/csv');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /hiçbir sayfa tanınmadı/);
  } finally {
    await new Promise((r) => srv.close(r));
    planning.close();
  }
});
