/**
 * Hammadde karantinası (material-quarantine.js): tedarikçi yanlış hammadde gönderince Merkez(1)->Karantina(5)
 * sevk fişi, "İade"de Karantina'dan sarf (virman, ÇIKAN) ile düşme. GERÇEK AĞ YOK (mikroStock.client sahte
 * fonksiyonlarla beslenir, quarantine-depot.test.js'teki desenin aynısı).
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { MERKEZ_DEPO_NO } from './product-depot.js';
import { KARANTINA_DEPO_NO } from './quarantine-depot.js';
import { createPlanningRoutes } from './routes.js';

const NOW = new Date(2026, 10, 10, 10).getTime();

function kur({ writeEnabled = true, call = async () => ({ Data: { list: [{ guid: 'g1', evrakno_seri: 'CNCT', evrakno_sira: '7' }] } }) } = {}) {
  const calls = [];
  const client = {
    configured: () => true,
    sqlQuery: async () => [],
    call: async (endpoint, body, opts) => { calls.push({ endpoint, body, opts }); return call(endpoint, body); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.mikroStock.writeEnabled = () => writeEnabled;
  return { p, calls };
}

test('transferIn: kayit olusturur ve Merkez(1)->Karantina(5) sevk fisini DOGRU govde ile gonderir', async () => {
  const { p, calls } = kur();
  const r = await p.materialQuarantine.transferIn({ stockCode: 'HM614.AA24.00', stockName: 'Pirinç çubuk', kg: '1.500', note: 'Tedarikçi X, yanlış alaşım' }, { now: NOW, by: 'ayse' });
  assert.equal(calls.length, 1);
  const satir = calls[0].body.evraklar[0].satirlar[0];
  assert.deepEqual(
    [satir.sth_stok_kod, satir.sth_miktar, satir.sth_cikis_depo_no, satir.sth_giris_depo_no, satir.sth_evraktip, satir.sth_tip, satir.sth_cins],
    ['HM614.AA24.00', 1500, MERKEZ_DEPO_NO, KARANTINA_DEPO_NO, 2, 2, 6],
    'virgulsuz nokta binlik ayraci sayilmali (1500 kg, 1,5 DEGIL); sevk fisi = depo transfer',
  );
  assert.equal(r.status, 'karantinada');
  assert.equal(r.stockName, 'Pirinç çubuk');
  assert.equal(r.kg, 1500);
  assert.deepEqual([r.transfer.status, r.transfer.evrakSeri, r.transfer.evrakSira], ['basarili', 'CNCT', '7']);
  assert.equal(r.return, null, 'hic iade denenmedi');
});

test('transferIn: Mikro cagrisi basarisiz olursa kayit yine de olusur ("aktarilamadi"), hata firlatir', async () => {
  const { p } = kur({ call: async () => { throw new Error('MikroAPI\'ye ulaşılamadı'); } });
  await assert.rejects(() => p.materialQuarantine.transferIn({ stockCode: 'HM614.AA24.00', kg: 10 }, { now: NOW }), /ulaşılamadı/);
  const list = p.materialQuarantine.list({});
  assert.equal(list.length, 1, 'basarisiz deneme de kayit birakir');
  assert.deepEqual([list[0].status, list[0].transfer.status, list[0].transfer.error], ['aktarilamadi', 'basarisiz', 'MikroAPI\'ye ulaşılamadı']);
});

test('retryTransfer: basarisiz kaydi yeniden dener; zaten basarili olani reddeder', async () => {
  let fail = true;
  const { p, calls } = kur({ call: async () => { if (fail) { fail = false; throw new Error('ağ hatası'); } return { Data: { list: [{ evrakno_seri: 'CNCT', evrakno_sira: '9' }] } }; } });
  await assert.rejects(() => p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 5 }, { now: NOW }));
  const id = p.materialQuarantine.list({})[0].id;
  const r = await p.materialQuarantine.retryTransfer(id, { now: NOW });
  assert.equal(r.status, 'karantinada');
  assert.equal(calls.length, 2, 'iki deneme de Mikro\'ya gitti');

  await assert.rejects(() => p.materialQuarantine.retryTransfer(id, { now: NOW }), (e) => e.status === 409 && e.code === 'already-transferred');
});

test('kapı: MIKRO_WRITE_ENABLED kapalıyken transferIn hiçbir Mikro isteği atmadan 409 verir, kayıt yine de oluşur', async () => {
  const { p, calls } = kur({ writeEnabled: false });
  await assert.rejects(() => p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 5 }, { now: NOW }), (e) => e.status === 409 && e.code === 'mikro-write-disabled');
  assert.equal(calls.length, 0, 'kapı kapalıyken Mikro\'ya hiç gidilmez');
  assert.equal(p.materialQuarantine.list({})[0].transfer.error, 'Mikro yazma şu an kapalı (yönetici ile birlikte doğrulanıp MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez).');
});

test('returnToSupplier: karantinadaki kaydı AYNI kg ile sarf (virman, ÇIKAN) fişiyle düşer; durum "iade-edildi" olur', async () => {
  const { p, calls } = kur();
  const created = await p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 25 }, { now: NOW });
  const r = await p.materialQuarantine.returnToSupplier(created.id, { now: NOW, by: 'ayse' });
  assert.equal(calls.length, 2);
  const satir = calls[1].body.evraklar[0].satirlar[0];
  assert.deepEqual(
    [satir.sth_stok_kod, satir.sth_miktar, satir.sth_cikis_depo_no, satir.sth_giris_depo_no, satir.sth_evraktip, satir.sth_tip, satir.sth_cins],
    ['HM1', 25, KARANTINA_DEPO_NO, KARANTINA_DEPO_NO, 6, 1, 3],
    'sarf (virman) fisi, cikan yon, Karantina icinde',
  );
  assert.equal(r.status, 'iade-edildi');
  assert.deepEqual([r.return.status, r.return.evrakSeri, r.return.evrakSira], ['basarili', 'CNCT', '7']);
});

test('returnToSupplier: henüz Karantinaya aktarılmamış (ya da zaten iade edilmiş) kayıt reddedilir', async () => {
  const { p } = kur({ call: async () => { throw new Error('x'); } });
  await assert.rejects(() => p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 5 }, { now: NOW }));
  const id = p.materialQuarantine.list({})[0].id;
  await assert.rejects(() => p.materialQuarantine.returnToSupplier(id, { now: NOW }), (e) => e.status === 409 && e.code === 'bad-status');
});

test('returnToSupplier: Mikro çağrısı başarısız olursa kayıt "karantinada" kalır (iade edilmiş SAYILMAZ), "Yeniden dene" mümkün', async () => {
  let fail = false;
  const { p } = kur({ call: async () => { if (fail) throw new Error('bağlantı koptu'); return { Data: { list: [{ evrakno_seri: 'CNCT', evrakno_sira: '1' }] } }; } });
  const created = await p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 5 }, { now: NOW });
  fail = true;
  await assert.rejects(() => p.materialQuarantine.returnToSupplier(created.id, { now: NOW }), /bağlantı koptu/);
  const r = p.materialQuarantine.get(created.id);
  assert.equal(r.status, 'karantinada', 'basarisiz iade durumu geri almaz');
  assert.deepEqual([r.return.status, r.return.error], ['basarisiz', 'bağlantı koptu']);
  fail = false;
  const r2 = await p.materialQuarantine.returnToSupplier(created.id, { now: NOW });
  assert.equal(r2.status, 'iade-edildi', 'yeniden deneme basarili olabilir');
});

test('delete: Karantinada GERÇEKTEN duran kayıt silinemez (önce İade); başarısız/iade edilmiş kayıt silinebilir', async () => {
  const { p } = kur();
  const karantinada = await p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 5 }, { now: NOW });
  assert.throws(() => p.materialQuarantine.delete(karantinada.id), (e) => e.status === 409 && e.code === 'has-movement');

  const iadeEdildi = await p.materialQuarantine.returnToSupplier(karantinada.id, { now: NOW });
  assert.deepEqual(p.materialQuarantine.delete(iadeEdildi.id), { ok: true });
  assert.equal(p.materialQuarantine.list({}).length, 0);
});

test('list: durum süzgeci', async () => {
  const { p } = kur();
  await p.materialQuarantine.transferIn({ stockCode: 'HM1', kg: 5 }, { now: NOW });
  await p.materialQuarantine.transferIn({ stockCode: 'HM2', kg: 10 }, { now: NOW });
  assert.equal(p.materialQuarantine.list({ status: 'karantinada' }).length, 2);
  assert.equal(p.materialQuarantine.list({ status: 'iade-edildi' }).length, 0);
});

test('HTTP: GET liste / POST karantinaya aktar / POST retry-transfer / POST return / DELETE', async () => {
  const { p } = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json().catch(() => null) }; };
  const gonder = (yol, method, obj) => j(yol, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    const bos = await j('/api/planning/material/quarantine');
    assert.deepEqual(bos.json.items, []);

    const olustur = await gonder('/api/planning/material/quarantine', 'POST', { stockCode: 'HM1', stockName: 'Test hammadde', kg: 12, note: 'yanlış sipariş' });
    assert.equal(olustur.status, 201);
    assert.equal(olustur.json.status, 'karantinada');
    const id = olustur.json.id;

    const liste = await j('/api/planning/material/quarantine');
    assert.equal(liste.json.items.length, 1);

    assert.equal((await gonder(`/api/planning/material/quarantine/${id}/retry-transfer`, 'POST', {})).status, 409, 'zaten basarili, yeniden aktarilamaz');

    const iade = await gonder(`/api/planning/material/quarantine/${id}/return`, 'POST', {});
    assert.equal(iade.status, 200);
    assert.equal(iade.json.status, 'iade-edildi');

    const sil = await j(`/api/planning/material/quarantine/${id}`, { method: 'DELETE' });
    assert.equal(sil.status, 200);
    assert.equal((await j('/api/planning/material/quarantine')).json.items.length, 0);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
