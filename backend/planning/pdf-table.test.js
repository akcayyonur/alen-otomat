/**
 * PDF sipariş tablosu çıkarma testleri (`pdf-table.js`). Kendi ürettiğimiz küçük, klasik xref'li, basit
 * (WinAnsi) fontlu PDF'lerle; gerçek Siamp/Konveyör dosyalarıyla elle doğrulandı — bkz. CLAUDE.md §6
 * "Mail'den otomatik sipariş girişi" (gerçek müşteri belgeleri depoya girmez, yalnız bu sentetik testler).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from './pdf-text.js';
import { extractOrderTable, mergeCharacterCells, extractDocOrderNo } from './pdf-table.js';

const latin1 = (s) => Buffer.from(s, 'latin1');

function buildPdf(objs) {
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) {
    offs[k] = out.length;
    const o = objs[k];
    if (typeof o === 'string') out += `${k} 0 obj\n${o}\nendobj\n`;
    else {
      const dict = o.dict.replace('>>', ` /Length ${o.stream.length} >>`);
      out += `${k} 0 obj\n${dict}\nstream\n${o.stream}\nendstream\nendobj\n`;
    }
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return latin1(out);
}

/** WinAnsi (ToUnicode'suz) basit fontlu, tek sayfalı PDF: her satır `BT ... Tm (metin) Tj ET` ile. Her hücre AYRI Tj. */
function orderPdf(cellsByLine) {
  const content = cellsByLine.map((line) => line.map((c) => `BT /F1 10 Tf 1 0 0 1 ${c.x} ${c.y} Tm (${c.text}) Tj ET`).join(' ')).join('\n');
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>';
  objs[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>';
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: content };
  return buildPdf(objs);
}

test('baslik satirindan sutun sinirlari cikarilir, veri hucreleri EN YAKIN sutuna (orta nokta kurali) atanir', () => {
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 200, y: 700, text: 'URUN ADI' }, { x: 350, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'TESLIM TARIHI' }],
    // veri hucresi URUN ADI basliginin biraz SOLUNDA (gercek Siamp orneginde oldugu gibi) - yine de ADI'na duser
    [{ x: 20, y: 650, text: '140100109' }, { x: 180, y: 650, text: 'BOSCH RING' }, { x: 350, y: 650, text: '250' }, { x: 420, y: 650, text: '20.11.2026' }],
  ]);
  const { pages } = extractPdfText(buf);
  const t = extractOrderTable(pages[0].runs);
  assert.ok(t, 'tablo bulundu');
  assert.deepEqual(Object.keys(t.headerFields).sort(), ['code', 'deliveryDate', 'description', 'qty']);
  assert.equal(t.rows.length, 1);
  assert.deepEqual(t.rows[0], { code: '140100109', description: 'BOSCH RING', qty: '250', deliveryDate: '20.11.2026' });
});

test('baslik iki ayri satira yayilmis (ust satirda Malzeme Kodu/Teslimat Tarihi, alt satirda Miktar): tek bant olarak birlesir', () => {
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'Malzeme Kodu' }, { x: 300, y: 700, text: 'Teslimat Tarihi' }],
    [{ x: 120, y: 694, text: 'Miktar' }], // birkac punto altta, farkli sutunda ikinci bir baslik satiri
    [{ x: 20, y: 640, text: '140100297' }, { x: 120, y: 640, text: '1200' }, { x: 300, y: 640, text: '17.11.2026' }],
  ]);
  const { pages } = extractPdfText(buf);
  const t = extractOrderTable(pages[0].runs);
  assert.ok(t, 'iki satirlik bant birlesip tablo bulundu');
  assert.deepEqual(Object.keys(t.headerFields).sort(), ['code', 'deliveryDate', 'qty']);
  assert.deepEqual(t.rows[0], { code: '140100297', qty: '1200', deliveryDate: '17.11.2026' });
});

test('altbilgi (KDV/TOPLAM) satirindan sonrasi veri sayilmaz', () => {
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }],
    [{ x: 20, y: 600, text: 'KDV Haric Toplam TL' }, { x: 300, y: 600, text: '592.325,00' }],
    [{ x: 20, y: 580, text: '999999999' }, { x: 300, y: 580, text: '1' }], // altbilgiden sonraki "veri gibi gorunen" satir atlanir
  ]);
  const { pages } = extractPdfText(buf);
  const t = extractOrderTable(pages[0].runs);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].code, '140100109');
});

test('baslik anahtar kelimesi yoksa tablo bulunamaz (null doner)', () => {
  const buf = orderPdf([[{ x: 20, y: 700, text: 'Merhaba dunya' }]]);
  const { pages } = extractPdfText(buf);
  assert.equal(extractOrderTable(pages[0].runs), null);
});

/* ============================================================================================== OCR kelime-kutusu basliklar (sliding window) */

test('OCR gibi KELIME-KELIME kutulara bolunmus baslik ("URUN"+"KODU", "TESLIM"+"TARIHI"): ardisik hucre penceresiyle yine de taninir', () => {
  // gercek taranmis PDF'te (Ayvaz/Canon, Tesseract) basliklar TAM OLARAK boyle gelir: her sozcuk kendi kutusunda.
  const runs = [
    { x: 20, y: 700, size: null, text: 'URUN' }, { x: 60, y: 700, size: null, text: 'KODU' },
    { x: 300, y: 700, size: null, text: 'MIKTAR' },
    { x: 420, y: 700, size: null, text: 'TESLIM' }, { x: 460, y: 700, size: null, text: 'TARIHI' },
    { x: 20, y: 650, size: null, text: '140100109' }, { x: 300, y: 650, size: null, text: '250' },
    { x: 420, y: 650, size: null, text: '20.11.2026' },
  ];
  const t = extractOrderTable(runs);
  assert.ok(t, 'coklu hucreye bolunmus baslik tanindi');
  assert.deepEqual(Object.keys(t.headerFields).sort(), ['code', 'deliveryDate', 'qty']);
  assert.deepEqual(t.rows[0], { code: '140100109', qty: '250', deliveryDate: '20.11.2026' });
});

test('pencereleme ZAYIF anahtar kelimeleri genisletmez: iki bitisik hucrenin sinirindaki tesadufi kisa alt-dize (ör. "BR") YANLISLIKLA eslesmez', () => {
  const runs = [
    { x: 20, y: 700, size: null, text: 'MIKTAR' }, // bandi tetiklemek icin en az bir GUCLU eslesme sart
    { x: 300, y: 700, size: null, text: 'FOOB' }, { x: 340, y: 700, size: null, text: 'RISKET' }, // birlesince "FOOBRISKET" -> "BR" iceriyor, tek basina hicbiri icermiyor
  ];
  const t = extractOrderTable(runs);
  assert.ok(t);
  assert.deepEqual(Object.keys(t.headerFields).sort(), ['qty']); // 'unit' (zayif anahtar "BR") yanlislikla eklenmedi
});

/* ========================================================================== KARAKTER-KARAKTER hucreler (gercek HAVANA/SAS0003812 belgesi) */

test('mergeCharacterCells: komsu harfler (kucuk bosluk) TEK hucreye birlesir, buyuk bosluk (sutun) hucreyi AYIRIR', () => {
  const chars = (text, x0, step) => [...text].map((ch, i) => ({ x: x0 + i * step, text: ch }));
  // "URUNKODU" harf harf (4.5pt araliklarla, hepsi CELL_BREAK_PT=24'un altinda) + buyuk bosluk (>24) + "ACIKLAMA" harf harf
  const merged = mergeCharacterCells([...chars('URUNKODU', 20, 4.5), ...chars('ACIKLAMA', 200, 4.5)]);
  assert.deepEqual(merged.map((c) => c.text), ['URUNKODU', 'ACIKLAMA']);
});

test('mergeCharacterCells GERCEK BUG duzeltildi: ONCEKI girdi hucresinin x\'i izlenmeli, birlesen hucrenin ILK uyesininki DEGIL (aksi halde uzun bir sozcuk kendi icinde kopuyordu — gercek belgede "HAVANA" "HAVA"+"NASA"+"NAYI" diye UCE bolunmustu, 2026-11-18 bulundu)', () => {
  // 10 harfli TEK sozcuk, her harf arasi 4.5pt (CELL_BREAK_PT=24'un COK altinda, hic kopmamali).
  // ESKI (hatali) kod birlesen hucrenin ILK harfinin x'ini sabit referans alip kumulatif mesafeyi olcuyordu;
  // bu da ~24/4.5≈5-6 harfte bir YANLISLIKLA kopuyordu - 10 harflik bir sozcuk STRICTLY 1 hucre OLMALI.
  const merged = mergeCharacterCells([...'HAVANASANAYI'].map((ch, i) => ({ x: 20 + i * 4.5, text: ch })));
  assert.deepEqual(merged.map((c) => c.text), ['HAVANASANAYI'], 'tek sozcuk, hic bolunmeden tek hucre kalmali');
});

test('mergeCharacterCells: zaten SOZCUK duzeyinde gelen normal PDF hucreleri (Siamp/Konveyor) icin NO-OP (gercek sozcukler arasi bosluk CELL_BREAK_PT\'nin uzerinde)', () => {
  const merged = mergeCharacterCells([{ x: 20, text: 'URUN KODU' }, { x: 200, text: 'URUN ADI' }, { x: 350, text: 'MIKTAR' }]);
  assert.deepEqual(merged.map((c) => c.text), ['URUN KODU', 'URUN ADI', 'MIKTAR']);
});

test('KARAKTER KARAKTER yazan PDF (her harf ayrı run — gerçek HAVANA/SAS0003812 belgesinin örüntüsü, 2026-11-18): uçtan uca extractOrderTable başlığı tanır, veri doğru çıkar', () => {
  // "ÜRÜN KODU" ve "AÇIKLAMA" harf harf (gerçek belgede ölçülen büyüklüklerle: içi ~2-7pt, sütunlar arası ~30+pt).
  const charRun = (text, x0, y, step = 4.5) => [...text].map((ch, i) => ({ x: x0 + i * step, y, size: null, text: ch }));
  const runs = [
    ...charRun('URUNKODU', 20, 700), // 'URUNKODU' tam GUCLU key (code)
    ...charRun('ACIKLAMA', 200, 700), // 200 - (20+7*4.5)=148.5 => bosluk > 30
    ...charRun('140100109', 20, 650),
    ...charRun('BOSCHRING', 200, 650),
  ];
  const t = extractOrderTable(runs);
  assert.ok(t, 'karakter karakter hucreler sozcuge birlesip tablo bulundu');
  assert.deepEqual(Object.keys(t.headerFields).sort(), ['code', 'description']);
  assert.deepEqual(t.rows[0], { code: '140100109', description: 'BOSCHRING' });
});

/* ====================================================================================== extractDocOrderNo */
/* Belgenin KENDI (tablo DISINDAKI, sayfa ust metadata blogundaki) siparis numarasi — 2026-11-19, kullanici
 * isteği: "bu pdflerde sipariş numarası var ya onu da mikroya gönderirken belge numarası kısmına yazacağız".
 * Gercek Konveyor/SAP formunda (4100018539.PDF) bulunan oruntu: "Satınalma Siparişi / Eba Numarası" etiketi
 * tablo DISINDA, sayfa basinda; degeri bir SONRAKI satirda, siparis TARIHIYLE (11.11.2026) AYNI hucrede
 * boslukSUZ FUZE olabiliyor (mergeCharacterCells, gercek belgede oldugu gibi). */

test('extractDocOrderNo: etiket + TARIHLE FUZE deger (gercek Konveyor orneginin BIREBIR oruntusu) - PO no dogru cikarilir', () => {
  const runs = [
    { x: 20, y: 700, text: 'Satınalma Siparişi / Eba Numarası' },
    // tarih (11.11.2026) ve PO no (4100018539 / 01) ayni satirda, aralarinda 10pt (CELL_BREAK_PT=24'un
    // altinda) - mergeCharacterCells ikisini TEK hucrede birlestirir: "11.11.20264100018539 / 01"
    { x: 20, y: 650, text: '11.11.2026' }, { x: 110, y: 650, text: '4100018539 / 01' },
  ];
  assert.equal(extractDocOrderNo(runs), '4100018539');
});

test('extractDocOrderNo: etiket + AYRI (fuzyonsuz) hucrede deger - genel yedek yol da calisir', () => {
  const runs = [
    { x: 20, y: 700, text: 'Satınalma Siparişi / Eba Numarası' },
    { x: 20, y: 650, text: '11.11.2026' }, { x: 300, y: 650, text: '4100018539' }, // genis bosluk, fuzyon YOK
  ];
  assert.equal(extractDocOrderNo(runs), '4100018539');
});

test('extractDocOrderNo: etiket "Eba Numarası" tek basina (kisaltmasiz "Satınalma Siparişi" olmadan) da tanir', () => {
  const runs = [{ x: 20, y: 700, text: 'Eba Numarası' }, { x: 20, y: 650, text: '4100018539' }];
  assert.equal(extractDocOrderNo(runs), '4100018539');
});

test('extractDocOrderNo: taninan etiket hic YOKSA null doner, asla tahmin edilmez', () => {
  const runs = [{ x: 20, y: 700, text: 'Sipariş No' }, { x: 20, y: 650, text: '4100018539' }];
  assert.equal(extractDocOrderNo(runs), null, "'SIPARISNO' tek basina DOC_ORDER_NO_KEYWORDS'te yok - bu TABLO icindeki satir bazli custOrderNo'nun etiketi, belge-duzeyi degil");
});

test('extractDocOrderNo: etiket bulunur ama sonraki birkac satirda 6+ rakamli bir deger hic YOKSA null doner', () => {
  const runs = [{ x: 20, y: 700, text: 'Satınalma Siparişi / Eba Numarası' }, { x: 20, y: 650, text: 'bilinmiyor' }];
  assert.equal(extractDocOrderNo(runs), null);
});
