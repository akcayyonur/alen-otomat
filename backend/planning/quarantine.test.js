/**
 * Hurda girişi (quarantine.js): Karantina Alanı Giriş-Çıkış Formu (EYS.FR.043) + Tashih Sonrası Tekrar Kontrol
 * Formu (EYS.FR.049). `products` tablosuyla HİÇ BAĞLANMAZ. TÜM veriler sentetiktir.
 *
 * Yetki ('hurda' ekranı read/write, silme admin-only) backend/auth/policy.test.js'te sınanır; burada yalnız
 * iş mantığı ve HTTP uçlarının kendisi.
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

test('olustur: urun tanimi + uygunsuzluk tanimi + giris yapan zorunlu; kod H000001 ten baslar, durum acik', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: '140100297', cardNo: '0033885', issue: 'Kaplama ve dış problemi', enteredBy: 'Aslı' }, { by: 'fabrika', now: at(10) });
  assert.equal(a.code, 'H000001');
  assert.equal(a.status, 'acik');
  assert.equal(a.productLabel, '140100297');
  assert.equal(a.cardNo, '0033885');
  assert.equal(a.issue, 'Kaplama ve dış problemi');
  assert.equal(a.enteredBy, 'Aslı');
  assert.equal(a.enteredOn, new Date(2026, 9, 12).getTime(), 'tarih verilmezse bugunun yerel gece yarisi');
  assert.deepEqual([a.exitReason, a.exitedOn, a.exitedBy], [null, null, null]);
  assert.deepEqual(a.corrections, []);
  assert.deepEqual(a.totals, { qty: 0, okQty: 0, scrapQty: 0, manHours: 0 });

  const b = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z' }, { now: at(11) });
  assert.equal(b.code, 'H000002');
  assert.throws(() => p.quarantine.create({ productLabel: '', issue: 'y', enteredBy: 'z' }), /Ürün tanımı gerekli/);
  assert.throws(() => p.quarantine.create({ productLabel: 'x', issue: '', enteredBy: 'z' }), /Uygunsuzluk tanımı gerekli/);
  assert.throws(() => p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: '' }), /Giriş yapan personelin adı gerekli/);
  p.close();
});

test('duzenle: yalniz gonderilen alanlar degisir; tarih NOT NULL oldugu icin bos gonderilirse DOKUNULMAZ; durum BURADAN degismez', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: '140100297', issue: 'Ağırda iç var', enteredBy: 'Aslı' }, { now: at(10) });
  const r1 = p.quarantine.update(a.id, { cardNo: '005669', issue: 'Düzeltildi: ağırda iç var' }, { by: 'fabrika' });
  assert.equal(r1.cardNo, '005669');
  assert.equal(r1.issue, 'Düzeltildi: ağırda iç var');
  assert.equal(r1.productLabel, '140100297', 'dokunulmayan alan aynen kaldi');

  const r2 = p.quarantine.update(a.id, { enteredOn: '' }, { by: 'fabrika' });
  assert.equal(r2.enteredOn, a.enteredOn, 'bos tarih -> degismedi (NOT NULL temizlenemez)');
  assert.equal(r2.status, 'acik', 'update durumu degistirmez');

  assert.throws(() => p.quarantine.update(9999, { issue: 'x' }), /bulunamadı/);
  p.close();
});

test('tashih (EYS.FR.049): yalniz acik kayitta eklenir, urun kodu tekrar istenmez, toplamlar dogru', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: '140100185', issue: 'Boyut dışı', enteredBy: 'Emre' }, { now: at(10) });
  const r1 = p.quarantine.addCorrection(a.id, {
    doneOn: '13.10.2026', operator: 'Mehmet', description: 'Tornada ek pas verildi', qty: 10, okQty: 8, scrapQty: 2, manHours: '1,5', note: 'ilk deneme',
  }, { by: 'fabrika', now: at(11) });
  assert.equal(r1.corrections.length, 1);
  const c = r1.corrections[0];
  assert.equal(c.operator, 'Mehmet');
  assert.equal(c.description, 'Tornada ek pas verildi');
  assert.equal(c.qty, 10);
  assert.equal(c.okQty, 8);
  assert.equal(c.scrapQty, 2);
  assert.equal(c.manHours, 1.5);
  assert.equal(c.doneOn, new Date(2026, 9, 13).getTime());

  const r2 = p.quarantine.addCorrection(a.id, { operator: 'Ali', description: 'ikinci deneme', qty: 2 }, { now: at(12) });
  assert.equal(r2.corrections.length, 2);
  assert.deepEqual(r2.totals, { qty: 12, okQty: 8, scrapQty: 2, manHours: 1.5 });

  assert.throws(() => p.quarantine.addCorrection(a.id, { operator: 'x', description: 'y', qty: 0 }), /Tashih edilen adet/, 'qty>0 zorunlu');
  assert.throws(() => p.quarantine.addCorrection(a.id, { operator: '', description: 'y', qty: 1 }), /operatörün adı gerekli/);
  assert.throws(() => p.quarantine.addCorrection(a.id, { operator: 'x', description: '', qty: 1 }), /tashihin tanımı gerekli/);

  p.quarantine.exit(a.id, { exitReason: 'Hurda', exitedBy: 'Emre' });
  assert.throws(() => p.quarantine.addCorrection(a.id, { operator: 'x', description: 'y', qty: 1 }), (e) => e.status === 409 && /Girişi geri al/.test(e.message));
  p.close();
});

test('tashih sil: yalniz admin aksiyonu, kalan kayit dondurur', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z' }, { now: at(10) });
  p.quarantine.addCorrection(a.id, { operator: 'Ali', description: 'a', qty: 1 }, { now: at(11) });
  const r = p.quarantine.addCorrection(a.id, { operator: 'Veli', description: 'b', qty: 2 }, { now: at(12) });
  const afterDel = p.quarantine.deleteCorrection(r.corrections[0].id);
  assert.equal(afterDel.corrections.length, 1);
  assert.equal(afterDel.corrections[0].operator, 'Veli');
  assert.throws(() => p.quarantine.deleteCorrection(9999), /bulunamadı/);
  p.close();
});

test('cikis yap: yalniz acik kayitta; alanlar zorunlu; durum kapali olur', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'Aslı' }, { now: at(10) });
  assert.throws(() => p.quarantine.exit(a.id, { exitReason: '', exitedBy: 'z' }), /Çıkış nedeni gerekli/);
  assert.throws(() => p.quarantine.exit(a.id, { exitReason: 'Hurda', exitedBy: '' }), /yapan personelin adı gerekli/);
  const r = p.quarantine.exit(a.id, { exitReason: 'Hurdaya gönderildi', exitedOn: '14.10.2026', exitedBy: 'Emre' }, { now: at(12) });
  assert.equal(r.status, 'kapali');
  assert.equal(r.exitReason, 'Hurdaya gönderildi');
  assert.equal(r.exitedOn, new Date(2026, 9, 14).getTime());
  assert.equal(r.exitedBy, 'Emre');

  assert.throws(() => p.quarantine.exit(a.id, { exitReason: 'tekrar', exitedBy: 'x' }), (e) => e.status === 409, 'zaten kapali');
  p.close();
});

test('girisi geri al: kapali -> acik doner, cikis alanlari temizlenir; zaten acikken no-op', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z' }, { now: at(10) });
  p.quarantine.exit(a.id, { exitReason: 'Hurda', exitedBy: 'Emre' }, { now: at(11) });
  const geri = p.quarantine.reopen(a.id, { now: at(12) });
  assert.equal(geri.status, 'acik');
  assert.deepEqual([geri.exitReason, geri.exitedOn, geri.exitedBy], [null, null, null]);
  assert.deepEqual(p.quarantine.reopen(a.id), p.quarantine.get(a.id), 'zaten acik: degisiklik yok');
  p.close();
});

test('liste: arama (urun tanimi/form no/uygunsuzluk), durum suzgeci, en yeni once, tashih sayisi', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: '140100297', cardNo: '0033885', issue: 'Kaplama problemi', enteredBy: 'Aslı' }, { now: at(10), by: 'fabrika' });
  const b = p.quarantine.create({ productLabel: '140100185', issue: 'Boyut dışı', enteredBy: 'Emre' }, { now: at(11) });
  p.quarantine.addCorrection(b.id, { operator: 'Ali', description: 'a', qty: 1 }, { now: at(12) });
  p.quarantine.exit(b.id, { exitReason: 'Hurda', exitedBy: 'Emre' }, { now: at(13) });

  assert.deepEqual(p.quarantine.list({}).items.map((x) => x.id), [b.id, a.id], 'en yeni once (id DESC)');
  assert.deepEqual(p.quarantine.list({ q: '0033885' }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.quarantine.list({ q: 'boyut' }).items.map((x) => x.id), [b.id]);
  assert.deepEqual(p.quarantine.list({ status: 'acik' }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.quarantine.list({ status: 'kapali' }).items.map((x) => x.id), [b.id]);
  assert.equal(p.quarantine.list({}).items.find((x) => x.id === b.id).correctionCount, 1);
  assert.equal(p.quarantine.list({}).items.find((x) => x.id === a.id).correctionCount, 0);
  p.close();
});

test('EYS.LS.018 alanlari (musteri, kodlar, tespit yeri, islem, miktarlar, maliyet, not): olustur+duzenle, aramaya girer, entry-duzeyi hurda miktari tashih toplamindan AYRI', () => {
  const p = kur();
  const a = p.quarantine.create({
    productLabel: '140100173', issue: 'İç çap 15(±0,2) ölçüsü limit dışı geldi.', enteredBy: 'Aslı',
    customer: 'BERG METAL', customerCode: '140100173', stockCode: 'SR012.013', detectedAt: 'MÜŞTERİ',
    action: 'Sorunlu ölçülerin olduğu ürünlerin tespiti için ölçüm yapılması', batchQty: 2597, scrapQty: 186, qualityCostTl: '12.500,50', note: 'yardımcı not',
  }, { now: at(10) });
  assert.equal(a.customer, 'BERG METAL');
  assert.equal(a.customerCode, '140100173');
  assert.equal(a.stockCode, 'SR012.013');
  assert.equal(a.detectedAt, 'MÜŞTERİ');
  assert.equal(a.action, 'Sorunlu ölçülerin olduğu ürünlerin tespiti için ölçüm yapılması');
  assert.equal(a.batchQty, 2597);
  assert.equal(a.scrapQty, 186, 'girişte bilinen hurda miktari (tashih toplanmadan da dolu olabilir)');
  assert.equal(a.qualityCostTl, 12500.5);
  assert.equal(a.note, 'yardımcı not');
  assert.deepEqual(a.totals, { qty: 0, okQty: 0, scrapQty: 0, manHours: 0 }, 'hic tashih denemesi olmasa da entry duzeyi hurda miktari ayri tutulur');

  // gercek listede yazim hatali tespit yeri varyantlari da goruluyor (URETTIM, URTIM): serbest metin, enum DEGIL
  const b = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z', detectedAt: 'ÜRETTİM' }, { now: at(11) });
  assert.equal(b.detectedAt, 'ÜRETTİM');

  const r = p.quarantine.update(a.id, { customer: 'AYVAZ', qualityCostTl: '' }, { by: 'fabrika' });
  assert.equal(r.customer, 'AYVAZ');
  assert.equal(r.qualityCostTl, null, 'bos gonderilince temizlenir (opsiyonel alan, NOT NULL degil)');
  assert.equal(r.stockCode, 'SR012.013', 'dokunulmayan alan aynen kaldi');

  assert.throws(() => p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z', batchQty: -1 }), /Parti miktarı/);
  assert.throws(() => p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z', qualityCostTl: 'abc' }), /Kalitesizlik maliyeti/);

  // regresyon (2026-11-06, review ile bulundu): nokta HER ZAMAN binlik ayracidir, virgulsuz da olsa ("12.500" = on iki bin
  // bes yuz, EYS.LS.018'den kopyalanan tipik bir tutar) - eskiden virgul yoksa nokta ondalik sayilip 1000 kat kucuk ciktidi.
  const c2 = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z', qualityCostTl: '12.500' }, { now: at(12) });
  assert.equal(c2.qualityCostTl, 12500, 'virgulsuz nokta binlik ayraci sayilmali, ondalik DEGIL');

  assert.deepEqual(p.quarantine.list({ q: 'ayvaz' }).items.map((x) => x.id), [a.id], 'musteri adiyla da aranabilir');
  assert.deepEqual(p.quarantine.list({ q: 'SR012.013' }).items.map((x) => x.id), [a.id], 'alen urun koduyla da aranabilir');
  p.close();
});

test('gecis: EYS.LS.018 alanlari olmayan eski veritabani acilinca eklenir, eski kayit okunabilir kalir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planlama-hurda-'));
  const dbFile = join(dir, 'planlama.db');
  try {
    const p1 = new Planning({ dbFile });
    const eski = p1.quarantine.create({ productLabel: '140100297', issue: 'Kaplama problemi', enteredBy: 'Aslı' }, { now: at(10) });
    p1.close();
    const raw = new DatabaseSync(dbFile);
    for (const c of ['customer', 'customer_code', 'stock_code', 'detected_at', 'action', 'batch_qty', 'scrap_qty', 'quality_cost_tl', 'note']) {
      raw.exec(`ALTER TABLE quarantine_entries DROP COLUMN ${c}`);
    }
    raw.close();

    const p2 = new Planning({ dbFile });
    const geri = p2.quarantine.get(eski.id);
    assert.equal(geri.productLabel, '140100297', 'eski kayit aynen okunabiliyor');
    assert.deepEqual([geri.customer, geri.customerCode, geri.stockCode, geri.detectedAt, geri.action, geri.batchQty, geri.scrapQty, geri.qualityCostTl, geri.note],
      [null, null, null, null, null, null, null, null, null], 'eski kayitta yeni alanlar bos');
    const yeni = p2.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z', customer: 'TEST A.Ş.' }, { now: at(11) });
    assert.equal(yeni.customer, 'TEST A.Ş.');
    p2.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows dosyayı kısa süre tutabilir; geçici dizin */ }
  }
});

test('sil: kayit ve tashih gecmisi birlikte kalkar', () => {
  const p = kur();
  const a = p.quarantine.create({ productLabel: 'x', issue: 'y', enteredBy: 'z' });
  p.quarantine.addCorrection(a.id, { operator: 'Ali', description: 'a', qty: 1 });
  assert.deepEqual(p.quarantine.delete(a.id), { ok: true });
  assert.throws(() => p.quarantine.get(a.id), /bulunamadı/);
  assert.throws(() => p.quarantine.delete(9999), /bulunamadı/);
  p.close();
});

/* ====================================================================================== HTTP */

test('HTTP: olustur, listele, ayrinti, duzenle, tashih ekle/sil, cikis yap, geri al, sil', async () => {
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
    const olustur = await j('/api/planning/quarantine', 'POST', { productLabel: '140100297', cardNo: '0033885', issue: 'Kaplama problemi', enteredBy: 'Aslı' });
    assert.equal(olustur.status, 201);
    const q = olustur.json;
    assert.equal(q.code, 'H000001');

    const liste = await j('/api/planning/quarantine');
    assert.equal(liste.json.total, 1);
    assert.equal((await j(`/api/planning/quarantine/${q.id}`)).json.issue, 'Kaplama problemi');

    const duzenle = await j(`/api/planning/quarantine/${q.id}`, 'PUT', { cardNo: '005669' });
    assert.equal(duzenle.status, 200);
    assert.equal(duzenle.json.cardNo, '005669');

    const tashih = await j(`/api/planning/quarantine/${q.id}/corrections`, 'POST', { operator: 'Mehmet', description: 'ek pas', qty: 5, okQty: 4, scrapQty: 1 });
    assert.equal(tashih.status, 200);
    assert.equal(tashih.json.corrections.length, 1);
    const corrId = tashih.json.corrections[0].id;

    const cikis = await j(`/api/planning/quarantine/${q.id}/exit`, 'POST', { exitReason: 'Hurdaya gönderildi', exitedBy: 'Emre' });
    assert.equal(cikis.status, 200);
    assert.equal(cikis.json.status, 'kapali');

    assert.equal((await j(`/api/planning/quarantine/${q.id}/corrections`, 'POST', { operator: 'x', description: 'y', qty: 1 })).status, 409);

    const geri = await j(`/api/planning/quarantine/${q.id}/reopen`, 'POST');
    assert.equal(geri.json.status, 'acik');

    const silCorr = await j(`/api/planning/quarantine/corrections/${corrId}`, 'DELETE');
    assert.equal(silCorr.status, 200);
    assert.equal(silCorr.json.corrections.length, 0);

    assert.equal((await j('/api/planning/quarantine', 'POST', { productLabel: '', issue: 'y', enteredBy: 'z' })).status, 400);
    assert.equal((await j(`/api/planning/quarantine/${q.id}`, 'DELETE')).status, 200);
    assert.equal((await j(`/api/planning/quarantine/${q.id}`)).status, 404);
    assert.equal((await j('/api/planning/quarantine/99999')).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
