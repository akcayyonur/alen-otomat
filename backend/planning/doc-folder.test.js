/**
 * Teknik resim klasoru (PDF) ve etiket klasoru (Word / PDF): IKI AYRI klasor, dosyalar Alen Otomat urun koduna gore urun kartlarina eslenir.
 * Kod tespiti, yalniz dosyasi olmayan urunlerin eslenmesi, yeni is emrinin urun resimlerini devralmasi, guncelleme, kabul edilmeyen dosyalar, HTTP. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { nameKeys, productCodesIn, textKeys } from './doc-folder.js';
import { docx, pdf } from './test/doc-fixture.js';

const NOW = new Date(2026, 9, 15, 10).getTime();

function kur() {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-dokuman-'));
  const resim = join(dir, 'teknik-resim');
  const etiket = join(dir, 'etiket');
  const p = new Planning({
    dbFile: ':memory:', listMachines: () => [{ id: 'CNC-01', name: 'Torna 1' }], productionEvents: () => [], liveMachine: () => null, drawingsDir: resim, stickersDir: etiket,
  });
  for (const [kod, ad] of [['SR001.001', 'BIRINCI'], ['SR002.001', 'IKINCI'], ['SR003.001', 'UCUNCU'], ['SR005.001', 'DOSYASIZ'], ['Nİ002.001', 'TURKCE']]) {
    p.createProduct({ stockCode: kod, name: ad, material: 'HM1', grossKg: 0.05, netKg: 0.04, plannedSec: 20 });
  }
  const yaz = (klasor, ad, icerik) => {
    const yol = join(klasor, ad);
    mkdirSync(join(yol, '..'), { recursive: true });
    writeFileSync(yol, icerik);
  };
  return { p, dir, resim, etiket, yaz, bitir: () => { p.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('kod tespiti: ayirici nokta / tire / alt cizgi / bosluk / hic; Turkce harf; birden cok kod; harfe yapisik ya da fazla rakamli degil', () => {
  const kodlar = (t) => productCodesIn(t).map((c) => c.code);
  assert.deepEqual(kodlar('SR002.013 DAIKIN 4P396838-2.pdf'), ['SR002.013']);
  assert.deepEqual(kodlar('SR002-013.pdf'), ['SR002.013']);
  assert.deepEqual(kodlar('sr002_013 resim.pdf'), ['SR002.013']);
  assert.deepEqual(kodlar('SR 002 013.docx'), ['SR002.013']);
  assert.deepEqual(kodlar('SR002013.pdf'), ['SR002.013']);
  assert.deepEqual(kodlar('SR.002.013.pdf'), ['SR002.013']);
  assert.deepEqual(kodlar('Nİ002.001 nipel.pdf'), ['NİI002.001'.replace('NİI', 'Nİ')]);
  assert.deepEqual(kodlar('SR001.001 ve SR002.001 ortak.pdf'), ['SR001.001', 'SR002.001']);
  assert.deepEqual(kodlar('klasor SR003.001/resim.pdf'), ['SR003.001']);
  assert.deepEqual(kodlar('XSR002.013.pdf'), [], 'harfe yapisik: baska bir sozcuk');
  assert.deepEqual(kodlar('SR002.0135.pdf'), [], 'fazla rakam');
  assert.deepEqual(kodlar('rev 12 draw 3.pdf'), []);
  assert.deepEqual(kodlar(null), []);
});

test('klasorler AYRI: varsayilan yollar ve ayarlar bagimsiz; gecersiz yol reddedilir; varsayilan ilk bakista olusur, ayarlanan olusturulmaz', () => {
  const k = kur();
  try {
    assert.equal(k.p.drawingFolder.status().dir, k.resim);
    assert.equal(k.p.stickerFolder.status().dir, k.etiket);
    assert.deepEqual([k.p.drawingFolder.status().exists, k.p.stickerFolder.status().exists], [true, true]);
    assert.notEqual(k.resim, k.etiket);
    const diger = join(k.dir, 'baska');
    mkdirSync(diger);
    k.p.drawingFolder.setDir(diger);
    assert.deepEqual([k.p.drawingFolder.config().dir, k.p.stickerFolder.config().dir], [diger, k.etiket], 'etiket klasoru etkilenmez');
    assert.equal(k.p.drawingFolder.setDir('').isDefault, true);
    assert.throws(() => k.p.stickerFolder.setDir('goreli'), /tam \(mutlak\)/);
    assert.throws(() => k.p.stickerFolder.setDir(join(k.dir, 'yok')), (e) => e.code === 'no-dir');
    assert.deepEqual(k.p.drawingFolder.config().extensions, ['.pdf']);
    assert.deepEqual(k.p.stickerFolder.config().extensions, ['.docx', '.doc', '.pdf']);
  } finally { k.bitir(); }
});

test('TEKNIK RESIM klasoru: koda gore eslenir (alt klasor, tireli ad, ayni urune iki dosya); karti olmayan / kodsuz dosya listelenir; resmi olmayan urunler raporlanir', () => {
  const k = kur();
  try {
    k.yaz(k.resim, 'SR001.001 BIRINCI.pdf', pdf('A1'));
    k.yaz(k.resim, 'SR001.001-2.pdf', pdf('A2'));
    k.yaz(k.resim, 'SR002-001.pdf', pdf('B1'));
    k.yaz(k.resim, 'musteri/SR003.001/resim.pdf', pdf('C1'));
    k.yaz(k.resim, 'Ni002.001.pdf', pdf('T1'));
    k.yaz(k.resim, 'SR004 001.pdf', pdf('D1')); // karti yok
    k.yaz(k.resim, 'rastgele.pdf', pdf('R1')); // kod yok
    k.yaz(k.resim, 'notlar.txt', 'x');
    k.yaz(k.resim, '~$SR005.001.pdf', 'kilit');
    k.yaz(k.resim, 'SR005.001 etiket.docx', docx('SR005.001')); // resim klasorunde Word okunmaz

    assert.deepEqual([k.p.drawingFolder.status().files, k.p.drawingFolder.status().without], [7, 5]);
    const r = k.p.drawingFolder.match({ by: 'ayse', now: NOW });
    assert.deepEqual([r.scanned, r.products, r.alreadyHad], [7, 4, 0]);
    assert.deepEqual(r.attached.map((a) => [a.stockCode, a.files.length]), [['Nİ002.001', 1], ['SR001.001', 2], ['SR002.001', 1], ['SR003.001', 1]]);
    assert.deepEqual(r.unmatched.map((u) => [u.name, u.reason]).sort(), [['SR004 001.pdf', 'ürün kartı yok (SR004.001)'], ['rastgele.pdf', 'ürün kodu bulunamadı']]);
    assert.deepEqual(r.rejected, []);
    assert.deepEqual([r.missing.total, r.missing.sample], [1, ['SR005.001']], 'hala resmi olmayan urun');
    assert.deepEqual(k.p.getProduct('SR001.001').files.map((f) => [f.kind, f.name, f.source, f.pages]), [['cizim', 'SR001.001 BIRINCI.pdf', 'klasor', 1], ['cizim', 'SR001.001-2.pdf', 'klasor', 1]]);
    assert.equal(k.p.getProduct('SR005.001').files.length, 0);

    // ikinci eslestirme: resmi olanlara dokunulmaz
    const r2 = k.p.drawingFolder.match({ now: NOW });
    assert.deepEqual([r2.products, r2.alreadyHad], [0, 4]);
    assert.equal(k.p.getProduct('SR001.001').files.length, 2, 'cogalmadi');
  } finally { k.bitir(); }
});

test('yeni is emri urunun resimlerini KENDISI alir; bitmemis resimsiz is emirlerine de baglanir; elle yuklenmis eski resmi olan urun atlanir', () => {
  const k = kur();
  try {
    const bekleyen = k.p.createWorkOrder({ stockCode: 'SR002.001', targetQty: 10 }, { now: NOW });
    assert.equal(k.p.getWorkOrder(bekleyen.no).drawings.length, 0);
    // SR003.001'in eski bir is emrine elle PDF yuklenmis: "teknik resmi var" sayilir
    const eski = k.p.createWorkOrder({ stockCode: 'SR003.001', targetQty: 10 }, { now: NOW });
    k.p.quality.addDrawing(eski.no, { name: 'elle.pdf', data: pdf('ELLE') }, { now: NOW });

    k.yaz(k.resim, 'SR001.001.pdf', pdf('A1'));
    k.yaz(k.resim, 'SR002.001.pdf', pdf('B1'));
    k.yaz(k.resim, 'SR003.001.pdf', pdf('C1'));
    const r = k.p.drawingFolder.match({ now: NOW });
    assert.deepEqual([r.products, r.alreadyHad, r.orders], [2, 1, 1]);
    assert.equal(k.p.getProduct('SR003.001').files.length, 0, 'elle yuklenmis resmi olan urune dokunulmadi');
    assert.deepEqual(k.p.getWorkOrder(bekleyen.no).drawings.map((d) => d.name), ['SR002.001.pdf'], 'mevcut bekleyen is emrine baglandi');

    const yeni = k.p.createWorkOrder({ stockCode: 'SR001.001', targetQty: 10 }, { now: NOW });
    assert.deepEqual(k.p.getWorkOrder(yeni.no).drawings.map((d) => d.name), ['SR001.001.pdf'], 'yeni is emri urunun resmini devraldi');
    assert.ok(k.p.workOrderPrintPdf(yeni.no).length > 0, 'form + resim tek PDF');
    // urunden kaldirilinca bundan sonraki is emirleri almaz, mevcut is emri resmini korur
    const dosya = k.p.getProduct('SR001.001').files[0];
    k.p.quality.removeProductFile(dosya.id);
    assert.equal(k.p.getWorkOrder(yeni.no).drawings.length, 1);
    assert.equal(k.p.getWorkOrder(k.p.createWorkOrder({ stockCode: 'SR001.001', targetQty: 5 }, { now: NOW }).no).drawings.length, 1, 'oncekinin resmini devralir (eski davranis)');
  } finally { k.bitir(); }
});

test('guncelleme: klasorden eslenmis dosya degistiyse (yeni revizyon) yenisiyle degisir; degismediyse "degismedi"; elle eklenene dokunulmaz', () => {
  const k = kur();
  try {
    k.yaz(k.resim, 'SR001.001.pdf', pdf('REV-A'));
    k.p.drawingFolder.match({ now: NOW });
    k.p.quality.addProductFile('SR001.001', 'cizim', { name: 'elle-ek.pdf', data: pdf('EK'), source: 'elle' }, { now: NOW });

    const ayni = k.p.drawingFolder.match({ update: true, now: NOW });
    assert.deepEqual([ayni.updated, ayni.unchanged, ayni.products], [0, 1, 0]);

    k.yaz(k.resim, 'SR001.001.pdf', pdf('REV-B'));
    const guncel = k.p.drawingFolder.match({ update: true, now: NOW });
    assert.deepEqual([guncel.updated, guncel.products], [1, 1]);
    assert.deepEqual(guncel.attached, [{ stockCode: 'SR001.001', files: ['SR001.001.pdf'], updated: true, orders: 0, via: ['ürün kodu'] }]);
    const dosyalar = k.p.getProduct('SR001.001').files;
    assert.deepEqual(dosyalar.map((f) => [f.name, f.source]).sort(), [['SR001.001.pdf', 'klasor'], ['elle-ek.pdf', 'elle']]);
    // guncelleme istenmediyse (varsayilan) degisen dosya YENIDEN okunmaz
    k.yaz(k.resim, 'SR001.001.pdf', pdf('REV-C'));
    assert.equal(k.p.drawingFolder.match({ now: NOW }).updated, 0);
  } finally { k.bitir(); }
});

test('kabul edilmeyen dosyalar: bozuk PDF, 8 dosya siniri; kalan dosyalar yine eslenir', () => {
  const k = kur();
  try {
    k.yaz(k.resim, 'SR001.001 bozuk.pdf', Buffer.from('%PDF-1.4 bozuk icerik'));
    k.yaz(k.resim, 'SR001.001 iyi.pdf', pdf('IYI'));
    for (let i = 0; i < 9; i += 1) k.yaz(k.resim, `SR002.001-${i}.pdf`, pdf(`S${i}`));
    const r = k.p.drawingFolder.match({ now: NOW });
    assert.equal(k.p.getProduct('SR001.001').files.length, 1, 'bozuk PDF atlandi, iyisi eslendi');
    assert.equal(k.p.getProduct('SR002.001').files.length, 8, 'en cok 8');
    assert.ok(r.rejected.some((x) => x.name === 'SR001.001 bozuk.pdf' && /PDF kabul edilmedi/.test(x.error)), JSON.stringify(r.rejected));
    assert.ok(r.rejected.some((x) => /en çok 8/.test(x.error)));
  } finally { k.bitir(); }
});

test('ETIKET klasoru: Word dosyasi koda gore (ad ya da .docx ICINDEKI kod); PDF de kabul; ilgisiz Word listelenir; teknik resim klasoru karismaz', () => {
  const k = kur();
  try {
    k.yaz(k.etiket, 'SR001.001 etiket.docx', docx('x'));
    k.yaz(k.etiket, 'kutu-1.docx', docx('Alen Otomat ', 'SR00', '2.0', '01', ' kutu etiketi')); // koddan parcalara bolunmus, adda yok
    k.yaz(k.etiket, 'SR003-001.pdf', pdf('ET'));
    k.yaz(k.etiket, 'kodsuz.docx', docx('kod yok burada'));
    k.yaz(k.etiket, 'sahte.docx', Buffer.from('bu bir word degil')); // adinda kod var ama Word degil
    k.yaz(k.etiket, 'SR005.001 sahte.docx', Buffer.from('bu bir word degil'));
    k.yaz(k.resim, 'SR001.001.pdf', pdf('RESIM'));

    assert.equal(k.p.stickerFolder.status().files, 6);
    const r = k.p.stickerFolder.match({ by: 'ayse', now: NOW });
    assert.equal(r.kind, 'etiket');
    assert.deepEqual(r.attached.map((a) => [a.stockCode, a.files]), [['SR001.001', ['SR001.001 etiket.docx']], ['SR002.001', ['kutu-1.docx']], ['SR003.001', ['SR003-001.pdf']]]);
    assert.ok(r.rejected.some((x) => x.name === 'SR005.001 sahte.docx' && /Word belgesi/.test(x.error)), JSON.stringify(r.rejected));
    assert.deepEqual(r.unmatched.map((u) => u.name).sort(), ['kodsuz.docx', 'sahte.docx']);
    assert.equal(r.orders, 0, 'etiket is emrine baglanmaz');
    assert.deepEqual(k.p.getProduct('SR001.001').files.map((f) => f.kind), ['etiket'], 'resim klasorundeki PDF etiket klasorunden eslenmedi (ve tersi)');
    assert.equal(k.p.getProduct('SR001.001').files.length, 1);

    const rr = k.p.drawingFolder.match({ now: NOW });
    assert.deepEqual(k.p.getProduct('SR001.001').files.map((f) => f.kind).sort(), ['cizim', 'etiket']);
    assert.equal(rr.scanned, 1);
    assert.equal(k.p.stickerFolder.match({ now: NOW }).alreadyHad, 3);
  } finally { k.bitir(); }
});

test('HTTP: klasor durumu / ayari / esleme (iki klasor ayri adreslerde); urun dosyasi indirme (PDF satir ici, Word indirilir, Turkce ad); kaldirma', async () => {
  const k = kur();
  const routes = createPlanningRoutes({ planning: k.p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json().catch(() => null) }; };
  const json = (method, obj) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    k.yaz(k.resim, 'SR001.001.pdf', pdf('R'));
    k.yaz(k.etiket, 'SR001.001 çıktı etiketi.docx', docx('x'));
    assert.deepEqual([(await j('/api/planning/drawing-folder')).json.files, (await j('/api/planning/sticker-folder')).json.files], [1, 1]);
    const m1 = await j('/api/planning/drawing-folder/match', json('POST', {}));
    const m2 = await j('/api/planning/sticker-folder/match', json('POST', {}));
    assert.deepEqual([m1.status, m1.json.kind, m1.json.products, m2.json.kind, m2.json.products], [200, 'cizim', 1, 'etiket', 1]);
    assert.equal((await j('/api/planning/sticker-folder/dir', json('PUT', { dir: 'goreli' }))).status, 400);

    const dosyalar = (await j('/api/planning/products/SR001.001')).json.files;
    const resim = dosyalar.find((f) => f.kind === 'cizim');
    const etiket = dosyalar.find((f) => f.kind === 'etiket');
    const a = await fetch(`${base}/api/planning/product-files/${resim.id}`);
    assert.deepEqual([a.status, a.headers.get('content-type'), a.headers.get('content-disposition').startsWith('inline')], [200, 'application/pdf', true]);
    const b = await fetch(`${base}/api/planning/product-files/${etiket.id}`);
    assert.equal(b.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.match(b.headers.get('content-disposition'), /^attachment; filename="SR001\.001 __kt_ etiketi\.docx"; filename\*=UTF-8''SR001\.001%20%C3%A7%C4%B1kt%C4%B1%20etiketi\.docx$/);
    assert.equal((await b.arrayBuffer()).byteLength > 0, true);

    assert.equal((await j(`/api/planning/product-files/${resim.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await j(`/api/planning/product-files/${resim.id}`)).status, 404);
    assert.equal((await j('/api/planning/products/SR001.001')).json.files.length, 1);
  } finally {
    await new Promise((r) => srv.close(r));
    k.bitir();
  }
});

/* ================================================================== musteri urun koduyla eslesme (fabrikadaki etiket dosyalari bu sekilde adlandirilmis) */

const OLE = Buffer.from('D0CF11E0A1B11AE1', 'hex');
/** Eski .doc'un kabaca taklidi: OLE imzasi + cop + metin (8 bit ya da UTF-16, tek/cift hizalama). */
const eskiDoc = (metin, { utf16 = false, kaydir = false } = {}) =>
  Buffer.concat([OLE, Buffer.alloc(300, 0x01), kaydir ? Buffer.from([0x7f]) : Buffer.alloc(0), Buffer.from(metin, utf16 ? 'utf16le' : 'latin1'), Buffer.alloc(40, 0x02)]);

function kurMusteri() {
  const k = kur();
  k.p.createProduct({ stockCode: 'SR101.001', name: 'PUSH FIT', customerCode: '601037010525' });
  k.p.createProduct({ stockCode: 'SR102.001', name: 'KONVEYOR', customerCode: '1235-669' });
  k.p.createProduct({ stockCode: 'SR103.001', name: 'NOKTALI', customerCode: '601.SMN.613.001' });
  k.p.createProduct({ stockCode: 'SR104.001', name: 'IKIZ A', customerCode: '777000111' });
  k.p.createProduct({ stockCode: 'SR104.002', name: 'IKIZ B', customerCode: '777000111' });
  k.p.createProduct({ stockCode: 'SR105.001', name: 'BOLUNMUS', customerCode: '555123456' });
  return k;
}

test('musteri kodu adaylari: tum ad ve her sozcuk; kisa/rakamsiz sozcuk kod sayilmaz; nokta-tire-bosluk fark etmez', () => {
  assert.ok(nameKeys('AYVAZ N/601037100010 N.doc').includes('601037100010') && !nameKeys('AYVAZ N/601037100010 N.doc').includes('N'), '"N" tek basina kod degil');
  assert.ok(nameKeys('Nİ001.012 - 6018011703501.doc').includes('6018011703501'));
  assert.deepEqual(nameKeys('BERG/1235-669.doc'), ['1235669']);
  assert.deepEqual(nameKeys('601037010416 .doc'), ['601037010416'], 'sondaki bosluk');
  assert.deepEqual(nameKeys('601.SMN.613.001.pdf'), ['601SMN613001']);
  assert.deepEqual(nameKeys('ALEN ETİKET ŞABLONU.doc'), [], 'rakam yok');
  assert.deepEqual(nameKeys('HAMMADDE ETİKET.doc'), []);
  assert.deepEqual(textKeys('QTY : 156 | 601037010525 | STANDART | 1003937 x'), ['601037010525', '1003937'], 'kisa "156" ve harfli sozcuk elenir');
});

test('ETIKET klasoru: musteri koduyla adlandirilmis .doc dosyalari musteri klasorlerinde de karttaki musteri koduna baglanir; kodsuz sablon ve kartsiz kod listelenir', () => {
  const k = kurMusteri();
  try {
    k.yaz(k.etiket, 'AYVAZ N/601037010525.doc', eskiDoc('QTY : 156 PACKING DATE : 26.01.2026'));
    k.yaz(k.etiket, 'BERG/1235-669.doc', eskiDoc('x'));
    k.yaz(k.etiket, 'BERG/601037100010 N.doc', eskiDoc('x')); // bu koda ait kart yok
    k.yaz(k.etiket, 'ALEN ETİKET ŞABLONU.doc', eskiDoc('MÜŞTERİ ADI : M-TEKNİK KOLİ İÇİ ADET : 400')); // genel sablon
    k.yaz(k.etiket, 'IKIZ/777000111.doc', eskiDoc('x')); // iki kartta ayni musteri kodu
    const r = k.p.stickerFolder.match({ by: 'ayse', now: NOW });
    assert.deepEqual(r.attached.map((a) => [a.stockCode, a.files, a.via]), [['SR101.001', ['601037010525.doc'], ['müşteri kodu']], ['SR102.001', ['1235-669.doc'], ['müşteri kodu']]]);
    const neden = Object.fromEntries(r.unmatched.map((u) => [u.name.replaceAll('\\', '/'), u.reason]));
    assert.equal(neden['BERG/601037100010 N.doc'], 'ürün kodu bulunamadı');
    assert.equal(neden['ALEN ETİKET ŞABLONU.doc'], 'ürün kodu bulunamadı');
    assert.match(neden['IKIZ/777000111.doc'], /müşteri kodu birden çok ürün kartında \(SR104\.001, SR104\.002\)|müşteri kodu birden çok ürün kartında \(SR104\.002, SR104\.001\)/, 'belirsiz kod BAGLANMAZ');
    assert.equal(k.p.getProduct('SR104.001').files.length + k.p.getProduct('SR104.002').files.length, 0);
    assert.equal(k.p.getProduct('SR101.001').files[0].kind, 'etiket');
  } finally { k.bitir(); }
});

test('onclik: adda Alen kodu varsa o kazanir, musteri kodu parcasi yok sayilir; teknik resim klasoru de musteri koduyla (noktali kod) eslenir', () => {
  const k = kurMusteri();
  try {
    k.yaz(k.resim, 'SR001.001 - 601037010525.pdf', pdf('A')); // Alen kodu SR001.001 + baska kartin musteri kodu
    k.yaz(k.resim, '601.SMN.613.001.pdf', pdf('B')); // yalniz musteri kodu (noktali)
    const r = k.p.drawingFolder.match({ now: NOW });
    assert.deepEqual(r.attached.map((a) => [a.stockCode, a.files, a.via]), [['SR001.001', ['SR001.001 - 601037010525.pdf'], ['ürün kodu']], ['SR103.001', ['601.SMN.613.001.pdf'], ['müşteri kodu']]]);
    assert.equal(k.p.getProduct('SR101.001').files.length, 0, 'musteri kodu parcasi Alen kodunun onune gecmez');
    // yeni is emri bu urunun resmini devralir
    const wo = k.p.createWorkOrder({ stockCode: 'SR103.001', targetQty: 10 }, { now: NOW });
    assert.deepEqual(k.p.getWorkOrder(wo.no).drawings.map((d) => d.name), ['601.SMN.613.001.pdf'], 'yeni is emri musteri koduyla eslenen resmi devraldi');
  } finally { k.bitir(); }
});

test('ETIKET klasoru: adda kod yoksa eski .doc / .docx ICINDEKI musteri kodu bulunur (8 bit, UTF-16, tek hizalama); ilgisiz sayilar eslesmez', () => {
  const k = kurMusteri();
  try {
    k.yaz(k.etiket, 'a.doc', eskiDoc('1003937 | 601037010525 | STANDART | QTY : 156'));
    k.yaz(k.etiket, 'b.doc', eskiDoc('QTY : 12 | 1235-669 | PACKING', { utf16: true }));
    k.yaz(k.etiket, 'c.doc', eskiDoc('QTY : 12 | 601.SMN.613.001', { utf16: true, kaydir: true }));
    k.yaz(k.etiket, 'd.docx', docx('MÜŞTERİ KODU : ', '5551', '23456', ' ikinci')); // kod Word'de birden cok metin parcasina bolunmus
    k.yaz(k.etiket, 'e.doc', eskiDoc('1003937 | 123456789 | QTY : 156'));
    const r = k.p.stickerFolder.match({ now: NOW });
    assert.deepEqual(r.attached.map((a) => [a.stockCode, a.files, a.via]), [['SR101.001', ['a.doc'], ['dosya içi']], ['SR102.001', ['b.doc'], ['dosya içi']], ['SR103.001', ['c.doc'], ['dosya içi']], ['SR105.001', ['d.docx'], ['dosya içi']]]);
    assert.deepEqual(r.unmatched.map((u) => u.name), ['e.doc']);
  } finally { k.bitir(); }
});

test('ayni urune farkli musteri klasorlerinden ayni adli iki etiket gelirse eslesme sonucu klasor yoluyla gosterilir; paketleme onerisi etiketin klasorunu verir', () => {
  const k = kurMusteri();
  try {
    k.yaz(k.etiket, 'A MUSTERI/601037010525.doc', eskiDoc('birinci'));
    k.yaz(k.etiket, 'B MUSTERI/601037010525.doc', eskiDoc('ikinci'));
    const r = k.p.stickerFolder.match({ now: NOW });
    assert.deepEqual(r.attached[0].files.map((x) => x.replaceAll('\\', '/')), ['A MUSTERI/601037010525.doc', 'B MUSTERI/601037010525.doc']);
    assert.deepEqual(k.p.packing.suggest('SR101.001').stickers.map((x) => [x.name, x.folder]), [['601037010525.doc', 'A MUSTERI'], ['601037010525.doc', 'B MUSTERI']]);
  } finally { k.bitir(); }
});
