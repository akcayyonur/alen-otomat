/**
 * MikroClient (mikro-client.js): kimlik dogrulama (gunluk Sifre hash'i) ve istek/yanit isleme (HTTP hatasi VE govde-ici
 * `IsError:true` ikisi de PlanningError'a cevrilir). GERCEK AG CAGRISI YOK - `fetchImpl` her testte enjekte edilir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MikroClient } from './mikro-client.js';

const dolu = () => new MikroClient({
  host: '192.168.1.112', port: 8094, firmaKodu: '1', kullaniciKodu: 'admin', sifre: 'gizli', apiKey: 'ANAHTAR', calismaYili: '2026',
});

function okResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

test('sifreHash: gunluk formul MD5("yyyy-AA-gg " + ham sifre) - regresyon kilidi', () => {
  const c = dolu();
  const gun = new Date(2026, 9, 28, 14, 30); // 2026-10-28 (ay 0-tabanli)
  const beklenen = createHash('md5').update('2026-10-28 gizli').digest('hex');
  assert.equal(c.sifreHash(gun), beklenen);
  // ayni gun, farkli saat: ayni hash (gunluk doner, saatlik degil)
  assert.equal(c.sifreHash(new Date(2026, 9, 28, 23, 59)), beklenen);
  // baska gun: farkli hash
  assert.notEqual(c.sifreHash(new Date(2026, 9, 29, 0, 0)), beklenen);
});

test('configured: hepsi dolu olmali, biri eksikse false', () => {
  assert.equal(dolu().configured(), true);
  for (const alan of ['host', 'firmaKodu', 'kullaniciKodu', 'sifre', 'apiKey']) {
    const c = dolu();
    c[alan] = null;
    assert.equal(c.configured(), false, alan);
  }
});

test('call: yapilandirilmamissa agi hic denemeden mikro-not-configured firlatir', async () => {
  const c = new MikroClient({});
  let cagrildi = false;
  c.fetchImpl = async () => { cagrildi = true; };
  await assert.rejects(() => c.call('X'), (e) => e.status === 409 && e.code === 'mikro-not-configured');
  assert.equal(cagrildi, false);
});

test('call: basarili istek - URL, govde (ApiKey/Sifre/...) ve ekstra alanlar dogru gonderilir, ilk sonuc nesnesi doner', async () => {
  const c = dolu();
  let gorulenUrl; let gorulenGovde;
  c.fetchImpl = async (url, opts) => {
    gorulenUrl = url;
    gorulenGovde = JSON.parse(opts.body);
    return okResponse({ result: [{ IsError: false, Data: [{ SQLResult1: [{ sto_kod: 'HM1' }] }] }] });
  };
  const r = await c.call('SqlVeriOkuV2', { SQLSorgu: 'SELECT 1' }, { now: new Date(2026, 9, 28) });
  assert.equal(gorulenUrl, 'http://192.168.1.112:8094/Api/apiMethods/SqlVeriOkuV2');
  assert.deepEqual(gorulenGovde.Mikro, { ApiKey: 'ANAHTAR', CalismaYili: '2026', FirmaKodu: '1', KullaniciKodu: 'admin', Sifre: c.sifreHash(new Date(2026, 9, 28)) });
  assert.equal(gorulenGovde.SQLSorgu, 'SELECT 1');
  assert.deepEqual(r.Data[0].SQLResult1, [{ sto_kod: 'HM1' }]);
});

test('call: HTTP hatasi (ör. 500) mikro-http-error olur', async () => {
  const c = dolu();
  c.fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'sunucu hatası' });
  await assert.rejects(() => c.call('X'), (e) => e.status === 502 && e.code === 'mikro-http-error' && /500/.test(e.message));
});

test('call: HTTP 200 icinde govde-ici IsError:true de hata sayilir (gercek Mikro PC\'sinde boyle gorundu)', async () => {
  const c = dolu();
  c.fetchImpl = async () => okResponse({ result: [{ StatusCode: 1, IsError: true, ErrorMessage: 'MikroAPI lisansınız yok!' }] });
  await assert.rejects(() => c.call('X'), (e) => e.status === 502 && e.code === 'mikro-api-error' && e.message.includes('MikroAPI lisansınız yok!'));
});

test('call: bozuk JSON yaniti mikro-bad-response olur', async () => {
  const c = dolu();
  c.fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'bu JSON degil' });
  await assert.rejects(() => c.call('X'), (e) => e.status === 502 && e.code === 'mikro-bad-response');
});

test('call: fetch agi hic denemeden (ag kapali) reddederse mikro-unreachable olur', async () => {
  const c = dolu();
  c.fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => c.call('X'), (e) => e.status === 502 && e.code === 'mikro-unreachable' && e.message.includes('ECONNREFUSED'));
});

test('call: zaman asimi (AbortError) ayirt edilebilir mesaj verir', async () => {
  const c = dolu();
  c.fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(() => c.call('X', {}, { timeoutMs: 5 }), (e) => e.status === 502 && e.code === 'mikro-unreachable' && /yanıt vermedi/.test(e.message));
});

test('sqlQuery: Data[0].SQLResult1 doner, eksikse bos dizi', async () => {
  const c = dolu();
  c.fetchImpl = async () => okResponse({ result: [{ IsError: false, Data: [{ SQLResult1: [{ a: 1 }, { a: 2 }] }] }] });
  assert.deepEqual(await c.sqlQuery('SELECT ...'), [{ a: 1 }, { a: 2 }]);

  c.fetchImpl = async () => okResponse({ result: [{ IsError: false, Data: [] }] });
  assert.deepEqual(await c.sqlQuery('SELECT ...'), []);
});
