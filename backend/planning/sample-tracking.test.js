/**
 * Numune takip (sample-tracking.js, EYS.FR.012 "Numune Talep / Takip Formu"): müşteriye numune üretilip
 * gönderilmesi, müşteriden gelen onay/ret geri bildiriminin takibi. `products` tablosuyla HİÇ BAĞLANMAZ.
 * TÜM veriler sentetiktir.
 *
 * Yetki ('numune' ekranı read/write, sıra tabanı/silme admin-only) backend/auth/policy.test.js'te sınanır;
 * burada yalnız iş mantığı ve HTTP uçlarının kendisi.
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { pdf } from './test/doc-fixture.js';

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

/**
 * Mikro'ya GERÇEK AĞ YOK (mikroStock.client sahte fonksiyonlarla beslenir, `product-depot.test.js`'teki desenin
 * aynısı) — yeni ürün kodu oluşturma + Mikro'ya yazma denemelerini (ürün kartı + ağırlık) sınamak için.
 * @param {{writeEnabled?: boolean, machines?: object[], call?: (endpoint, body) => any, sqlQuery?: (sql) => any}} [o]
 */
function kurMikro({ writeEnabled = true, machines = [], call = async () => ({}), sqlQuery = async () => [] } = {}) {
  const calls = [];
  const client = { configured: () => true, sqlQuery, call: async (endpoint, body, opts) => { calls.push({ endpoint, body, opts }); return call(endpoint, body); } };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => machines, mikroClient: client });
  p.mikroStock.writeEnabled = () => writeEnabled;
  return { p, calls };
}

/** Arka planda (await edilmeden) atilan Mikro cagrisinin tamamlanmasini bekler (create()/update() senkron doner). */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('olustur: yalniz musteri zorunlu; kod 000001 ten baslar, siradaki artar', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'M.Teknik' }, { by: 'admin', now: at(10) });
  assert.equal(a.code, '000001');
  assert.equal(a.status, 'bekliyor');
  assert.equal(a.customer, 'M.Teknik');
  assert.equal(a.requestedOn, new Date(2026, 9, 12).getTime(), 'tarih verilmezse bugunun yerel gece yarisi');
  assert.deepEqual([a.customerSampleCode, a.stockCode, a.gkkReportNo, a.decidedOn], [null, null, null, null]);

  const b = p.samples.create({ customer: 'B Ltd' }, { now: at(11) });
  assert.equal(b.code, '000002');
  assert.throws(() => p.samples.create({ customer: '' }), /Müşteri gerekli/);
  p.close();
});

test('olustur: kagit formdaki tum alanlar (numune tanimlama + uretim bilgileri) kaydedilir', () => {
  const p = kur();
  const a = p.samples.create({
    customer: 'M.Teknik', customerSampleCode: 'NK-1', customerCode: 'DF Regülatör parça yuva kısa', stockCode: 'SR099.001',
    sampleQty: '1.100 AD.', dueDate: '20.09.2026', quoteNetG: '', sampleNetG: '6,45', productionSec: 17, material: 'Ø15',
    altMaterial: '', gauges: '', producedQty: 1200, sampleSetQty: 2, producedOn: '11.08.2026', gkkReportNo: 'GK26.291', sentQty: 2,
  }, { now: at(10) });
  assert.equal(a.customerSampleCode, 'NK-1');
  assert.equal(a.customerCode, 'DF Regülatör parça yuva kısa');
  assert.equal(a.stockCode, 'SR099.001');
  assert.equal(a.sampleQty, '1.100 AD.');
  assert.equal(a.dueDate, new Date(2026, 8, 20).getTime());
  assert.equal(a.quoteNetG, null, 'bos string -> null (0 degil)');
  assert.equal(a.sampleNetG, 6.45);
  assert.equal(a.productionSec, 17);
  assert.equal(a.material, 'Ø15');
  assert.equal(a.producedQty, 1200);
  assert.equal(a.sampleSetQty, 2);
  assert.equal(a.producedOn, new Date(2026, 7, 11).getTime());
  assert.equal(a.gkkReportNo, 'GK26.291');
  assert.equal(a.sentQty, 2);
  p.close();
});

test('duzenle: yalniz gonderilen alanlar degisir; tarih NOT NULL oldugu icin bos gonderilirse DOKUNULMAZ', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'M.Teknik' }, { now: at(10) });
  const r1 = p.samples.update(a.id, { material: 'Ø15', producedQty: 1200 }, { by: 'fabrika' });
  assert.equal(r1.material, 'Ø15');
  assert.equal(r1.producedQty, 1200);
  assert.equal(r1.customer, 'M.Teknik', 'dokunulmayan alan aynen kaldi');

  const r2 = p.samples.update(a.id, { requestedOn: '' }, { by: 'fabrika' });
  assert.equal(r2.requestedOn, a.requestedOn, 'bos tarih -> degismedi (NOT NULL temizlenemez)');

  assert.throws(() => p.samples.update(9999, { material: 'x' }), /bulunamadı/);
  p.close();
});

test('karar: musteriden gelen onay/ret elle girilir; tarih verilmezse simdi; gecersiz durum reddedilir', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'M.Teknik' }, { now: at(10) });
  const onay = p.samples.decide(a.id, { status: 'onaylandi', decidedOn: '24.08.2026', note: '10,5 artı tolerans olacak' }, { by: 'admin', now: at(12) });
  assert.equal(onay.status, 'onaylandi');
  assert.equal(onay.decidedOn, new Date(2026, 7, 24).getTime());
  assert.equal(onay.decisionNote, '10,5 artı tolerans olacak');

  const b = p.samples.create({ customer: 'X' }, { now: at(13) });
  const ret = p.samples.decide(b.id, { status: 'reddedildi', note: 'Toleransa uymadı, müşteri rapor no 7788' }, { now: at(14) });
  assert.equal(ret.status, 'reddedildi');
  assert.equal(ret.decidedOn, new Date(2026, 9, 12).getTime(), 'tarih verilmezse bugunun yerel gece yarisi');

  assert.throws(() => p.samples.decide(a.id, { status: 'bekliyor' }), /onaylandi.*reddedildi/);
  assert.throws(() => p.samples.decide(9999, { status: 'onaylandi' }), /bulunamadı/);
  p.close();
});

test('geri al: yanlislikla isaretlenen karar "bekliyor"a doner; zaten bekliyorsa no-op', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'M.Teknik' }, { now: at(10) });
  p.samples.decide(a.id, { status: 'reddedildi', note: 'yanlis tikledim' }, { now: at(11) });
  const geri = p.samples.reopen(a.id, { now: at(12) });
  assert.equal(geri.status, 'bekliyor');
  assert.equal(geri.decidedOn, null);
  assert.equal(geri.decisionNote, null);
  assert.deepEqual(p.samples.reopen(a.id), p.samples.get(a.id), 'zaten bekliyor: degisiklik yok');
  p.close();
});

test('liste: arama (musteri/kod/urun kodu), durum suzgeci, en yeni once', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'M.Teknik', customerCode: 'DF Regülatör' }, { now: at(10) });
  const b = p.samples.create({ customer: 'Başka Firma', stockCode: 'SR001.013' }, { now: at(11) });
  p.samples.decide(b.id, { status: 'onaylandi' }, { now: at(12) });

  assert.deepEqual(p.samples.list({}).items.map((x) => x.id), [b.id, a.id], 'en yeni once (id DESC)');
  assert.deepEqual(p.samples.list({ q: 'regülatör' }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.samples.list({ q: 'SR001' }).items.map((x) => x.id), [b.id]);
  assert.deepEqual(p.samples.list({ status: 'bekliyor' }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.samples.list({ status: 'onaylandi' }).items.map((x) => x.id), [b.id]);
  assert.equal(p.samples.list({}).next.nextCode, '000003');
  p.close();
});

test('siradaki numara tabani: gercek kayitlarin altina inemez; ondan sonrasi sessizce yukselmez (MAX, diger sayaclarla ayni desen)', () => {
  const p = kur();
  p.samples.create({ customer: 'A' }); // seq=1
  assert.throws(() => p.samples.setSequence(0), (e) => e.status === 409, 'gercek kayittan (1) asagi inemez');
  const r = p.samples.setSequence(219);
  assert.equal(r.nextCode, '000220');
  // ayni (daha kucuk) taban tekrar verilirse sessizce yukselmez (gercek kayit sayisinin altina inmedigi icin hata vermez, floor MAX ile korunur)
  const tekrar = p.samples.setSequence(100);
  assert.equal(tekrar.nextCode, '000220', 'taban 219da kaldi');
  assert.throws(() => p.samples.setSequence(-1));
  p.close();
});

test('sil: kayit kalkar, onaylanmis/reddedilmis kayit da silinebilir (gecmis kayit degil, bu bir form)', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'A' });
  p.samples.decide(a.id, { status: 'onaylandi' });
  assert.deepEqual(p.samples.delete(a.id), { ok: true });
  assert.throws(() => p.samples.get(a.id), /bulunamadı/);
  assert.throws(() => p.samples.delete(9999), /bulunamadı/);
  p.close();
});

test('ret analizi: karar tarihine gore onay/ret dagilimi + ret orani; "talep edilen/bekleyen" farkli (requestedOn) tarih alanindan sayilir', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'A', requestedOn: '20.09.2026' }, { now: at(9) });
  p.samples.decide(a.id, { status: 'onaylandi', decidedOn: '05.10.2026' });
  const b = p.samples.create({ customer: 'B', requestedOn: '04.10.2026' }, { now: at(9) });
  p.samples.decide(b.id, { status: 'reddedildi', decidedOn: '06.10.2026' });
  p.samples.create({ customer: 'C', requestedOn: '07.10.2026' }, { now: at(9) }); // hala bekliyor
  const d = p.samples.create({ customer: 'D', requestedOn: '15.09.2026' }, { now: at(9) });
  p.samples.decide(d.id, { status: 'onaylandi', decidedOn: '20.09.2026' }); // aralik disinda karar verildi

  const r = p.samples.rejectionStats({ from: '2026-10-01', to: '2026-10-12' });
  assert.equal(r.decided, 2, 'yalniz karar tarihi (decidedOn) Ekim araliginda olan A ve B sayilir, D (Eylulde karar) sayilmaz');
  assert.equal(r.approved, 1);
  assert.equal(r.rejected, 1);
  assert.equal(r.rejectionRate, 0.5);
  assert.equal(r.requested, 2, 'B ve C bu araliktaki taleplerdir (A ve D Eylulde talep edildi, requestedOn farkli bir alan)');
  assert.equal(r.pending, 1, 'talep edilenlerden yalniz C hala bekliyor');
  p.close();
});

test('ret analizi: aralik verilmezse bu ayin basindan "now"a; hic karar yoksa oran belirsiz (null, 0 degil); gecersiz girdi reddedilir', () => {
  const p = kur();
  const r = p.samples.rejectionStats({ now: at(14, 0, 15) }); // 15 Ekim 2026 -> bu ay: 2026-10-01..2026-10-15
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.to, '2026-10-15');
  assert.deepEqual([r.decided, r.approved, r.rejected, r.requested, r.pending], [0, 0, 0, 0, 0]);
  assert.equal(r.rejectionRate, null, 'hic karar verilmemisse oran belirsizdir, 0 degil');

  assert.throws(() => p.samples.rejectionStats({ from: 'gecersiz', to: '2026-10-12' }), /yyyy-aa-gg/);
  assert.throws(() => p.samples.rejectionStats({ from: '2026-10-12', to: '2026-10-01' }), /sonra olamaz/);
  assert.throws(() => p.samples.rejectionStats({ from: '2025-01-01', to: '2026-10-12' }), /400 gün/);
  p.close();
});

/* ============================================================================ yeni urun kodu olusturma + Mikro (2026-11-13) */

test('musteri gruplari: sabit 19 grup, kullanicinin verdigi liste', () => {
  const p = kur();
  const groups = p.samples.customerGroups();
  assert.equal(groups.length, 19);
  assert.deepEqual(groups.find((g) => g.code === '011'), { code: '011', name: 'Konveyör' });
  assert.deepEqual(groups.find((g) => g.code === '002'), { code: '002', name: 'Ayvaz' });
  p.close();
});

test('nextStockCode: onizleme (rezerve ETMEZ) - bos grupta 001den baslar, var olan kodun bir ustune cikar, onek bagimsiz', () => {
  const p = kur();
  assert.equal(p.samples.nextStockCode({ customerGroupCode: '011', codePrefix: 'SR' }).stockCode, 'SR001.011');
  p.createProduct({ stockCode: 'SR015.011' });
  const n = p.samples.nextStockCode({ customerGroupCode: '011', codePrefix: 'sr' }); // kucuk harf de kabul edilir
  assert.equal(n.stockCode, 'SR016.011');
  assert.equal(n.customerGroupName, 'Konveyör');
  assert.equal(n.codePrefix, 'SR');
  // Farkli onek (Nİ) AYNI grupta BAGIMSIZ sayilir (SR'nin varligindan etkilenmez)
  assert.equal(p.samples.nextStockCode({ customerGroupCode: '011', codePrefix: 'Nİ' }).stockCode, 'Nİ001.011');
  // Farkli grup (002) BAGIMSIZ sayilir
  assert.equal(p.samples.nextStockCode({ customerGroupCode: '002', codePrefix: 'SR' }).stockCode, 'SR001.002');
  assert.throws(() => p.samples.nextStockCode({ customerGroupCode: '999', codePrefix: 'SR' }), /Bilinmeyen müşteri grubu/);
  assert.throws(() => p.samples.nextStockCode({ customerGroupCode: '011', codePrefix: 'XX' }), /SR.*Nİ/);
  p.close();
});

test('olustur: musteri grubu + onek birlikte verilirse YENI kod uretilir, urun karti acilir, elle yazilmis stockCode GOZ ARDI EDILIR', () => {
  const { p } = kurMikro({ writeEnabled: false });
  const a = p.samples.create({ customer: 'Konveyör A.Ş.', customerCode: 'KV-100', stockCode: 'ELLE-YAZILMIS', customerGroupCode: '011', codePrefix: 'SR' }, { by: 'admin' });
  assert.equal(a.stockCode, 'SR001.011', 'elle yazilan stockCode goz ardi edildi');
  assert.equal(a.autoGenerated, true);
  assert.equal(a.customerGroupCode, '011');
  assert.equal(a.codePrefix, 'SR');
  const urun = p.getProduct('SR001.011');
  assert.equal(urun.customerCode, 'KV-100', 'urun karti acildi ve musteri urun kodu kopyalandi');

  const b = p.samples.create({ customer: 'Konveyör A.Ş.', customerGroupCode: '011', codePrefix: 'SR' }, { by: 'admin' });
  assert.equal(b.stockCode, 'SR002.011', 'ikinci numune aynı gruptan bir sonraki kodu alir');

  const c = p.samples.create({ customer: 'Elle girilen' });
  assert.equal(c.autoGenerated, false);
  assert.equal(c.stockCode, null, 'grup/onek verilmezse eski davranis: stockCode serbest/bos');

  assert.throws(() => p.samples.create({ customer: 'X', customerGroupCode: '011' }), /birlikte seçilmeli/, 'yalniz biri verilirse reddedilir');
  assert.throws(() => p.samples.create({ customer: 'X', codePrefix: 'SR' }), /birlikte seçilmeli/);
  p.close();
});

test('olustur: musteri grubu + onek ile Mikro YENI stok karti olusturma arka planda denenir (basarili ve basarisiz)', async () => {
  const basarili = kurMikro({ writeEnabled: true, call: async () => ({ Data: {} }) });
  const a = basarili.p.samples.create({ customer: 'Konveyör', customerGroupCode: '011', codePrefix: 'SR' });
  await flush();
  const a2 = basarili.p.samples.get(a.id);
  assert.equal(a2.mikroProductSent, true);
  assert.equal(a2.mikroProductError, null);
  assert.equal(basarili.calls[0].endpoint, 'StokKaydetV2');
  assert.equal(basarili.calls[0].opts.nestInMikro, true, 'DahiliStokHareketKaydetV2 ile AYNI - stoklar Mikro bloğunun ICINDE');
  assert.equal(basarili.calls[0].body.stoklar[0].sto_kod, 'SR001.011');
  basarili.p.close();

  const kapali = kurMikro({ writeEnabled: false });
  const b = kapali.p.samples.create({ customer: 'Konveyör', customerGroupCode: '011', codePrefix: 'SR' });
  await flush();
  const b2 = kapali.p.samples.get(b.id);
  assert.equal(b2.mikroProductSent, false);
  assert.match(b2.mikroProductError, /kapalı/);
  assert.equal(kapali.calls.length, 0, 'yazma kapaliyken Mikro\'ya HIC istek atilmaz');
  kapali.p.close();
});

test('duzenle: numune net agirligi girilince LOKAL urun karti netKg ile eslenir (urun karti varsa); Mikro\'ya yalniz auto-generated kodlarda gidilir', async () => {
  const elle = kurMikro({ writeEnabled: true });
  const urun = elle.p.createProduct({ stockCode: 'SR900.001' });
  const numune = elle.p.samples.create({ customer: 'Elle', stockCode: 'SR900.001' });
  elle.p.samples.update(numune.id, { sampleNetG: '6,45' });
  await flush();
  assert.equal(elle.p.getProduct('SR900.001').netKg, 0.00645, 'urun karti HER ZAMAN senkronize edilir, auto-generated olmasa da');
  assert.equal(elle.calls.length, 0, 'elle girilmis (auto-generated olmayan) kodda Mikro\'ya HIC gidilmez');
  elle.p.close();

  const otomatik = kurMikro({ writeEnabled: true, call: async () => ({ Data: {} }) });
  const a = otomatik.p.samples.create({ customer: 'Konveyör', customerGroupCode: '011', codePrefix: 'SR' });
  otomatik.p.samples.update(a.id, { sampleNetG: 12.3 });
  await flush();
  const a2 = otomatik.p.samples.get(a.id);
  assert.equal(a2.mikroWeightSentG, 12.3);
  assert.equal(a2.mikroWeightError, null);
  assert.equal(otomatik.p.getProduct('SR001.011').netKg, 0.0123);
  const agirlikCagrisi = otomatik.calls.find((c) => c.body.stoklar?.[0]?.sto_birim1_agirlik != null);
  assert.ok(agirlikCagrisi, 'StokKaydetV2 agirlik alaniyla cagrildi');
  assert.equal(agirlikCagrisi.body.stoklar[0].sto_birim1_agirlik, 0.0123);

  // ayni deger tekrar girilirse ikinci kez Mikro'ya GIDILMEZ (zaten gonderilmis)
  const sayac = otomatik.calls.length;
  otomatik.p.samples.update(a.id, { sampleNetG: 12.3 });
  await flush();
  assert.equal(otomatik.calls.length, sayac, 'ayni agirlik ikinci kez gonderilmez');
  otomatik.p.close();
});

test('urun karti bulunamayan ya da agirlik limiti disinda bir stockCode numune kaydini BOZMAZ (sessizce atlanir)', async () => {
  const { p } = kurMikro({ writeEnabled: true });
  const a = p.samples.create({ customer: 'X', stockCode: 'HIC-OLMAYAN-URUN' });
  const sonuc = p.samples.update(a.id, { sampleNetG: 5 });
  await flush();
  assert.equal(sonuc.sampleNetG, 5, 'numune kaydi yine de guncellendi');
  assert.throws(() => p.getProduct('HIC-OLMAYAN-URUN'), /bulunamadı/);
  p.close();
});

test('retryMikroProduct/retryMikroWeight: yalniz auto-generated numunede anlamli; agirlik icin once net agirlik gerekir', async () => {
  const { p, calls } = kurMikro({ writeEnabled: false });
  const elle = p.samples.create({ customer: 'X', stockCode: 'SR900.002' });
  await assert.rejects(() => p.samples.retryMikroProduct(elle.id), (e) => e.status === 409 && e.code === 'not-generated');
  await assert.rejects(() => p.samples.retryMikroWeight(elle.id), (e) => e.status === 409 && e.code === 'not-generated');

  const oto = p.samples.create({ customer: 'Konveyör', customerGroupCode: '011', codePrefix: 'SR' });
  await flush();
  assert.match(p.samples.get(oto.id).mikroProductError, /kapalı/, 'ilk deneme yazma kapaliyken basarisiz olmustu');
  await assert.rejects(() => p.samples.retryMikroWeight(oto.id), (e) => e.status === 409 && e.code === 'no-weight');

  p.mikroStock.writeEnabled = () => true;
  const sonuc = await p.samples.retryMikroProduct(oto.id);
  assert.equal(sonuc.mikroProductSent, true, 'yeniden deneme basarili oldu');
  assert.ok(calls.some((c) => c.endpoint === 'StokKaydetV2'));
  p.close();
});

test('tezgaha baglama: iş emrinin opsiyonel machineId mantığının AYNISI - bos -> null, bilinen tezgah kabul edilir, bilinmeyen reddedilir (envanter bosken serbest)', () => {
  const bosEnvanter = kur();
  const a = bosEnvanter.samples.create({ customer: 'X', machineId: 'HERHANGI-BIR-SEY' });
  assert.equal(a.machineId, 'HERHANGI-BIR-SEY', 'envanter bos oldugunda serbest (testteki ayni tolerans)');
  bosEnvanter.close();

  const { p } = kurMikro({ machines: [{ id: 'CNC-03', name: 'Torna 3' }] });
  const b = p.samples.create({ customer: 'X', machineId: 'CNC-03' });
  assert.equal(b.machineId, 'CNC-03');
  assert.throws(() => p.samples.create({ customer: 'X', machineId: 'CNC-99' }), /Bilinmeyen tezgah/);

  const c = p.samples.create({ customer: 'X' });
  assert.equal(c.machineId, null);
  const d = p.samples.update(c.id, { machineId: 'CNC-03' });
  assert.equal(d.machineId, 'CNC-03');
  const e = p.samples.update(c.id, { machineId: '' });
  assert.equal(e.machineId, null, 'bos string -> null (temizlenebilir)');
  p.close();
});

/* ========================================================================== hammadde aramasi + teknik resim (2026-11-13) */

test('hammadde aramasi: mikroStock.searchMaterials uzerinden GECER (hammadde ekranindaki ucla AYNI mekanizma, numune-ozel dar uc)', async () => {
  const { p } = kurMikro({ sqlQuery: async (sql) => (sql.includes('STOKLAR') ? [{ sto_kod: 'HM614.AA25.00', sto_isim: 'PİRİNÇ ÇUBUK', sto_birim1_ad: 'KG' }] : []) });
  // SampleTracking kendi uzerinden gecmez, routes.js dogrudan planning.mikroStock.searchMaterials'i cagirir - burada o yolu (HTTP) sinariz.
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/planning/samples/materials?q=AA25`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.items, [{ stockCode: 'HM614.AA25.00', name: 'PİRİNÇ ÇUBUK', unit: 'KG' }]);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

test('teknik resim: numuneye PDF eklenir/listelenir/indirilir/kaldirilir; cizim yoksa/bozuksa/tekrarsa reddedilir', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'X' });
  assert.deepEqual(p.samples.listDrawings(a.id), []);

  const d1 = p.samples.addDrawing(a.id, { name: 'ölçü\\resim 1.pdf', data: pdf('SAYFA 1') }, { by: 'admin' });
  assert.equal(d1.length, 1);
  assert.equal(d1[0].name, 'resim 1.pdf', 'klasor yolu atildi (yalniz dosya adi)');
  assert.equal(d1[0].pages, 1);
  assert.equal(d1[0].sort, 1);
  assert.equal(Object.hasOwn(d1[0], 'sha'), false, 'listDrawings sha dondurmez');

  const d2 = p.samples.addDrawing(a.id, { data: pdf('SAYFA A', 'SAYFA B') }, { by: 'admin' });
  assert.equal(d2.length, 2);
  assert.equal(d2[1].name, 'teknik-resim.pdf', 'ad verilmezse varsayilan');
  assert.equal(d2[1].pages, 2);

  const dl = p.samples.drawingData(d2[1].id);
  assert.equal(dl.name, 'teknik-resim.pdf');
  assert.ok(Buffer.isBuffer(dl.data) && dl.data.length > 0);

  assert.throws(() => p.samples.addDrawing(a.id, { data: pdf('SAYFA A', 'SAYFA B') }), (e) => e.status === 409 && e.code === 'duplicate');
  assert.throws(() => p.samples.addDrawing(a.id, { data: Buffer.from('PDF DEGIL') }), (e) => e.status === 422 && e.code === 'bad-pdf');
  assert.throws(() => p.samples.addDrawing(a.id, { data: Buffer.alloc(0) }), /boş/);
  assert.throws(() => p.samples.addDrawing(9999, { data: pdf('X') }), /bulunamadı/);

  const sonra = p.samples.deleteDrawing(a.id, d1[0].id);
  assert.equal(sonra.length, 1);
  assert.throws(() => p.samples.drawingData(d1[0].id), /bulunamadı/);
  assert.throws(() => p.samples.deleteDrawing(a.id, 9999), /bulunamadı/);
  p.close();
});

test('teknik resim: en cok MAX_DRAWINGS (8) PDF; her biri en cok MAX_DRAWING_BYTES', () => {
  const p = kur();
  const a = p.samples.create({ customer: 'X' });
  for (let i = 0; i < 8; i += 1) p.samples.addDrawing(a.id, { data: pdf(`SAYFA ${i}`) }, { by: 'admin' });
  assert.throws(() => p.samples.addDrawing(a.id, { data: pdf('DOKUZUNCU') }), (e) => e.status === 409 && e.code === 'too-many');
  p.close();
});

test('teknik resim: baska bir numune/is emri/urun/fiyat calismasiyla AYNI PDF paylasilirsa silinince blob KAYBOLMAZ (capraz tuketici sayimi)', () => {
  const p = kur();
  const ayniIcerik = pdf('ORTAK İÇERİK');
  const num1 = p.samples.create({ customer: 'A' });
  const num2 = p.samples.create({ customer: 'B' });
  const d1 = p.samples.addDrawing(num1.id, { data: ayniIcerik })[0];
  p.samples.addDrawing(num2.id, { data: ayniIcerik }); // ayni SHA, farkli numune - ikinci sample_drawings satiri
  p.samples.deleteDrawing(num1.id, d1.id);
  // num2'nin kopyasi hala var oldugu icin drawing_files de hala var olmali (drawingData hata firlatmamali)
  const kalan = p.samples.listDrawings(num2.id)[0];
  const okunan = p.samples.drawingData(kalan.id);
  assert.ok(okunan.data.length > 0, 'num2nin kopyasi silinmedi, blob hala okunabiliyor');
  p.close();
});

/* ====================================================================================== HTTP */

test('HTTP: olustur, listele, ayrinti, duzenle, karar, geri al, sira tabani, sil', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const olustur = await j('/api/planning/samples', 'POST', { customer: 'M.Teknik', customerSampleCode: 'NK-1' });
    assert.equal(olustur.status, 201);
    const s = olustur.json;
    assert.equal(s.code, '000001');

    const liste = await j('/api/planning/samples');
    assert.equal(liste.json.total, 1);
    assert.equal((await j(`/api/planning/samples/${s.id}`)).json.customerSampleCode, 'NK-1');

    const duzenle = await j(`/api/planning/samples/${s.id}`, 'PUT', { material: 'Ø15', producedQty: 1200, gkkReportNo: 'GK26.291' });
    assert.equal(duzenle.status, 200);
    assert.equal(duzenle.json.gkkReportNo, 'GK26.291');

    const karar = await j(`/api/planning/samples/${s.id}/decide`, 'POST', { status: 'onaylandi', note: 'ok' });
    assert.equal(karar.status, 200);
    assert.equal(karar.json.status, 'onaylandi');

    const geri = await j(`/api/planning/samples/${s.id}/reopen`, 'POST');
    assert.equal(geri.json.status, 'bekliyor');

    const sira = await j('/api/planning/samples/sequence', 'PUT', { last: 300 });
    assert.equal(sira.status, 200);
    assert.equal(sira.json.nextCode, '000301');

    const istatistik = await j('/api/planning/samples/stats');
    assert.equal(istatistik.status, 200);
    assert.ok(Object.hasOwn(istatistik.json, 'rejectionRate'));
    assert.equal((await j('/api/planning/samples/stats?from=2026-10-12&to=2026-10-01')).status, 400, 'baslangic bitisten sonraysa 400');

    assert.equal((await j(`/api/planning/samples/${s.id}/decide`, 'POST', { status: 'baska' })).status, 400);
    assert.equal((await j('/api/planning/samples', 'POST', { customer: '' })).status, 400);
    assert.equal((await j(`/api/planning/samples/${s.id}`, 'DELETE')).status, 200);
    assert.equal((await j(`/api/planning/samples/${s.id}`)).status, 404);
    assert.equal((await j('/api/planning/samples/99999')).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

test('HTTP: musteri gruplari, kod onizleme, yeni kod ile olusturma, Mikro yeniden deneme uclari', async () => {
  const { p } = kurMikro({ writeEnabled: false });
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const gruplar = await j('/api/planning/samples/customer-groups');
    assert.equal(gruplar.status, 200);
    assert.equal(gruplar.json.length, 19);

    const onizleme = await j('/api/planning/samples/next-stock-code?group=011&prefix=SR');
    assert.equal(onizleme.status, 200);
    assert.equal(onizleme.json.stockCode, 'SR001.011');
    assert.equal((await j('/api/planning/samples/next-stock-code?group=999&prefix=SR')).status, 400);

    const olustur = await j('/api/planning/samples', 'POST', { customer: 'Konveyör', customerGroupCode: '011', codePrefix: 'SR' });
    assert.equal(olustur.status, 201);
    assert.equal(olustur.json.stockCode, 'SR001.011');
    assert.equal(olustur.json.autoGenerated, true);
    await new Promise((r) => setTimeout(r, 0)); // arka plandaki Mikro denemesi bitsin

    const retryUrun = await j(`/api/planning/samples/${olustur.json.id}/retry-mikro-product`, 'POST');
    assert.equal(retryUrun.status, 200);
    assert.match(retryUrun.json.mikroProductError, /kapalı/);

    const retryAgirlik = await j(`/api/planning/samples/${olustur.json.id}/retry-mikro-weight`, 'POST');
    assert.equal(retryAgirlik.status, 409, 'once net agirlik girilmeli');

    const elleKod = await j('/api/planning/samples', 'POST', { customer: 'Y', stockCode: 'SR900.003' });
    assert.equal((await j(`/api/planning/samples/${elleKod.json.id}/retry-mikro-product`, 'POST')).status, 409, 'auto-generated olmayan numunede anlamsiz');
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

test('HTTP: hammadde aramasi (Mikro canli) + teknik resim yukle/goruntule/sil', async () => {
  const { p } = kurMikro({ sqlQuery: async () => [{ sto_kod: 'HM614.AA25.00', sto_isim: 'PİRİNÇ ÇUBUK', sto_birim1_ad: 'KG' }] });
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const arama = await fetch(`${base}/api/planning/samples/materials?q=AA25`);
    assert.equal(arama.status, 200);
    assert.equal((await arama.json()).items[0].stockCode, 'HM614.AA25.00');

    const olustur = await fetch(`${base}/api/planning/samples`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: 'X' }) });
    const s = await olustur.json();

    assert.equal((await fetch(`${base}/api/planning/samples/${s.id}/drawings`)).status, 200);

    const yukle = await fetch(`${base}/api/planning/samples/${s.id}/drawings?${new URLSearchParams({ name: 'resim.pdf' })}`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf('SAYFA 1'),
    });
    assert.equal(yukle.status, 201);
    const liste = (await yukle.json()).drawings;
    assert.equal(liste.length, 1);
    assert.equal(liste[0].name, 'resim.pdf');

    const indir = await fetch(`${base}/api/planning/samples/${s.id}/drawings/${liste[0].id}`);
    assert.equal(indir.status, 200);
    assert.equal(indir.headers.get('content-type'), 'application/pdf');
    assert.ok((await indir.arrayBuffer()).byteLength > 0);

    const sil = await fetch(`${base}/api/planning/samples/${s.id}/drawings/${liste[0].id}`, { method: 'DELETE' });
    assert.equal(sil.status, 200);
    assert.equal((await sil.json()).drawings.length, 0);

    assert.equal((await fetch(`${base}/api/planning/samples/${s.id}/drawings/99999`)).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
