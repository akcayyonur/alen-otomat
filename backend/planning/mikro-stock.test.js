/**
 * Depolar arasi sevkiyat / sarfiyat (virman) fisi (mikro-stock.js): saf onizleme kurma + yazma kapisi. GERCEK AG YOK
 * (client.sqlQuery/call sahte fonksiyonlarla beslenir). `send()`in MIKRO_WRITE_ENABLED olmadan asla client.call
 * CAGIRMADIGI ayrica dogrulanir (en kritik davranis: yanlislikla gercek Mikro'ya yazilmamasi).
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MikroStock } from './mikro-stock.js';

function kur({ writeEnabled = () => false, sqlQuery = async () => [], call = async () => { throw new Error('call cagrilmamali'); } } = {}) {
  const calls = [];
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => { calls.push(sql); return sqlQuery(sql); },
    call: async (endpoint, body) => { calls.push({ endpoint, body }); return call(endpoint, body); },
  };
  return { s: new MikroStock({ client, writeEnabled }), calls };
}

test('previewTransfer: dogru govde kurulur, goturmez (client.call cagrilmaz)', () => {
  const { s, calls } = kur();
  const p = s.previewTransfer({ fromDepotNo: 2, toDepotNo: 4, stockCode: 'HM614.AA24.00', kg: '12,5', note: 'test' }, { now: new Date(2026, 9, 29).getTime() });
  assert.equal(calls.length, 0, 'onizleme hicbir Mikro cagrisi yapmaz');
  assert.equal(p.endpoint, 'DahiliStokHareketKaydetV2');
  const satir = p.body.evraklar[0].satirlar[0];
  assert.deepEqual(
    [satir.sth_stok_kod, satir.sth_miktar, satir.sth_cikis_depo_no, satir.sth_giris_depo_no, satir.sth_evraktip, satir.sth_tip, satir.sth_cins],
    ['HM614.AA24.00', 12.5, 2, 4, 2, 2, 6],
  );
  assert.equal(satir.evrak_aciklamalari, undefined, 'evrak_aciklamalari satirda DEGIL, evrak duzeyinde olmali (Mikro dokumantasyonuyla birebir)');
  assert.deepEqual(p.body.evraklar[0].evrak_aciklamalari, [{ aciklama: 'test' }]);
  assert.equal(p.writeEnabled, false);
  assert.deepEqual(p.assumed, ['sth_tutar'], 'evraktip/tip/cins resmi dogrulandi; hala dogrulanmamis olan yalniz tutar (maliyet)');
});

test('previewTransfer: kaynak ve hedef depo ayni olamaz', () => {
  const { s } = kur();
  assert.throws(() => s.previewTransfer({ fromDepotNo: 1, toDepotNo: 1, stockCode: 'HM1', kg: 1 }), (e) => e.code === 'same-depot');
});

test('previewTransfer: dogrulama (depo, kilo, stok kodu)', () => {
  const { s } = kur();
  assert.throws(() => s.previewTransfer({ fromDepotNo: 0, toDepotNo: 1, stockCode: 'HM1', kg: 1 }), (e) => e.code === 'bad-depot');
  assert.throws(() => s.previewTransfer({ fromDepotNo: 1, toDepotNo: 2, stockCode: 'HM1', kg: 0 }), (e) => e.code === 'bad-kg');
  assert.throws(() => s.previewTransfer({ fromDepotNo: 1, toDepotNo: 2, stockCode: 'HM1', kg: 20000 }), (e) => e.code === 'bad-kg');
  assert.throws(() => s.previewTransfer({ fromDepotNo: 1, toDepotNo: 2, stockCode: '', kg: 1 }), (e) => e.code === 'bad-stock-code');
});

test('previewVirman: tek depo, cikis = giris; tip=1 (Cikis, resmi Mikro listesine gore 0=Giris/1=Cikis)', () => {
  const { s } = kur();
  const p = s.previewVirman({ depotNo: 4, stockCode: 'HM614.AA24.00', kg: 3.9, note: 'is emri 2026001199 sarfiyati' }, { now: Date.now() });
  const satir = p.body.evraklar[0].satirlar[0];
  assert.deepEqual([satir.sth_cikis_depo_no, satir.sth_giris_depo_no, satir.sth_evraktip, satir.sth_tip, satir.sth_cins], [4, 4, 6, 1, 3]);
  assert.equal(p.kind, 'virman');
});

test('send: yazma KAPALIYKEN client.call ASLA cagrilmaz, 409 mikro-write-disabled firlar', async () => {
  const { s, calls } = kur({ writeEnabled: () => false });
  const p = s.previewVirman({ depotNo: 4, stockCode: 'HM1', kg: 1 });
  await assert.rejects(() => s.send(p), (e) => e.status === 409 && e.code === 'mikro-write-disabled');
  assert.equal(calls.length, 0, 'yazma kapaliyken Mikroya hicbir sey gonderilmedi');
});

test('send: yazma ACIKKEN client.call dogru endpoint + govde ile cagrilir, sonucu doner', async () => {
  const { s, calls } = kur({ writeEnabled: () => true, call: async () => ({ IsError: false, ok: true }) });
  const p = s.previewTransfer({ fromDepotNo: 2, toDepotNo: 4, stockCode: 'HM1', kg: 1 });
  const r = await s.send(p);
  assert.deepEqual(r, { IsError: false, ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'DahiliStokHareketKaydetV2');
  assert.deepEqual(calls[0].body, p.body);
});

test('listDepots: SQL iptal/gizli depoyu dislar, satirlari {depotNo, name} seklinde doner', async () => {
  const { s, calls } = kur({ sqlQuery: async () => [{ dep_no: 1, dep_adi: 'MERKEZ DEPO' }, { dep_no: 4, dep_adi: 'REZERV HAMMADDE' }] });
  const r = await s.listDepots();
  assert.deepEqual(r, [{ depotNo: 1, name: 'MERKEZ DEPO' }, { depotNo: 4, name: 'REZERV HAMMADDE' }]);
  assert.match(calls[0], /dep_iptal = 0 AND dep_hidden = 0/);
});

test('searchMaterials: SQL hammaddeyle (HM%) sinirlar, arama metnini LIKE ile ekler, SQL enjeksiyon karakterleri temizlenir', async () => {
  const { s, calls } = kur({ sqlQuery: async () => [{ sto_kod: 'HM614.AA24.00', sto_isim: 'AA24.00 PİRİNÇ ÇUBUK PB3', sto_birim1_ad: 'KİLOGRAM' }] });
  const r = await s.searchMaterials("AA24'; DROP TABLE STOKLAR; --");
  assert.deepEqual(r, [{ stockCode: 'HM614.AA24.00', name: 'AA24.00 PİRİNÇ ÇUBUK PB3', unit: 'KİLOGRAM' }]);
  assert.match(calls[0], /sto_kod LIKE 'HM%'/);
  assert.match(calls[0], /LIKE '%AA24; DROP TABLE STOKLAR; --%'/, 'tek tirnak (enjeksiyon karakteri) govdeden temizlenir, geri kalan metin aynen LIKE desenine girer');
});

test('HTTP: depo/hammadde listesi (GET) ve onizleme (POST) calisir; gonderme kapaliyken 409', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  const { Planning } = await import('./planning.js');
  const client = {
    configured: () => true,
    sqlQuery: async (sql) => (sql.includes('DEPOLAR') ? [{ dep_no: 4, dep_adi: 'REZERV HAMMADDE' }] : [{ sto_kod: 'HM1', sto_isim: 'Pirinc', sto_birim1_ad: 'KG' }]),
    call: async () => { throw new Error('cagrilmamali'); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  try {
    const d = await j('/api/planning/material/mikro/depots');
    assert.deepEqual([d.status, d.json.items], [200, [{ depotNo: 4, name: 'REZERV HAMMADDE' }]]);
    const m = await j('/api/planning/material/mikro/materials?q=piri');
    assert.deepEqual([m.status, m.json.items[0].stockCode], [200, 'HM1']);
    const pv = await j('/api/planning/material/mikro/virman-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ depotNo: 4, stockCode: 'HM1', kg: 1 }) });
    assert.deepEqual([pv.status, pv.json.writeEnabled], [200, false]);
    const sd = await j('/api/planning/material/mikro/virman-send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ depotNo: 4, stockCode: 'HM1', kg: 1 }) });
    assert.deepEqual([sd.status, sd.json.code], [409, 'mikro-write-disabled']);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
