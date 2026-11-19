/**
 * Mail'den gelen taslak siparişi gerçek Mikro siparişine (SiparisKaydetV2) çevirme (mikro-order.js): saf önizleme
 * kurma + yazma kapısı + müşteri çözümleme. GERÇEK AĞ YOK (client.sqlQuery/call sahte fonksiyonlarla beslenir).
 * `send()`in MIKRO_WRITE_ENABLED olmadan client.call'ı ASLA çağırmadığı ayrıca doğrulanır.
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MikroOrders } from './mikro-order.js';

function kur({ writeEnabled = () => false, sqlQuery = async () => [], call = async () => { throw new Error('call çağrılmamalı'); } } = {}) {
  const calls = [];
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => { calls.push(sql); return sqlQuery(sql); },
    call: async (endpoint, body, opts) => { calls.push({ endpoint, body, opts }); return call(endpoint, body); },
  };
  return { o: new MikroOrders({ client, writeEnabled }), calls };
}

test('previewCreateOrder: doğru gövde kurulur, götürmez (client.call çağrılmaz); gerçek 2540 siparişte İSTİSNASIZ aynı sabit alanlar', () => {
  const { o, calls } = kur();
  const p = o.previewCreateOrder(
    { customerCode: '120.10.0002', custOrderNo: 'SAS0249226', items: [{ stockCode: 'SR018.002', qty: 200, dueDateMs: new Date(2026, 11, 4).getTime() }] },
    { now: new Date(2026, 10, 18).getTime() },
  );
  assert.equal(calls.length, 0, 'önizleme hiçbir Mikro çağrısı yapmaz');
  assert.equal(p.endpoint, 'SiparisKaydetV2');
  const satir = p.body.evraklar[0].satirlar[0];
  assert.deepEqual(
    [satir.sip_stok_kod, satir.sip_musteri_kod, satir.sip_miktar, satir.sip_tip, satir.sip_cins, satir.sip_harekettipi, satir.sip_depono, satir.sip_birim_pntr, satir.sip_vergi_pntr, satir.sip_vergisiz_fl, satir.sip_doviz_cinsi],
    ['SR018.002', '120.10.0002', 200, '0', '0', '0', 1, '1', '4', false, '0'],
  );
  assert.equal(satir.sip_tarih, '2026-11-18');
  assert.equal(satir.sip_teslim_tarih, '2026-12-04');
  assert.equal(satir.sip_belgeno, 'SAS0249226');
  assert.deepEqual([satir.sip_b_fiyat, satir.sip_tutar], [0, 0], 'fiyat verilmezse 0 — gerçek bir siparişte (SR004/005.019) de 0 kabul edildiği doğrulandı');
  assert.equal(satir.evrak_aciklamalari, undefined, 'evrak_aciklamalari satırda DEĞİL, evrak düzeyinde olmalı');
  assert.equal(p.writeEnabled, false);
});

test('previewCreateOrder: docSeri/docSira/odemePlanNo verilmezse sip_evrakno_seri/sip_evrakno_sira/sip_opno HİÇ GÖNDERİLMEZ (undefined -> JSON.stringify ile düşer)', () => {
  const { o } = kur();
  const satir = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR018.002', qty: 1 }] }).body.evraklar[0].satirlar[0];
  assert.deepEqual([satir.sip_evrakno_seri, satir.sip_evrakno_sira, satir.sip_opno], [undefined, undefined, undefined]);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(satir))).some((k) => k.startsWith('sip_evrakno') || k === 'sip_opno'), false, 'gerçek telde (JSON) bu alanlar hiç yer almıyor');
});

test('previewCreateOrder: docSeri/docSira/odemePlanNo verilince GERÇEK ekranla (ofisin "Yeni" ile önerdiği sıra, müşteri kartından ödeme planı) AYNI şekilde gönderilir', () => {
  const { o } = kur();
  const satir = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR018.002', qty: 1 }], docSeri: 'SPR', docSira: 755, odemePlanNo: -90 }).body.evraklar[0].satirlar[0];
  assert.deepEqual([satir.sip_evrakno_seri, satir.sip_evrakno_sira, satir.sip_opno], ['SPR', 755, -90], 'gerçek Ayvaz siparişiyle (sip_opno=-90) birebir aynı');
});

test('previewCreateOrder: fiyat verilince sip_b_fiyat/sip_tutar hesaplanır', () => {
  const { o } = kur();
  const satir = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR070.002', qty: 200, unitPriceValue: 31.99 }] }).body.evraklar[0].satirlar[0];
  assert.deepEqual([satir.sip_b_fiyat, satir.sip_tutar], [31.99, 6398], 'gerçek SIPARISLER satırıyla (31,99 × 200 = 6398) birebir aynı');
});

test('previewCreateOrder: not verilirse evrak_aciklamalari dolar', () => {
  const { o } = kur();
  const p = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: 1 }], note: 'mail ile geldi' });
  assert.deepEqual(p.body.evraklar[0].evrak_aciklamalari, [{ aciklama: 'mail ile geldi' }]);
  const psiz = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: 1 }] });
  assert.deepEqual(psiz.body.evraklar[0].evrak_aciklamalari, []);
});

test('previewCreateOrder: doğrulama (müşteri kodu, stok kodu, miktar, fiyat, en az bir kalem)', () => {
  const { o } = kur();
  assert.throws(() => o.previewCreateOrder({ customerCode: '120.10.0002', items: [] }), (e) => e.code === 'no-items');
  assert.throws(() => o.previewCreateOrder({ customerCode: '', items: [{ stockCode: 'SR1', qty: 1 }] }), (e) => e.code === 'bad-customer-code');
  assert.throws(() => o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: '', qty: 1 }] }), (e) => e.code === 'bad-stock-code');
  assert.throws(() => o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: 0 }] }), (e) => e.code === 'bad-qty');
  assert.throws(() => o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: -5 }] }), (e) => e.code === 'bad-qty');
  assert.throws(() => o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: 1, unitPriceValue: -1 }] }), (e) => e.code === 'bad-price');
});

test('previewCreateOrder: BİRDEN ÇOK kalem TEK evrakta — evrak düzeyi alanlar (müşteri/tarih/ödeme planı/evrak sırası) HER satırda aynı, yalnız ürün/adet/fiyat/teslim tarihi satır başına değişir (2026-11-18, gerçek HAVANA/SAS0003812 siparişi — 4 kalem)', () => {
  const { o } = kur();
  const p = o.previewCreateOrder({
    customerCode: '120.10.0007', custOrderNo: 'SAS0003812', odemePlanNo: -90, docSeri: 'SPR', docSira: 1000,
    items: [
      { stockCode: 'SR001.007', qty: 1000, unitPriceValue: 68, dueDateMs: new Date(2026, 10, 6).getTime() },
      { stockCode: 'SR002.007', qty: 2000, unitPriceValue: 115.90, dueDateMs: new Date(2026, 10, 6).getTime() },
      { stockCode: 'SR003.007', qty: 500, unitPriceValue: 157.55, dueDateMs: new Date(2026, 10, 6).getTime() },
      { stockCode: 'SR009.007', qty: 1500, unitPriceValue: 142.50, dueDateMs: new Date(2026, 10, 6).getTime() },
    ],
  });
  const satirlar = p.body.evraklar[0].satirlar;
  assert.equal(satirlar.length, 4);
  assert.deepEqual(satirlar.map((s) => s.sip_stok_kod), ['SR001.007', 'SR002.007', 'SR003.007', 'SR009.007']);
  assert.deepEqual(satirlar.map((s) => s.sip_miktar), [1000, 2000, 500, 1500]);
  assert.deepEqual(satirlar.map((s) => s.sip_tutar), [68000, 231800, 78775, 213750], 'gerçek PDF\'teki tutarlarla birebir aynı');
  for (const s of satirlar) {
    assert.deepEqual(
      [s.sip_musteri_kod, s.sip_belgeno, s.sip_opno, s.sip_evrakno_seri, s.sip_evrakno_sira, s.sip_teslim_tarih],
      ['120.10.0007', 'SAS0003812', -90, 'SPR', 1000, '2026-11-06'],
      'evrak duzeyi alanlar her satirda ayni',
    );
  }
});

test('resolveCustomerForStock: en son GERÇEKTEN sipariş eden müşteri SQL\'i doğru kurar (sip_tip=0, sip_tarih DESC, TOP 1)', async () => {
  const { o, calls } = kur({ sqlQuery: async () => [{ sip_musteri_kod: '120.10.0002', ad: 'HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE TİCARET A.Ş.' }] });
  const r = await o.resolveCustomerForStock('SR018.002');
  assert.deepEqual(r, { customerCode: '120.10.0002', name: 'HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE TİCARET A.Ş.' });
  assert.match(calls[0], /sip_stok_kod = 'SR018\.002'/);
  assert.match(calls[0], /sip_tip = 0/);
  assert.match(calls[0], /ORDER BY sip_tarih DESC/);
  assert.match(calls[0], /TOP 1/);
});

test('resolveCustomerForStock: hiç sipariş geçmişi yoksa null döner (ilk kez sipariş edilen ürün)', async () => {
  const { o } = kur({ sqlQuery: async () => [] });
  assert.equal(await o.resolveCustomerForStock('SR999.999'), null);
});

test('odemePlanOf: müşteri kartındaki cari_odemeplan_no\'yu okur — gerçek veride sip_opno ile BİREBİR aynı çıktığı doğrulandı (Ayvaz -90, Berg Metal -30, Klinger 0)', async () => {
  const { o, calls } = kur({ sqlQuery: async () => [{ cari_odemeplan_no: -90 }] });
  assert.equal(await o.odemePlanOf('120.10.0002'), -90);
  assert.match(calls[0], /cari_odemeplan_no/);
  assert.match(calls[0], /cari_kod = '120\.10\.0002'/);
});

test('odemePlanOf: müşteri kartı bulunamazsa ya da alan boşsa null döner (sip_opno hiç gönderilmez)', async () => {
  assert.equal(await kur({ sqlQuery: async () => [] }).o.odemePlanOf('120.10.9999'), null);
  assert.equal(await kur({ sqlQuery: async () => [{ cari_odemeplan_no: null }] }).o.odemePlanOf('120.10.0002'), null);
});

test('nextOrderDocNo: SPR serisinin en büyük sırası + 1\'i döner — gerçek ekranda "Yeni" denince önerilen AYNI sayı (son 754 ise 755)', async () => {
  const { o, calls } = kur({ sqlQuery: async () => [{ son: 754 }] });
  assert.deepEqual(await o.nextOrderDocNo(), { seri: 'SPR', sira: 755 });
  assert.match(calls[0], /sip_evrakno_seri = 'SPR'/);
});

test('nextOrderDocNo: hiç SPR siparişi yoksa 1\'den başlar', async () => {
  const { o } = kur({ sqlQuery: async () => [{ son: null }] });
  assert.deepEqual(await o.nextOrderDocNo(), { seri: 'SPR', sira: 1 });
});

test('searchCustomers: SQL iptal/gizli müşteriyi dışlar, arama metnini LIKE ile ekler, SQL enjeksiyon karakterleri temizlenir', async () => {
  const { o, calls } = kur({ sqlQuery: async () => [{ cari_kod: '120.10.0002', cari_unvan1: 'HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE TİCARET A.Ş.' }] });
  const r = await o.searchCustomers("Ayvaz'; DROP TABLE X; --");
  assert.deepEqual(r, [{ customerCode: '120.10.0002', name: 'HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE TİCARET A.Ş.' }]);
  assert.match(calls[0], /cari_iptal = 0 AND cari_hidden = 0/);
  assert.match(calls[0], /LIKE '%Ayvaz; DROP TABLE X; --%'/, 'tek tirnak temizlenir, geri kalan metin aynen LIKE desenine girer');
});

test('send: yazma KAPALIYKEN client.call ASLA çağrılmaz, 409 mikro-write-disabled fırlar', async () => {
  const { o, calls } = kur({ writeEnabled: () => false });
  const p = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: 1 }] });
  await assert.rejects(() => o.send(p), (e) => e.status === 409 && e.code === 'mikro-write-disabled');
  assert.equal(calls.length, 0, 'yazma kapalıyken Mikro\'ya hiçbir şey gönderilmedi');
});

test('send: yazma AÇIKKEN client.call doğru endpoint + gövde + nestInMikro:true ile çağrılır, sonucu döner', async () => {
  const { o, calls } = kur({ writeEnabled: () => true, call: async () => ({ IsError: false, ok: true }) });
  const p = o.previewCreateOrder({ customerCode: '120.10.0002', items: [{ stockCode: 'SR1', qty: 1 }] });
  const r = await o.send(p);
  assert.deepEqual(r, { IsError: false, ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'SiparisKaydetV2');
  assert.deepEqual(calls[0].body, p.body);
  assert.deepEqual(calls[0].opts, { nestInMikro: true }, 'evraklar Mikro İÇİNDE gönderilmeli (diğer yazma uçlarıyla AYNI, DahiliStokHareketKaydetV2/StokKaydetV2 ile paralel)');
});

/* ---------------------------------------------------------------------------------------------------- HTTP (incoming-orders entegrasyonu) */

test('HTTP: onaylanmış taslak satırdan müşteri çözümleme + önizleme çalışır; gönderme kapalıyken 409, onaylanmamış satırda 409', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  const { Planning } = await import('./planning.js');
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => {
      if (sql.includes('CARI_HESAPLAR')) return [{ cari_odemeplan_no: -90 }];
      if (sql.includes('MAX(sip_evrakno_sira)')) return [{ son: 754 }];
      return [{ sip_musteri_kod: '120.10.0002', ad: 'HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE TİCARET A.Ş.' }];
    },
    call: async () => { throw new Error('çağrılmamalı'); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.createProduct({ stockCode: 'SR018.002', name: 'İÇ PARÇA 7/8\' BSPT', customerCode: '140100109' });
  const html = `<table><tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>SAS0249226</td><td>140100109</td><td>İÇ PARÇA</td><td>200</td></tr></table>`;
  const batch = p.incomingOrders.importEmailTable(html, { by: 'ayse' });
  const lineId = batch.lines[0].id;

  const routes = createPlanningRoutes({ planning: p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  try {
    // onaylanmamış satırda onizleme/gonderme 409 (once onaylanmali)
    const erken = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([erken.status, erken.json.code], [409, 'not-approved']);

    await j(`/api/planning/incoming-orders/lines/${lineId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    const musteri = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-customer`);
    assert.deepEqual(musteri.json.customer, { customerCode: '120.10.0002', name: 'HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE TİCARET A.Ş.' });

    const pv = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.writeEnabled, false);
    const satir = pv.json.body.evraklar[0].satirlar[0];
    assert.deepEqual(
      [satir.sip_stok_kod, satir.sip_musteri_kod, satir.sip_miktar, satir.sip_belgeno, satir.sip_opno, satir.sip_evrakno_seri, satir.sip_evrakno_sira],
      ['SR018.002', '120.10.0002', 200, 'SAS0249226', -90, 'SPR', 755],
      'musteri kodu SIPARISLER gecmisinden, odeme plani CARI_HESAPLAR kartindan, evrak sirasi MAX+1den otomatik cozuldu',
    );

    const sd = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([sd.status, sd.json.code], [409, 'mikro-write-disabled']);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

test('HTTP: onizleme govdesi istek "unitPriceValue" GONDERMEZSE (undefined) taslaktan cikarilan/duzeltilen fiyata DUSER; ACIKCA gonderilen deger onu EZER', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  const { Planning } = await import('./planning.js');
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => {
      if (sql.includes('CARI_HESAPLAR')) return [{ cari_odemeplan_no: -90 }];
      if (sql.includes('MAX(sip_evrakno_sira)')) return [{ son: 754 }];
      return [{ sip_musteri_kod: '120.10.0002', ad: 'HACI AYVAZ' }];
    },
    call: async () => { throw new Error('çağrılmamalı'); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.createProduct({ stockCode: 'SR018.002', name: 'İÇ PARÇA', customerCode: '140100109' });
  const html = `<table><tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>20.11.2026</td><td>SAS0249226</td><td>140100109</td><td>İÇ PARÇA</td><td>200</td></tr></table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  const lineId = batch.lines[0].id;
  // taslak cikarilirken e-posta tablosunun fiyat sutunu yok; "Duzenle..." ile (CLAUDE.md "her sey duzelenebilir
  // olsun") elle 157,55 girilmis gibi dusunulur.
  p.incomingOrders.updateLine(lineId, { price: 157.55 });

  const routes = createPlanningRoutes({ planning: p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, body) => { const r = await fetch(base + yol, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    await j(`/api/planning/incoming-orders/lines/${lineId}/approve`, {});

    const pv1 = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-preview`, {});
    const satir1 = pv1.json.body.evraklar[0].satirlar[0];
    assert.deepEqual([satir1.sip_b_fiyat, satir1.sip_tutar], [157.55, 31510], 'unitPriceValue gonderilmedi (body bos) -> taslagin DUZELTILMIS fiyatina duser');

    const pv2 = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-preview`, { unitPriceValue: '99.5' });
    const satir2 = pv2.json.body.evraklar[0].satirlar[0];
    assert.equal(satir2.sip_b_fiyat, 99.5, 'ACIKCA gonderilen deger taslagin fiyatini EZER');

    const pv3 = await j(`/api/planning/incoming-orders/lines/${lineId}/mikro-preview`, { unitPriceValue: null });
    const satir3 = pv3.json.body.evraklar[0].satirlar[0];
    assert.equal(satir3.sip_b_fiyat, 0, 'ACIKCA null gonderilirse (kullanici kutuyu kasitli bosalttiysa) 0 - taslagin fiyati GERI GELMEZ');
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

/* ------------------------------------------------------------------ HTTP: TASLAGIN TUMU -> TEK evrak (2026-11-19) */

test('HTTP: taslagin TUM onayli satirlari TEK evrakta (coklu kalem) onizlenir/gonderilir; hic onayli satir yoksa 400 no-lines', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  const { Planning } = await import('./planning.js');
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => {
      if (sql.includes('CARI_HESAPLAR')) return [{ cari_odemeplan_no: -90 }];
      if (sql.includes('MAX(sip_evrakno_sira)')) return [{ son: 754 }];
      return [{ sip_musteri_kod: '120.10.0007', ad: 'KONVEYÖR BEYAZ EŞYA VE OTOMOTİV SANAYİ TİCARET A.Ş.' }]; // TUM stok kodlari AYNI musteriye cikiyor
    },
    call: async () => { throw new Error('çağrılmamalı'); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.createProduct({ stockCode: 'SR046.011', name: 'PİRİNÇ SOMUN A', customerCode: '1050100073' });
  p.createProduct({ stockCode: 'SR041.011', name: 'PİRİNÇ SOMUN B', customerCode: '1050700057' });
  const html = `<table><tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>11.12.2026</td><td>4100018539</td><td>1050100073</td><td>PİRİNÇ SOMUN A</td><td>2000</td></tr>
    <tr><td>01.12.2026</td><td>4100018539</td><td>1050700057</td><td>PİRİNÇ SOMUN B</td><td>2000</td></tr></table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  const [l1, l2] = batch.lines;

  const routes = createPlanningRoutes({ planning: p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  const post = (yol, body) => j(yol, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // hic onayli satir yokken: 400 no-lines
    const erken = await post(`/api/planning/incoming-orders/${batch.id}/mikro-preview`, {});
    assert.deepEqual([erken.status, erken.json.code], [400, 'no-lines']);

    await post(`/api/planning/incoming-orders/lines/${l1.id}/approve`, {});
    await post(`/api/planning/incoming-orders/lines/${l2.id}/approve`, {});

    const musteri = await j(`/api/planning/incoming-orders/${batch.id}/mikro-customer`);
    assert.equal(musteri.json.customer.customerCode, '120.10.0007');

    const pv = await post(`/api/planning/incoming-orders/${batch.id}/mikro-preview`, {});
    assert.equal(pv.status, 200);
    assert.equal(pv.json.writeEnabled, false);
    const satirlar = pv.json.body.evraklar[0].satirlar;
    assert.equal(satirlar.length, 2, 'IKI onayli satir TEK evrakta');
    assert.deepEqual(satirlar.map((s) => s.sip_stok_kod), ['SR046.011', 'SR041.011']);
    for (const s of satirlar) {
      assert.deepEqual([s.sip_musteri_kod, s.sip_opno, s.sip_evrakno_seri, s.sip_evrakno_sira], ['120.10.0007', -90, 'SPR', 755], 'evrak duzeyi alanlar IKI satirda da ayni');
    }

    const sd = await post(`/api/planning/incoming-orders/${batch.id}/mikro-send`, {});
    assert.deepEqual([sd.status, sd.json.code], [409, 'mikro-write-disabled'], 'gonderme kapaliyken TEK siparis de reddedilir, hicbir sey gitmez');
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

test('HTTP: taslagin onayli satirlari FARKLI musterilere cikarsa (elle customerCode verilmedikce) 409 multiple-customers', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  const { Planning } = await import('./planning.js');
  let call = 0;
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => {
      if (sql.includes('CARI_HESAPLAR')) return [{ cari_odemeplan_no: 0 }];
      if (sql.includes('MAX(sip_evrakno_sira)')) return [{ son: 1 }];
      call += 1;
      return call === 1 ? [{ sip_musteri_kod: '120.10.0002', ad: 'A' }] : [{ sip_musteri_kod: '120.10.0099', ad: 'B' }];
    },
    call: async () => { throw new Error('çağrılmamalı'); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.createProduct({ stockCode: 'SR001', name: 'X', customerCode: '1' });
  p.createProduct({ stockCode: 'SR002', name: 'Y', customerCode: '2' });
  const html = `<table><tr><th>TESLİM TARİHİ</th><th>SİPARİŞ NUMARASI</th><th>MALZEME KODU</th><th>MALZEME AÇIKLAMASI</th><th>KALAN MİKTAR</th></tr>
    <tr><td>11.12.2026</td><td>A</td><td>1</td><td>X</td><td>10</td></tr>
    <tr><td>11.12.2026</td><td>A</td><td>2</td><td>Y</td><td>10</td></tr></table>`;
  const batch = p.incomingOrders.importEmailTable(html);
  const [l1, l2] = batch.lines;

  const routes = createPlanningRoutes({ planning: p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  const post = (yol, body) => j(yol, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await post(`/api/planning/incoming-orders/lines/${l1.id}/approve`, {});
    await post(`/api/planning/incoming-orders/lines/${l2.id}/approve`, {});

    const r1 = await post(`/api/planning/incoming-orders/${batch.id}/mikro-preview`, {});
    assert.deepEqual([r1.status, r1.json.code], [409, 'multiple-customers']);

    // customerCode ACIKCA verilince (kullanicinin elle sectigi) cozumleme hic denenmez, dogrudan kabul edilir
    const r2 = await post(`/api/planning/incoming-orders/${batch.id}/mikro-preview`, { customerCode: '120.10.0002' });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.body.evraklar[0].satirlar[0].sip_musteri_kod, '120.10.0002');
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
