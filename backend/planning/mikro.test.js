/**
 * MIKRO API KAYNAGI (mikro.js): Kaynak klasorune (sources.js, Excel) PARALEL - ayni importParsed/'siparis' yoluna
 * dusuyor, yani ayni kurallar gecerli (bos alan dolar, elle duzenlenmis kart Mikro farkini KORUR). Burada GERCEK
 * ag/Mikro YOK - `client.sqlQuery` sahte bir fonksiyonla besleniyor.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planning } from './planning.js';

/** @param {object[]} rows bir sonraki refresh()'te client.sqlQuery'nin donecegi satirlar */
function kur(rows = []) {
  let sonSorgu = null;
  const client = {
    configured: () => true, host: '192.168.1.112', port: 8094,
    sqlQuery: async (sql) => { sonSorgu = sql; return rows; },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  return { p, client, sonSorgu: () => sonSorgu, bitir: () => p.close() };
}

const satir = (over = {}) => ({
  Mamul_Kodu: 'SR001.001', Mamul_Adi: '0010010000 PARCA', Evrak_No: 'SPR-1', Must_Sip_No: 'MS-1',
  Miktar: 100, Sevk_Edilen_Miktar: 0, Kalan_Miktar: 100, Musteri: 'FIRMA X',
  Sip_Tarihi: '13.09.2025', Teyit_Edilen_Tarih: '', HM: 'HM1', BR: '0,0200', NT: '0,0100', SN: '30', 'TAM BOY': '40',
  ...over,
});

test('yapilandirilmamis istemci: status().configured false, refresh 409 mikro-not-configured', async () => {
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null });
  try {
    assert.deepEqual(p.mikro.status(), { configured: false, host: null, port: 8094, last: null });
    await assert.rejects(() => p.mikro.refresh(), (e) => e.status === 409 && e.code === 'mikro-not-configured');
  } finally { p.close(); }
});

test('refresh: siparis satiri + urun karti ipuclari ayni importSiparis yolundan islenir (sources.js ile ayni kurallar)', async () => {
  const k = kur([satir(), satir({ Mamul_Kodu: 'SR002.001', Evrak_No: 'SPR-1' })]);
  try {
    const r = await k.p.mikro.refresh({ by: 'ayse' });
    assert.equal(r.source, 'mikro');
    assert.deepEqual(r.totals.lines, { added: 2, updated: 0 });
    assert.deepEqual(r.totals.products, { added: 2, updated: 0, protected: 0 });
    assert.deepEqual(r.changes.lines.added.map((x) => x.stockCode), ['SR001.001', 'SR002.001']);
    assert.equal(r.rows, 2);
    assert.deepEqual(r.warnings, [], 'tarih sutunu (Sip_Tarihi) dogru basliklarla okunuyor - uyari cikmamali');
    const beklenenTarih = new Date(2025, 8, 13).getTime();
    assert.equal(k.p.orderLines({ customerKey: 'FIRMA X', custOrderKey: 'MS-1', docKey: 'SPR-1' }).every((x) => x.orderDate === beklenenTarih), true);

    const kart = k.p.getProduct('SR001.001');
    assert.equal(kart.material, 'HM1');
    assert.equal(kart.grossKg, 0.02, 'BR');
    assert.equal(kart.netKg, 0.01, 'NT');
    assert.equal(kart.plannedSec, 30, 'SN');
    assert.equal(kart.lengthMm, 40, 'TAM BOY');

    // SQL'de tip filtresi (sip_tip = 0) ve STOKLAR_USER join'i gercekten gonderiliyor mu
    assert.match(k.sonSorgu(), /sip_tip = 0/);
    assert.match(k.sonSorgu(), /STOKLAR_USER/);

    const st = k.p.mikro.status();
    assert.equal(st.configured, true);
    assert.deepEqual([st.last.by, st.last.rows], ['ayse', 2]);
  } finally { k.bitir(); }
});

test('refresh: bos sonuc (satir yok) cokmez, hicbir seyi silmez (keepOld=true ile ayni davranis)', async () => {
  const k = kur([]);
  try {
    const r = await k.p.mikro.refresh();
    assert.deepEqual([r.rows, r.totals.lines, r.totals.products], [0, { added: 0, updated: 0 }, { added: 0, updated: 0, protected: 0 }]);
  } finally { k.bitir(); }
});

test('refresh: elle duzenlenmis kartta Mikro farki EZILMEZ, "korunan" olarak bildirilir', async () => {
  const k = kur([satir()]);
  try {
    await k.p.mikro.refresh();
    k.p.updateProduct('SR001.001', { grossKg: 0.05 }, { by: 'usta', edited: true });

    k.client.sqlQuery = async () => [satir({ BR: '0,0900' })]; // Mikro'da BR degisti
    const r = await k.p.mikro.refresh();
    assert.equal(r.totals.products.protected, 1);
    assert.equal(k.p.getProduct('SR001.001').grossKg, 0.05, 'elle girilen deger korundu');
  } finally { k.bitir(); }
});

test('refresh: ayni anda iki senkron 409 busy verir', async () => {
  let cozBekleyeni;
  const client = {
    configured: () => true, host: 'x', port: 1,
    sqlQuery: () => new Promise((r) => { cozBekleyeni = () => r([]); }),
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  try {
    const birinci = p.mikro.refresh();
    await assert.rejects(() => p.mikro.refresh(), (e) => e.status === 409 && e.code === 'busy');
    cozBekleyeni();
    await birinci;
  } finally { p.close(); }
});

test('test(): basarili baglantida {ok:true}, istemci hata firlatirsa oldugu gibi yukari cikar', async () => {
  const k = kur([]);
  try {
    assert.deepEqual(await k.p.mikro.test(), { ok: true });
  } finally { k.bitir(); }

  const hatali = { configured: () => true, host: 'x', port: 1, sqlQuery: async () => { throw new Error('baglanti yok'); } };
  const p2 = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: hatali });
  try {
    await assert.rejects(() => p2.mikro.test(), /baglanti yok/);
  } finally { p2.close(); }
});

test('HTTP: GET durum, POST test, POST yenile (yalniz yonetici varsayimiyla - burada kapi yok, routes dogrudan cagrilir)', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  const k = kur([satir()]);
  const routes = createPlanningRoutes({ planning: k.p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  try {
    const d = await j('/api/planning/mikro');
    assert.deepEqual([d.status, d.json.configured], [200, true]);
    const t = await j('/api/planning/mikro/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([t.status, t.json], [200, { ok: true }]);
    const y = await j('/api/planning/mikro/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([y.status, y.json.totals.lines.added], [200, 1]);
  } finally {
    await new Promise((r) => srv.close(r));
    k.bitir();
  }
});
