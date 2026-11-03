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

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

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
