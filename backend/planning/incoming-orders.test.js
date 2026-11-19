/**
 * Mail'den sipariş girişi testleri: revizyon notu sınıflandırma, e-posta HTML tablosu ayrıştırma (saf
 * fonksiyonlar) + Planning üzerinden uçtan uca (ürün eşleme, revizyon karşılaştırma, onay/red). Gerçek
 * müşteri PDF/e-posta dosyaları depoya GİRMEZ — bu testler sentetik veriyle, ama gerçek dosyalardan
 * bulunan GERÇEK değerlerle (ör. "140100109"/"SR009.013" eşleşmesi) kurulur; bkz. CLAUDE.md §6.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Planning } from './planning.js';
import { classifyRevisionNote, parseEmailTable } from './incoming-orders.js';

test('classifyRevisionNote: iptal / tarih / miktar / bilinmiyor', () => {
  assert.deepEqual(classifyRevisionNote('iptal'), { type: 'iptal', value: null, display: 'iptal' });
  assert.deepEqual(classifyRevisionNote('İPTAL'), { type: 'iptal', value: null, display: 'İPTAL' }, 'buyuk/kucuk ve Turkce I duyarsiz');
  assert.equal(classifyRevisionNote('1.12.2026').type, 'tarih');
  assert.equal(classifyRevisionNote('200').type, 'miktar');
  assert.equal(classifyRevisionNote('1500').type, 'miktar');
  assert.equal(classifyRevisionNote('???').type, 'bilinmiyor');
  assert.equal(classifyRevisionNote(''), null);
  assert.equal(classifyRevisionNote(null), null);
});

test('parseEmailTable: basligin GENISLIGINI asan EK bir hucre de revizyon notu sayilir (vurgu YOK, gercek e-posta bicimi)', () => {
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>SIPARIS MIKTARI</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH Ring</td><td>250</td><td>iptal</td></tr>
    <tr><td>17.11.2026</td><td>211015073</td><td>140100297</td><td>RAKOR SOMUN</td><td>1.200</td><td>1500</td></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100116</td><td>degismeyen satir</td><td>100</td></tr>
  </table>`;
  const rows = parseEmailTable(html);
  assert.deepEqual(rows.map((r) => [r.qty, r.revisionNote]), [['250', 'iptal'], ['1.200', '1500'], ['100', null]]);
});

test('parseEmailTable: baslik anahtar kelimeleriyle sutunlari bulur, sari vurgulu hucreyi revizyon notu sayar', () => {
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211027082</td><td>140100235</td><td>D.DÖKÜM M9x1 Somun</td><td>600</td></tr>
    <tr><td>17.11.2026</td><td>211015073</td><td>140100297</td><td>RAKOR SOMUN</td><td style="background-color:#FFFF00">1500</td></tr>
  </table>`;
  const rows = parseEmailTable(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { deliveryDate: '20.11.2026', custOrderNo: '211027082', code: '140100235', description: 'D.DÖKÜM M9x1 Somun', qty: '600', revisionNote: null });
  assert.equal(rows[1].revisionNote, '1500');
});

test('parseEmailTable: taninan baslik yoksa null doner (giris disi metin/duz tablo degil)', () => {
  assert.equal(parseEmailTable('<p>Merhaba, ekte siparisiniz</p>'), null);
  assert.equal(parseEmailTable('<table><tr><td>A</td><td>B</td></tr></table>'), null);
});

function planlama() {
  return new Planning({ dbFile: ':memory:' });
}

test('importEmailTable: urune musteri koduyla eslenir, eslesmeyen yok sayilmaz (yok olarak isaretlenir)', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>999999999</td><td>BILINMEYEN URUN</td><td>10</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html, { by: 'ayse' });
  assert.equal(batch.source, 'email-table');
  assert.equal(batch.kind, 'yeni');
  assert.equal(batch.lines.length, 2);
  assert.deepEqual([batch.lines[0].matchStatus, batch.lines[0].matchedStockCode], ['tam', 'SR009.013']);
  assert.equal(batch.lines[0].qty, 250);
  assert.deepEqual([batch.lines[1].matchStatus, batch.lines[1].matchedStockCode], ['yok', null]);
  assert.equal(batch.counts.bekliyor, 2);
  p.close();
});

test('revizyon: sari vurgulu not VAR olan gercek siparisle karsilastirilir (iptal / miktar degisikligi)', () => {
  const p = planlama();
  const ring = p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const rakor = p.createProduct({ stockCode: 'SR027.013', name: 'RAKOR SOMUN', customerCode: '140100297' });
  // gercek Mikro senkronundan gelmis gibi VAR OLAN siparis satirlari (elle, order_lines'a dogrudan)
  const ins = (codeKey, stockCode, custOrderNo, qty, dueMs) => p.db.db.prepare(
    `INSERT INTO order_lines (line_key, source, doc_no, doc_key, customer, customer_key, cust_order_no, cust_order_key,
      code_key, stock_code, item_name, item_key, order_date, qty, shipped, remaining, due_date, material, last_batch, stale)
     VALUES (?,'test','','','K','K',?,?,?,?,?,'',0,?,0,?,?,'',1,0)`,
  ).run(`k-${codeKey}-${custOrderNo}`, custOrderNo, custOrderNo, codeKey, stockCode, stockCode, qty, qty, dueMs);
  const due = new Date(2026, 10, 17).getTime();
  ins(ring.codeKey, 'SR009.013', '211015073', 250, new Date(2026, 10, 20).getTime());
  ins(rakor.codeKey, 'SR027.013', '211015073', 1200, due);

  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>SİPARİŞ MİKTARI</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH RING</td><td style="background-color:#FFFF00">iptal</td></tr>
    <tr><td>17.11.2026</td><td>211015073</td><td>140100297</td><td>RAKOR SOMUN</td><td style="background-color:#FFFF00">1500</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html, { kind: 'revizyon', by: 'ayse' });
  assert.equal(batch.kind, 'revizyon');
  const [l1, l2] = batch.lines;
  assert.deepEqual([l1.isRevision, l1.revisionType], [true, 'iptal']);
  assert.deepEqual([l2.isRevision, l2.revisionType, l2.qty, l2.existingQty, l2.existingLineId != null], [true, 'miktar', 1500, 1200, true]);
  p.close();
});

test('revizyon: vurgulu not OLMADAN (PDF gibi) da eski/yeni deger farkindan cikarsanir', () => {
  const p = planlama();
  const rakor = p.createProduct({ stockCode: 'SR027.013', name: 'RAKOR SOMUN', customerCode: '140100297' });
  const due = new Date(2026, 10, 17).getTime();
  p.db.db.prepare(
    `INSERT INTO order_lines (line_key, source, doc_no, doc_key, customer, customer_key, cust_order_no, cust_order_key,
      code_key, stock_code, item_name, item_key, order_date, qty, shipped, remaining, due_date, material, last_batch, stale)
     VALUES ('k1','test','','','K','K','211015073','211015073',?,?,?,'',0,1200,0,1200,?,'',1,0)`,
  ).run(rakor.codeKey, 'SR027.013', 'RAKOR SOMUN', due);
  // not sutunu YOK, yalniz ana miktar degismis gibi (1500)
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>17.11.2026</td><td>211015073</td><td>140100297</td><td>RAKOR SOMUN</td><td>1500</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html, { kind: 'revizyon' });
  assert.deepEqual([batch.lines[0].isRevision, batch.lines[0].revisionType], [true, 'miktar']);
  p.close();
});

test('revizyon: GERCEK musteri e-postasi (2026-11-19, kullanicinin kendi ornegi) — "iptal", miktar VE tarih notlari dogru ayristirilip YENI hedef degere cevrilir, farkli siparis no\'lari birbirine karismaz', () => {
  const p = planlama();
  const boschRing = p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH-Bras Ring', customerCode: '140100109' });
  const boschNut = p.createProduct({ stockCode: 'SR010.013', name: 'BOSCH NUT 3/4', customerCode: '140100126' });
  const baffle = p.createProduct({ stockCode: 'SR011.013', name: 'DAIKIN BAFFLE PLATE', customerCode: '140100311' });
  const fancoil = p.createProduct({ stockCode: 'SR012.013', name: '4PW60464 3/4 SOMUN', customerCode: '140100296' });
  const rakor = p.createProduct({ stockCode: 'SR027.013', name: 'D.DÖKÜM RAKOR SOMUN', customerCode: '140100297' });
  const ins = (codeKey, stockCode, custOrderNo, qty, dueMs) => p.db.db.prepare(
    `INSERT INTO order_lines (line_key, source, doc_no, doc_key, customer, customer_key, cust_order_no, cust_order_key,
      code_key, stock_code, item_name, item_key, order_date, qty, shipped, remaining, due_date, material, last_batch, stale)
     VALUES (?,'test','','','K','K',?,?,?,?,?,'',0,?,0,?,?,'',1,0)`,
  ).run(`k-${codeKey}-${custOrderNo}`, custOrderNo, custOrderNo, codeKey, stockCode, stockCode, qty, qty, dueMs);
  ins(boschRing.codeKey, 'SR009.013', '211015073', 250, new Date(2026, 10, 20).getTime());
  ins(boschNut.codeKey, 'SR010.013', '211015073', 500, new Date(2026, 10, 24).getTime());
  ins(baffle.codeKey, 'SR011.013', '211015073', 1500, new Date(2026, 10, 24).getTime());
  ins(fancoil.codeKey, 'SR012.013', '211027082', 150, new Date(2026, 10, 10).getTime());
  ins(rakor.codeKey, 'SR027.013', '211015073', 1200, new Date(2026, 10, 17).getTime());

  // musterinin GERCEK e-postasindaki hucre sirasiyla birebir (kopyalandiginda [eski, yeni] cifti son hucre)
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>SIPARIS MIKTARI</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH-Bras Ring(AK-803)8716010803 İNCE YÜZÜK</td><td>250</td><td>iptal</td></tr>
    <tr><td>24.11.2026</td><td>211015073</td><td>140100126</td><td>BOSCH NUT 3/4  8715301169  PİRİNÇ SOMUN</td><td>500</td><td>İPTAL</td></tr>
    <tr><td>24.11.2026</td><td>211015073</td><td>140100311</td><td>DAIKIN BAFFLE PLATE</td><td>1.500</td><td>1.12.2026</td></tr>
    <tr><td>10.11.2026</td><td>211027082</td><td>140100296</td><td>4PW60464 3/4 SOMUN (FANCOİL NUMUNESİ)</td><td>150</td><td>200</td></tr>
    <tr><td>17.11.2026</td><td>211015073</td><td>140100297</td><td>D.DÖKÜM 0020255416 RAKOR SOMUN</td><td>1.200</td><td>1500</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html, { kind: 'revizyon', by: 'test' });
  assert.equal(batch.lines.length, 5);
  // musteri tahmini: 5 urunun 5'i de ".013" ile bitiyor (Berg Metal) - GERCEK veride de boyle (bkz. CLAUDE.md
  // "peki su var musteri tahmin edilemedi diyor..." 2026-11-19 kullanici ornegi).
  assert.equal(batch.customerGuess, 'Berg Metal');

  const [ring, nut, bafle, fan, rak] = batch.lines;
  // "iptal": tip dogru, qty ESKI (iptal edilen) adet olarak bilgi amacli kalir, siparis no DOGRU (211015073)
  assert.deepEqual([ring.custOrderNo, ring.isRevision, ring.revisionType, ring.qty], ['211015073', true, 'iptal', 250]);
  assert.deepEqual([nut.custOrderNo, nut.isRevision, nut.revisionType, nut.qty], ['211015073', true, 'iptal', 500], 'kucuk/buyuk harf (İPTAL) de taninir');
  // "tarih": deliveryDate YENI hedefe (1.12.2026) cevrilir, existingDueDate ESKI (24.11.2026) var olan kayittan gelir
  assert.equal(bafle.isRevision, true); assert.equal(bafle.revisionType, 'tarih');
  assert.equal(new Date(bafle.deliveryDate).toDateString(), new Date(2026, 11, 1).toDateString());
  assert.equal(new Date(bafle.existingDueDate).toDateString(), new Date(2026, 10, 24).toDateString());
  // "miktar": qty YENI hedefe (200) cevrilir, existingQty ESKI (150) var olan kayittan gelir — FARKLI siparis no (211027082)
  assert.deepEqual([fan.custOrderNo, fan.isRevision, fan.revisionType, fan.qty, fan.existingQty], ['211027082', true, 'miktar', 200, 150]);
  // "miktar": qty YENI hedefe (1500) cevrilir, existingQty ESKI (1200) — AYNI siparis no (211015073) ama DIGER urunlerle KARISMAZ
  assert.deepEqual([rak.custOrderNo, rak.isRevision, rak.revisionType, rak.qty, rak.existingQty], ['211015073', true, 'miktar', 1500, 1200]);

  // 211015073'teki 4 satirin HICBIRI birbirinin existingLineId'sini almadi (yanlislikla karismadi)
  const ids = new Set([ring, nut, bafle, rak].map((l) => l.existingLineId));
  assert.equal(ids.size, 4, 'ayni siparis no icindeki 4 farkli urun 4 farkli var olan kayda baglandi');
  p.close();
});

/* ===================================================================================== musteri tahmini (urun kodu sonu) */
/* 2026-11-19, kullanici isteği: "mail uzerinden bu sekilde tablo olarak siparisi sadece Berg gonderiyor ...
 * bu urunlerin kodlari sonunda 013 oldugunu goruyor oradan da berg oldugunu anliyoruz" - e-posta tablosunun
 * `customerGuess`'i hep NULL'du; artik eslesen urunlerin Alen kodu SONUNDAKI 3 haneden (sample-customer-groups.js'teki
 * AYNI 19 sabit grup) tahmin edilir, TUM eslesen satirlar AYNI gruba cikarsa. */

test('musteri tahmini: e-posta tablosunda eslesen TUM urunler AYNI grupta (.013 = Berg Metal) -> customerGuess doldurulur', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  p.createProduct({ stockCode: 'SR027.013', name: 'RAKOR SOMUN', customerCode: '140100297' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100297</td><td>RAKOR SOMUN</td><td>10</td></tr>
    <tr><td>20.11.2026</td><td>A</td><td>999999999</td><td>BILINMEYEN (eslesmez, tahmine KATILMAZ)</td><td>5</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.equal(batch.customerGuess, 'Berg Metal');
  p.close();
});

test('musteri tahmini: eslesen urunler FARKLI gruplara cikarsa (karisik taslak) HIC TAHMIN YAPILMAZ', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' }); // Berg Metal
  p.createProduct({ stockCode: 'SR016.011', name: 'KONVEYOR PARCASI', customerCode: '140100999' }); // Konveyör
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100999</td><td>KONVEYOR PARCASI</td><td>10</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.equal(batch.customerGuess, null, 'iki ayri musterinin kodu bir arada - belirsizken tahmin edilmez');
  p.close();
});

test('musteri tahmini: eslesen bir urunun kodu bicime (XX###.###) UYMUYORSA (eski/numune kodu) de tahmin yapilmaz', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' }); // Berg Metal
  p.createProduct({ stockCode: 'NUMUNE-TEST-1', name: 'NUMUNE URUN', customerCode: '140100999' }); // bicim disi
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100999</td><td>NUMUNE URUN</td><td>10</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.equal(batch.customerGuess, null);
  p.close();
});

test('musteri tahmini: hic eslesen urun yoksa (hepsi "yok") customerGuess null kalir, patlamaz', () => {
  const p = planlama();
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>A</td><td>999999999</td><td>BILINMEYEN</td><td>5</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.equal(batch.customerGuess, null);
  p.close();
});

test('onayla / reddet: bekleyen satir bir kez karara baglanir, ikinci kez 409', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  const line = batch.lines[0];
  const approved = p.incomingOrders.approveLine(line.id, { by: 'ayse' });
  assert.deepEqual([approved.status, approved.decidedBy], ['onaylandi', 'ayse']);
  assert.throws(() => p.incomingOrders.approveLine(line.id), (e) => e.status === 409);

  const batch2 = p.incomingOrders.importEmailTable(html);
  const rejected = p.incomingOrders.rejectLine(batch2.lines[0].id, { by: 'ayse' });
  assert.equal(rejected.status, 'reddedildi');
  p.close();
});

test('onayla: eslesmeyen (yok) bir satir elle stockCode verilerek de onaylanabilir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '999' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>BILINMEYEN</td><td>?</td><td>1</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.equal(batch.lines[0].matchStatus, 'yok');
  assert.throws(() => p.incomingOrders.approveLine(batch.lines[0].id), (e) => e.code === 'no-product');
  const approved = p.incomingOrders.approveLine(batch.lines[0].id, { stockCode: 'SR009.013' });
  assert.deepEqual([approved.status, approved.matchedStockCode], ['onaylandi', 'SR009.013']);
  // elle eslenip onaylanan satir artik GERCEKTEN eslesmis sayilir ('tam'); 'yok' kalirsa dashboard "eslesmedi" cipini
  // onaylanmis bir satirda gostermeye devam eder (tarayicida bulunan gercek hata, bkz. CLAUDE.md degil - yalniz kod yorumu).
  assert.equal(approved.matchStatus, 'tam');
  p.close();
});

test('listBatches: en yeni once, durum sayaclari dogru', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
  </table>`;
  p.incomingOrders.importEmailTable(html, { filename: 'eski.html' });
  const b2 = p.incomingOrders.importEmailTable(html, { filename: 'yeni.html' });
  const list = p.incomingOrders.listBatches();
  assert.equal(list[0].filename, 'yeni.html');
  assert.equal(list[0].counts.bekliyor, 1);
  p.incomingOrders.approveLine(b2.lines[0].id);
  assert.equal(p.incomingOrders.listBatches()[0].counts.onaylandi, 1);
  p.close();
});

/* ============================================================================================== importPdf (+ OCR) */

const latin1 = (s) => Buffer.from(s, 'latin1');

/** Minimal klasik-xref'li PDF; `pdf-table.test.js`'in `buildPdf`'iyle AYNI desen (ikinci bir kopya - test dosyalari birbirini import etmez). */
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

/** WinAnsi (dijital metin) tablo PDF'i: `pdf-table.test.js#orderPdf`'in AYNI deseni. */
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

/** Hic metin yok, bir DCTDecode goruntu XObject'i var: `extractPdfText`'in `unreadable:'scanned'` + `image` dondurdugu PDF. */
function scannedPdf() {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</XObject <</Im0 3 0 R>>>>>>';
  objs[3] = { dict: '<</Type /XObject /Subtype /Image /Width 100 /Height 100 /Filter /DCTDecode>>', stream: 'sahte-jpeg' };
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: 'q 1 0 0 1 0 0 cm /Im0 Do Q' };
  return buildPdf(objs);
}

test('importPdf: FIYAT basligi olan bir tabloda birim fiyat KENDI sutunundan cikarilir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'FIYAT' }, { x: 520, y: 700, text: 'TESLIM TARIHI' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: '157,55' }, { x: 520, y: 650, text: '20.11.2026' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf);
  assert.equal(batch.lines[0].price, 157.55);
  assert.equal(batch.lines[0].rawPrice, '157,55');
  p.close();
});

// Not: 'Satınalma Siparişi'/'Eba Numarası' gibi Turkce aksanli etiketler burada BILEREK yazilmiyor - orderPdf/buildPdf
// (digerleri gibi) icerigi Latin-1'e cevirir, Turkce karakterler (ı/ş) bu yolla GERCEK bir PDF'te dogru kodlanamaz
// (gercek 4100018539.PDF, WinAnsi/CID font farkli bir yolla kodluyordu — bkz. pdf-text.js); ASCII esdegeri ("EBA
// NUMARASI") `fold()` sonrasi ayni anahtar kelimeye (`EBANUMARASI`) dustugu icin test amacli yeterli ve dogru.
test('importPdf: belgenin KENDI siparis numarasi (sayfa ust metadata blogu, gercek Konveyor/4100018539.PDF oruntusu) bos olan custOrderNo alanlarini doldurur', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 750, text: 'EBA NUMARASI' }],
    // tarih + PO no AYNI hucrede fuze (gercek belgedeki gibi, aralarinda CELL_BREAK_PT'nin altinda bosluk)
    [{ x: 20, y: 720, text: '11.11.2026' }, { x: 110, y: 720, text: '4100018539 / 01' }],
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'TESLIM TARIHI' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: '20.11.2026' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf);
  assert.equal(batch.lines.length, 1);
  assert.equal(batch.lines[0].custOrderNo, '4100018539', 'tablo icinde hic custOrderNo sutunu yok, belge metadatasindan dolar');
  p.close();
});

test('importPdf: satirin KENDI custOrderNo\'su (tablo icindeki bir "Sipariş No" sutunu) VARSA belge metadatasi onu EZMEZ', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 750, text: 'EBA NUMARASI' }],
    [{ x: 20, y: 720, text: '4100018539' }], // belge metadatasi FARKLI bir numara - satirinki yine de kazanmali
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'SIPARIS NO' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: 'SATIR-OZEL-999' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf);
  assert.equal(batch.lines[0].custOrderNo, 'SATIR-OZEL-999', 'satirin KENDI degeri korunur, belge metadatasi (farkli bir deger olsa bile) onu ezmez');
  p.close();
});

test('importPdf: ayri bir FIYAT sutunu YOKSA (gercek HAVANA/SAS0003812 orneginde oldugu gibi, Tutar ve Giris Tarihi AYNI hucrede birlesiyor) fiyat deliveryDate alaninin ham metninden kurtarilir, tarih de dogru kalir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'GIRIS TARIHI' }],
    // tek hucrede fiyat + tarih art arda (basligin KENDI bir sutunu olmadigi icin FIYAT alani hic kurulmaz)
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: '157,55 20.11.2026' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf);
  assert.equal(batch.lines[0].price, 157.55);
  assert.equal(batch.lines[0].deliveryDate, new Date(2026, 10, 20).getTime());
  p.close();
});

test('importPdf: tek hucrede BIRDEN ÇOK virgullu sayi varsa (ör. gercek Siamp: birim fiyat + satir toplami) ILK sayi alinir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'FIYAT' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: '0,5400 2.700,00' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf);
  assert.equal(batch.lines[0].price, 0.54);
  p.close();
});

test('updateLine: bekleyen bir satirin adet/teslim/siparis no/fiyat alanlari duzeltilebilir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  const line = batch.lines[0];
  assert.equal(line.price, null, 'e-posta tablosunda fiyat sutunu yok, bu yuzden bos');

  const updated = p.incomingOrders.updateLine(line.id, { qty: 300, price: 199.9, deliveryDate: '25.11.2026', custOrderNo: 'DUZELTILMIS-1' });
  assert.equal(updated.qty, 300);
  assert.equal(updated.price, 199.9);
  assert.equal(updated.deliveryDate, new Date(2026, 10, 25).getTime());
  assert.equal(updated.custOrderNo, 'DUZELTILMIS-1');

  // yalniz GONDERILEN alan degisir, digerleri aynen kalir
  const partial = p.incomingOrders.updateLine(line.id, { price: 0 });
  assert.deepEqual([partial.price, partial.qty, partial.custOrderNo], [0, 300, 'DUZELTILMIS-1'], 'fiyat 0 KABUL EDILEN bir deger (Mikro da 0 kabul ediyor), gecersiz sayilmaz');

  // karara baglanmis (onaylanmis) bir satir artik duzenlenemez
  p.incomingOrders.approveLine(line.id);
  assert.throws(() => p.incomingOrders.updateLine(line.id, { qty: 1 }), (e) => e.status === 409);

  assert.throws(() => p.incomingOrders.updateLine(999999, { qty: 1 }), (e) => e.status === 404);
  p.close();
});

test('updateLine: eslesmeyen bir satirin urunu de stockCode ile duzeltilebilir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '999' });
  const html = `<table>
    <tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>211015073</td><td>BILINMEYEN</td><td>?</td><td>1</td></tr>
  </table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.equal(batch.lines[0].matchStatus, 'yok');
  const updated = p.incomingOrders.updateLine(batch.lines[0].id, { stockCode: 'SR009.013' });
  assert.deepEqual([updated.matchStatus, updated.matchedStockCode], ['tam', 'SR009.013']);
  p.close();
});

test('importPdf: dijital metinli bir tablo satirlara ayrilir ve urune musteri koduyla eslenir', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'TESLIM TARIHI' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: '20.11.2026' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf, { by: 'ayse' });
  assert.equal(batch.source, 'pdf');
  assert.equal(batch.warning, null);
  assert.equal(batch.lines.length, 1);
  assert.deepEqual([batch.lines[0].matchStatus, batch.lines[0].matchedStockCode, batch.lines[0].qty], ['tam', 'SR009.013', 250]);
  // metinde SIAMP/AYVAZ/KONVEYOR yok (detectPdfCustomer -> null); urun kodu sonundaki 3 haneden (.013) YEDEK tahmin
  assert.equal(batch.customerGuess, 'Berg Metal');
  p.close();
});

test('importPdf: metinden ZATEN bir musteri adi bulunduysa (SIAMP/AYVAZ/KONVEYOR) urun kodu tahmini onu EZMEZ', () => {
  const p = planlama();
  // kod sonu ".011" = Konveyör ama metinde "AYVAZ" geciyor - metinden gelen isim KAZANMALI (ilk, daha guvenilir sinyal)
  p.createProduct({ stockCode: 'SR016.011', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = orderPdf([
    [{ x: 20, y: 750, text: 'AYVAZ ENDUSTRIYEL URUNLER' }],
    [{ x: 20, y: 700, text: 'URUN KODU' }, { x: 300, y: 700, text: 'MIKTAR' }, { x: 420, y: 700, text: 'TESLIM TARIHI' }],
    [{ x: 20, y: 650, text: '140100109' }, { x: 300, y: 650, text: '250' }, { x: 420, y: 650, text: '20.11.2026' }],
  ]);
  const batch = p.incomingOrders.importPdf(buf);
  assert.equal(batch.customerGuess, 'Ayvaz');
  p.close();
});

test('importPdf: taranmis sayfa + OCR BASARILI (enjekte edilen sahte run) -> OCR runs tablo ayristiricidan gecer, uyari OCR kullanildigini soyler', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const buf = scannedPdf();
  // OCR kelime-kelime kutular verir (gercek taranmis Ayvaz PDF'inde boyle geldi): "URUN KODU" basligi
  // ayri "URUN" ve "KODU" hucrelerine boluniyor. `pdf-table.js#matchesInLine`'in ardisik-hucre penceresi
  // (sliding window, bkz. CLAUDE.md "OCR kelime-kelime basliklari") bunu yine de 'code' olarak tanir.
  const ocrRuns = [
    { x: 20, y: 700, size: null, text: 'URUN' }, { x: 60, y: 700, size: null, text: 'KODU' },
    { x: 300, y: 700, size: null, text: 'MIKTAR' },
    { x: 20, y: 650, size: null, text: '140100109' }, { x: 300, y: 650, size: null, text: '250' },
  ];
  const batch = p.incomingOrders.importPdf(buf, { ocr: () => ocrRuns });
  assert.match(batch.warning, /OCR \(Tesseract\)/);
  assert.equal(batch.lines.length, 1);
  assert.deepEqual([batch.lines[0].matchStatus, batch.lines[0].matchedStockCode, batch.lines[0].qty], ['tam', 'SR009.013', 250]);
  p.close();
});

test('importPdf: taranmis sayfa + OCR YOK/BASARISIZ (enjekte edilen sahte run null doner) -> eski "okunamadi" davranisi, hic satir cikmaz', () => {
  const p = planlama();
  const buf = scannedPdf();
  const batch = p.incomingOrders.importPdf(buf, { ocr: () => null });
  assert.match(batch.warning, /taranmış görüntü okunamadı/);
  assert.equal(batch.lines.length, 0);
  p.close();
});

test('importPdf: gecersiz tur (kind) reddedilir, gecersiz PDF govdesi PlanningError firlatir', () => {
  const p = planlama();
  assert.throws(() => p.incomingOrders.importPdf(orderPdf([]), { kind: 'baska' }));
  assert.throws(() => p.incomingOrders.importPdf(Buffer.from('bu bir pdf degil')));
  p.close();
});

/* ====================================================================================== approvedLinesForOrder */
/* "Hepsi TEK siparişte Mikro'ya gönder" (2026-11-19, kullanıcı isteği) — Mikro'ya hiçbir şey yazmaz, yalnız
 * taslağın ONAYLI satırlarını okuyup doğrular; gerçek Mikro gövdesinin KURULMASI mikro-order.test.js'te. */

test('approvedLinesForOrder: hic onayli satir yoksa reddeder; onayli satirlar (ve YALNIZ onayli olanlar) donuyor', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  p.createProduct({ stockCode: 'SR027.013', name: 'RAKOR SOMUN', customerCode: '140100297' });
  const html = `<table><tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100297</td><td>RAKOR SOMUN</td><td>10</td></tr>
    <tr><td>20.11.2026</td><td>A</td><td>999999999</td><td>BILINMEYEN</td><td>5</td></tr></table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  assert.throws(() => p.incomingOrders.approvedLinesForOrder(batch.id), (e) => e.code === 'no-lines', 'hic satir onaylanmadi');

  p.incomingOrders.approveLine(batch.lines[0].id);
  // 3. satir (999999999, eslesmeyen) elle reddedilir; onaylanan TEK satir dışında hiçbiri sonuca GİRMEZ
  p.incomingOrders.rejectLine(batch.lines[2].id);
  const r1 = p.incomingOrders.approvedLinesForOrder(batch.id);
  assert.equal(r1.lines.length, 1);
  assert.equal(r1.lines[0].matchedStockCode, 'SR009.013');

  p.incomingOrders.approveLine(batch.lines[1].id);
  const r2 = p.incomingOrders.approvedLinesForOrder(batch.id);
  assert.deepEqual(r2.lines.map((l) => l.matchedStockCode), ['SR009.013', 'SR027.013'], 'IKI onayli satir, satir sirasina gore');
  p.close();
});

test('approvedLinesForOrder: onayli bir satir urune esli DEGILSE (veri butunlugu, normalde approveLine bunu zaten engeller) acikca reddeder', () => {
  const p = planlama();
  p.createProduct({ stockCode: 'SR009.013', name: 'BOSCH RING', customerCode: '140100109' });
  const html = `<table><tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>A</td><td>140100109</td><td>BOSCH RING</td><td>250</td></tr></table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  p.incomingOrders.approveLine(batch.lines[0].id);
  // bozuk veriyi dogrudan simule et: onaylanmis ama urun esli DEGIL (normal akista imkansiz, savunma amacli)
  p.db.db.prepare("UPDATE incoming_lines SET matched_stock_code = NULL WHERE id = ?").run(batch.lines[0].id);
  assert.throws(() => p.incomingOrders.approvedLinesForOrder(batch.id), (e) => e.code === 'no-product');
  p.close();
});
