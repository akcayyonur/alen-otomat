/**
 * Paketleme formu (EYS.FR.007): vardiya sayfasi, satir dogrulama, koli ici adedin OGRENILMESI ve onerisi, duzeltme / iptal, is emri toplami,
 * yetki ve kapali bolum. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { classify } from '../auth/policy.js';
import { docx } from './test/doc-fixture.js';

const NOW = new Date(2026, 9, 15, 10).getTime(); // gunduz vardiyasi
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;123456789 TEST SOMUN A;SR001.013;;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '2026000002;03.01.2026;ORNEK NIPEL;SR002.013;;CNC;100;HM614.YU23.00;;27;5;0,039;0,0078',
  '',
].join('\r\n');

function kur(opts = {}) {
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [{ id: 'CNC-01', name: 'Torna 1' }], productionEvents: () => [], liveMachine: () => null, ...opts });
  p.importFile(Buffer.from(ISEMRI, 'utf8'));
  return p;
}
const satir = (ek = {}) => ({ stockCode: 'SR001.013', operator: 'Ayşe', boxes: 3, boxQty: 300, halfQty: 183, visualCheck: true, scrapQty: 3, ...ek });

test('sayfa: bos vardiya; satir eklenince toplam = koli x koli ici adet + yarim koli; hurda ayri; varsayilan tarih/vardiya simdiki uretim gunu', () => {
  const p = kur();
  const bos = p.packing.sheet({}, { now: NOW });
  assert.deepEqual([bos.day, bos.shift, bos.shiftLabel, bos.rows.length, bos.airBar], ['2026-10-15', 'gunduz', 'Gündüz', 0, null]);
  const r = p.packing.addRow(satir(), { by: 'fabrika', now: NOW });
  assert.deepEqual([r.total, r.boxes, r.boxQty, r.halfQty, r.visualCheck, r.scrapQty, r.operator, r.createdBy], [1083, 3, 300, 183, true, 3, 'Ayşe', 'fabrika']);
  assert.deepEqual([r.productName, r.customerCode], ['123456789 TEST SOMUN A', '123456789'], 'urun adi ve musteri urun kodu satira kopyalanir');
  p.packing.addRow(satir({ stockCode: 'SR002.013', boxes: 1, boxQty: 567, halfQty: null, scrapQty: 43, visualCheck: false }), { now: NOW });
  const s = p.packing.sheet({}, { now: NOW });
  assert.deepEqual(s.totals, { rows: 2, boxes: 4, pieces: 1083 + 567, scrap: 46 });
  // gece vardiyasi ve baska gun ayri sayfadir
  assert.equal(p.packing.sheet({ day: '2026-10-15', shift: 'gece' }, { now: NOW }).rows.length, 0);
  assert.equal(p.packing.sheet({ day: '2026-10-14' }, { now: NOW }).rows.length, 0);
  p.close();
});

test('sayfa basligi: hava basinci kaydedilir / silinir; gecersiz tarih, vardiya, basinc reddedilir', () => {
  const p = kur();
  assert.equal(p.packing.setAirBar({ airBar: '7,5' }, { by: 'ali', now: NOW }).airBar, 7.5);
  assert.equal(p.packing.sheet({}, { now: NOW }).airBar, 7.5);
  assert.equal(p.packing.sheet({ shift: 'gece' }, { now: NOW }).airBar, null, 'vardiya basina ayri');
  assert.equal(p.packing.setAirBar({ airBar: '' }, { now: NOW }).airBar, null);
  assert.throws(() => p.packing.setAirBar({ airBar: 25 }, { now: NOW }), /0 ile 20 bar/);
  assert.throws(() => p.packing.sheet({ day: '2026-13-40' }, { now: NOW }), /yyyy-aa-gg/);
  assert.throws(() => p.packing.sheet({ shift: 'ogle' }, { now: NOW }), /gunduz ya da gece/);
  p.close();
});

test('satir dogrulama: urun karti, operator, adetler, is emri eslesmesi', () => {
  const p = kur();
  const a = (ek) => p.packing.addRow(satir(ek), { now: NOW });
  assert.throws(() => a({ stockCode: 'SR999.999' }), (e) => e.status === 404 && e.code === 'no-product');
  assert.throws(() => a({ stockCode: '' }), /Ürün/);
  assert.throws(() => a({ operator: '  ' }), /Operatör ismi/);
  assert.throws(() => a({ boxes: 2, boxQty: 0 }), /koli içi adet de girilmeli/);
  assert.throws(() => a({ boxes: 0, boxQty: 0, halfQty: null, scrapQty: null }), /Adet girilmedi/);
  assert.throws(() => a({ boxes: -1 }), /tam sayı/);
  assert.throws(() => a({ boxQty: 12.5 }), /tam sayı/);
  assert.throws(() => a({ woNo: '2026009999' }), (e) => e.status === 404);
  const w2 = p.createWorkOrder({ stockCode: 'SR002.013', targetQty: 100 }, { now: NOW });
  assert.throws(() => a({ woNo: w2.no }), (e) => e.status === 409 && e.code === 'wo-mismatch', 'baska urunun is emri');
  const w1 = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100 }, { now: NOW });
  assert.equal(a({ woNo: w1.no }).woNo, w1.no);
  assert.equal(a({ boxes: 0, boxQty: 0, halfQty: null, scrapQty: 9 }).total, 0, 'yalniz hurda satiri olabilir');
  assert.equal(a({ boxes: 0, boxQty: 0, halfQty: 120, scrapQty: null }).total, 120, 'yalniz yarim koli');
  p.close();
});

test('OGRENME: ilk koli standart koli ici adedi urun kartina yazar (bir kere, "elle duzenlendi" sayilmaz); sonraki paketlemeler degistirmez; yarim koli ogretmez', () => {
  const p = kur();
  assert.equal(p.getProduct('SR001.013').boxQty, null);
  const yarim = p.packing.addRow(satir({ boxes: 0, boxQty: 0, halfQty: 90, scrapQty: null }), { now: NOW });
  assert.deepEqual([yarim.learned, p.getProduct('SR001.013').boxQty], [false, null], 'tam koli yok: ogrenilmez');

  const ilk = p.packing.addRow(satir({ boxes: 2, boxQty: 300 }), { now: NOW });
  assert.deepEqual([ilk.learned, ilk.standardBoxQty], [true, 300]);
  const kart = p.getProduct('SR001.013');
  assert.deepEqual([kart.boxQty, kart.edited], [300, false], 'kart elle duzenlenmis sayilmaz: Excel iceri almasi onu guncellemeye devam eder');

  const ikinci = p.packing.addRow(satir({ boxes: 1, boxQty: 567 }), { now: NOW }); // kutuya fazla sikistirilmis
  assert.deepEqual([ikinci.learned, ikinci.standardBoxQty, p.getProduct('SR001.013').boxQty], [false, 300, 300], '+- degisimi standardi oynatmaz');
  // yonetici urun kartindan degistirir
  p.updateProduct('SR001.013', { boxQty: 310 });
  assert.equal(p.getProduct('SR001.013').boxQty, 310);
  assert.throws(() => p.updateProduct('SR001.013', { boxQty: 12.5 }), /tam sayı/);
  assert.equal(p.updateProduct('SR001.013', { boxQty: null }).boxQty, null);
  p.close();
});

test('duzeltme ve iptal: duzeltme toplami yeniler (urun degismez); iptal edilen satir sayfada ve toplamda yok, kayitta durur', () => {
  const p = kur();
  const r = p.packing.addRow(satir(), { now: NOW });
  const d = p.packing.updateRow(r.id, { boxes: 4, halfQty: 10, operator: 'Canan' }, { by: 'ali', now: NOW + 1000 });
  assert.deepEqual([d.boxes, d.total, d.operator, d.stockCode, d.updatedBy], [4, 1210, 'Canan', 'SR001.013', 'ali']);
  assert.throws(() => p.packing.updateRow(r.id, { boxes: 2, boxQty: 0 }, { now: NOW }), /koli içi adet/);
  assert.equal(p.packing.sheet({}, { now: NOW }).totals.pieces, 1210);

  p.packing.voidRow(r.id, { reason: 'yanlış ürün' }, { by: 'ali', now: NOW });
  assert.equal(p.packing.sheet({}, { now: NOW }).rows.length, 0);
  assert.deepEqual({ ...p.db.db.prepare('SELECT void_reason, voided_by FROM packing_rows WHERE id = ?').get(r.id) }, { void_reason: 'yanlış ürün', voided_by: 'ali' });
  assert.throws(() => p.packing.updateRow(r.id, {}, { now: NOW }), (e) => e.status === 404);
  assert.throws(() => p.packing.voidRow(9999, {}, { now: NOW }), (e) => e.status === 404);
  p.close();
});

test('oneri: standart koli ici adet, son paketlemelerde sik gorulenler, secilebilir is emirleri (uretimde once), etiket dosyalari', () => {
  const p = kur();
  assert.deepEqual(p.packing.suggest('SR001.013'), {
    stockCode: 'SR001.013', name: '123456789 TEST SOMUN A', customerCode: '123456789', boxQty: null, common: [], orders: [], stickers: [],
  });
  for (const q of [300, 300, 310, 300, 567]) p.packing.addRow(satir({ boxes: 1, boxQty: q, halfQty: null }), { now: NOW });
  const bekleyen = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 50 }, { now: NOW });
  const eski = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 50, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(eski.no, {}, { now: NOW });
  const etiket = p.quality.addProductFile('SR001.013', 'etiket', { name: 'SR001.013 etiket.docx', data: docx('SR001.013') }, { now: NOW });

  const s = p.packing.suggest('sr001.013'); // kucuk harf de olur
  assert.equal(s.boxQty, 300, 'ilk tam koli');
  assert.deepEqual(s.common, [{ boxQty: 300, count: 3 }, { boxQty: 567, count: 1 }, { boxQty: 310, count: 1 }].sort((a, b) => b.count - a.count || b.boxQty - a.boxQty));
  assert.deepEqual(s.orders.map((o) => [o.no, o.status]), [[eski.no, 'uretimde'], [bekleyen.no, 'planlandi']]);
  assert.deepEqual(s.stickers, [{ id: etiket.id, name: 'SR001.013 etiket.docx', size: etiket.size, folder: '' }]);
  assert.throws(() => p.packing.suggest('SR999.999'), (e) => e.status === 404);
  p.close();
});

test('is emri ayrintisinda paketleme toplami: satir, koli, adet, hurda (iptal edilenler hariç)', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 2000 }, { now: NOW });
  assert.deepEqual(p.getWorkOrder(w.no, { now: NOW }).packing, { rows: 0, boxes: 0, pieces: 0, scrap: 0 });
  p.packing.addRow(satir({ woNo: w.no }), { now: NOW });
  const iptal = p.packing.addRow(satir({ woNo: w.no, boxes: 1, boxQty: 100, halfQty: null, scrapQty: 5 }), { now: NOW });
  p.packing.addRow(satir({ boxes: 9, boxQty: 9 }), { now: NOW }); // is emrine bagli degil
  p.packing.voidRow(iptal.id, {}, { now: NOW });
  assert.deepEqual(p.getWorkOrder(w.no, { now: NOW }).packing, { rows: 1, boxes: 3, pieces: 1083, scrap: 3 });
  p.close();
});

/* ------------------------------------------------------------ yetki ve HTTP */

test('yetki: paketleme formu operator + yonetici, izleyiciye kapali; klasor eslestirme ve dosya kaldirma yalniz yonetici; etiket dosyasini operator acar', () => {
  for (const [m, yol] of [
    ['GET', '/api/planning/packing/sheet'], ['GET', '/api/planning/packing/suggest'], ['PUT', '/api/planning/packing/sheet/air'], ['POST', '/api/planning/packing/rows'],
    ['PUT', '/api/planning/packing/rows/12'], ['DELETE', '/api/planning/packing/rows/12'], ['GET', '/api/planning/product-files/5'],
  ]) assert.equal(classify(m, yol), 'operator', `${m} ${yol}`);
  for (const [m, yol] of [
    ['DELETE', '/api/planning/product-files/5'], ['GET', '/api/planning/drawing-folder'], ['PUT', '/api/planning/drawing-folder/dir'], ['POST', '/api/planning/drawing-folder/match'],
    ['GET', '/api/planning/sticker-folder'], ['PUT', '/api/planning/sticker-folder/dir'], ['POST', '/api/planning/sticker-folder/match'],
  ]) assert.equal(classify(m, yol), 'admin', `${m} ${yol}`);
});

async function sunucu(p, closedSections = []) {
  const routes = createPlanningRoutes({ planning: p, closedSections });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; };
  const json = (method, obj) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  return { base, j, json, kapat: () => new Promise((r) => srv.close(r)) };
}

test('HTTP: sayfa, satir ekle/duzelt/iptal, oneri, hava basinci; hatali girdi 400; kapali paketleme bolumunde 403 section-closed', async () => {
  const p = kur();
  const s = await sunucu(p);
  try {
    const ekle = await s.j('/api/planning/packing/rows', s.json('POST', satir()));
    assert.equal(ekle.status, 201, JSON.stringify(ekle.json));
    assert.deepEqual([ekle.json.total, ekle.json.learned, ekle.json.standardBoxQty], [1083, true, 300]);
    assert.equal((await s.j('/api/planning/packing/rows', s.json('POST', satir({ operator: '' })))).status, 400);
    assert.equal((await s.j('/api/planning/packing/rows', s.json('POST', satir({ stockCode: 'YOK.000' })))).status, 404);
    const d = await s.j(`/api/planning/packing/rows/${ekle.json.id}`, s.json('PUT', { boxes: 5 }));
    assert.deepEqual([d.status, d.json.total], [200, 1683]);
    const hava = await s.j('/api/planning/packing/sheet/air', s.json('PUT', { airBar: 7 }));
    assert.equal(hava.json.airBar, 7);
    const sayfa = (await s.j('/api/planning/packing/sheet')).json;
    assert.deepEqual([sayfa.rows.length, sayfa.totals.pieces, sayfa.airBar], [1, 1683, 7]);
    assert.equal((await s.j('/api/planning/packing/suggest?stockCode=SR001.013')).json.boxQty, 300);
    assert.equal((await s.j(`/api/planning/packing/rows/${ekle.json.id}?reason=hata`, { method: 'DELETE' })).json.voided, true);
    assert.equal((await s.j('/api/planning/packing/sheet')).json.rows.length, 0);
  } finally { await s.kapat(); }

  const kapali = await sunucu(p, ['paketleme']);
  try {
    for (const [yol, init] of [['/api/planning/packing/sheet'], ['/api/planning/packing/suggest?stockCode=SR001.013'], ['/api/planning/packing/rows', kapali.json('POST', satir())]]) {
      const r = await kapali.j(yol, init);
      assert.deepEqual([r.status, r.json.code, r.json.section], [403, 'section-closed', 'paketleme'], yol);
    }
  } finally { await kapali.kapat(); p.close(); }
});
