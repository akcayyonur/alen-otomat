/**
 * KAYNAK KLASORU (sources.js): Mikro / GKK Excel dosyalarini sabit klasorden okuyup "Yenile" ile uygulama. Klasor ayari, degisiklik tespiti
 * (boyut + zaman, sonra icerik ozeti), degisen/yeni kayitlarin listesi, okunamayan ve tanimadigi dosyalar, HTTP uclari. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { xlsxOf, serial } from './test/xlsx-fixture.js';

const SIPARIS_BASLIK = 'Musteri;Mamul_Kodu;Mamul_Adi;Evrak_No;Sip_Tarihi;Miktar;Sevk_Edilen_Miktar;Kalan_Miktar;Must_Sip_No;BR;NT;SN;HM;TAM BOY';
const satir = (kod, evrak, kalan = 100, br = '0,0200') => `FIRMA X;${kod};${kod.replace(/\D/g, '')}0000 PARCA;${evrak};13.09.2025;100;${100 - kalan};${kalan};MS-1;${br};0,0100;30;HM1;40`;
const siparisCsv = (...satirlar) => [SIPARIS_BASLIK, ...satirlar, ''].join('\r\n');
const STOK_BASLIK = 'Stok_Kod;Stok_Adi;Fiili_Stok;Gecici_Stok;Net_Agirlik;Dara';
const stokSatir = (kod, fiili, gecici = 0, ad = 'Pirinç çubuk') => `${kod};${ad};${fiili};${gecici};0,0078;0,0005`;
const stokCsv = (...satirlar) => [STOK_BASLIK, ...satirlar, ''].join('\r\n');
const GKK_CSV = [
  ';;GİRİŞ KALİTE KONTROL RAPOR NUMARASI TAKİP FORMU;;;', '',
  'SIRA;ÜRÜN ;;RAPOR NO;ÜRETİCİ RAPOR TARİHİ;AÇIKLAMA',
  '1;YUV12 - PB3;;GK25.013;02.02.2024;', '2;AA24 X 13 - PB3;;GK26.395;26.09.2026;not', '',
].join('\r\n');

function kur() {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-kaynak-'));
  const kaynak = join(dir, 'kaynak');
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, sourcesDir: kaynak });
  const yaz = (ad, icerik, mtimeSn) => {
    mkdirSync(kaynak, { recursive: true });
    writeFileSync(join(kaynak, ad), icerik);
    if (mtimeSn !== undefined) utimesSync(join(kaynak, ad), mtimeSn, mtimeSn); // dosya zamani (saniye)
  };
  return { p, dir, kaynak, yaz, bitir: () => { p.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('klasor: varsayilan klasor ilk bakista olusturulur; ayar dogrulanir (mutlak yol, var olan klasor); bos ayar varsayilana doner', () => {
  const k = kur();
  try {
    assert.equal(existsSync(k.kaynak), false);
    const s = k.p.sources.status();
    assert.deepEqual([s.dir, s.isDefault, s.exists, s.files.length, s.pending], [k.kaynak, true, true, 0, 0]);
    assert.equal(existsSync(k.kaynak), true, 'dosyayi oraya koyabilsin');

    for (const [deger, hata] of [['goreli\\klasor', /tam \(mutlak\)/], [join(k.dir, 'yok'), /bulunamadı/], [join(k.dir, 'x'.repeat(300)), /260/]]) {
      assert.throws(() => k.p.sources.setDir(deger), (e) => e.status === 400 && hata.test(e.message), String(deger).slice(0, 30));
    }
    k.yaz('dosya.txt', 'x');
    assert.throws(() => k.p.sources.setDir(join(k.kaynak, 'dosya.txt')), /klasör değil/);
    assert.equal(existsSync(join(k.dir, 'yok')), false, 'ayarli klasor ASLA olusturulmaz');

    const diger = join(k.dir, 'baska');
    mkdirSync(diger);
    assert.deepEqual(k.p.sources.setDir(diger), { dir: diger, defaultDir: k.kaynak, isDefault: false });
    assert.equal(k.p.sources.setDir('  ').isDefault, true);
  } finally { k.bitir(); }
});

test('yenile: ilk seferde dosyalar islenir (siparis + GKK); ikinci seferde degismeyen dosyaya dokunulmaz; yeniden kaydedilen ama ayni icerik islenmez', () => {
  const k = kur();
  try {
    k.yaz('mikro.csv', siparisCsv(satir('SR001.001', 'SPR-1'), satir('SR002.001', 'SPR-1')), 1_700_000_000);
    k.yaz('gkk.csv', GKK_CSV, 1_700_000_100);
    assert.deepEqual(k.p.sources.status().files.map((f) => [f.name, f.state]), [['mikro.csv', 'yeni'], ['gkk.csv', 'yeni']], 'eskiden yeniye');

    const r1 = k.p.sources.refresh({ by: 'ayse' });
    assert.deepEqual([r1.processed, r1.unchanged, r1.failed], [2, 0, 0]);
    assert.deepEqual(r1.totals.lines, { added: 2, updated: 0 });
    assert.deepEqual(r1.totals.products, { added: 2, updated: 0, protected: 0 });
    assert.deepEqual(r1.totals.gkk, { added: 2, updated: 0 });
    assert.deepEqual(r1.changes.lines.added.map((x) => x.stockCode), ['SR001.001', 'SR002.001']);
    assert.equal(r1.changes.gkk.added[0].reportNo, 'GK25.013');
    assert.equal(k.p.getProduct('SR001.001').customerCode, '0010010000', 'Mikro adinin basindaki kod');
    assert.equal(k.p.summary().lastImports[0].filename, 'gkk.csv', 'her dosya ayri toplu iceri alma kaydi');
    assert.deepEqual(k.p.sources.status().files.map((f) => f.state), ['ayni', 'ayni']);
    assert.equal(k.p.sources.status().last.processed, 2);

    const batchSayisi = () => k.p.db.db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n;
    const once = batchSayisi();
    const r2 = k.p.sources.refresh({ by: 'ayse' });
    assert.deepEqual([r2.processed, r2.unchanged], [0, 2]);
    assert.equal(batchSayisi(), once, 'degismeyen dosya iceri alinmaz');

    // Mikro dosyayi yeniden yazdi ama icerik ayni: zaman degisir, islenmez
    k.yaz('mikro.csv', siparisCsv(satir('SR001.001', 'SPR-1'), satir('SR002.001', 'SPR-1')), 1_700_000_500);
    assert.equal(k.p.sources.status().files.find((f) => f.name === 'mikro.csv').state, 'degisti', 'durum satiri zaman farkini gorur');
    const r3 = k.p.sources.refresh();
    assert.deepEqual([r3.processed, r3.unchanged], [0, 2], 'icerik ozeti ayni: islenmedi');
    assert.equal(k.p.sources.status().files.find((f) => f.name === 'mikro.csv').state, 'ayni', 'zaman yenilendi');
    assert.equal(batchSayisi(), once);

    const r4 = k.p.sources.refresh({ force: true });
    assert.deepEqual([r4.processed, r4.totals.lines.added, r4.totals.lines.updated], [2, 0, 0], 'zorla: dosyalar yeniden okunur, kayit degismez');
  } finally { k.bitir(); }
});

test('yenile: Mikro dosyasinda yeni siparis satiri ve degisen kalan miktar bulunur; dosyadan kalkan satir GIZLENMEZ', () => {
  const k = kur();
  try {
    k.yaz('mikro.csv', siparisCsv(satir('SR001.001', 'SPR-1', 100), satir('SR002.001', 'SPR-1', 100)), 1_700_000_000);
    k.p.sources.refresh();

    // sevkiyat oldu (SR001 kalan 100 -> 40), yeni evrak geldi (SR003), SR002 dosyadan kalkti
    k.yaz('mikro.csv', siparisCsv(satir('SR001.001', 'SPR-1', 40), satir('SR003.001', 'SPR-9', 70)), 1_700_001_000);
    const r = k.p.sources.refresh({ by: 'ayse' });
    assert.equal(r.processed, 1);
    assert.deepEqual(r.changes.lines.added, [{ docNo: 'SPR-9', custOrderNo: 'MS-1', stockCode: 'SR003.001', qty: 100, remaining: 70 }]);
    assert.deepEqual(r.changes.lines.updated.map((x) => [x.docNo, x.stockCode, x.remaining]), [['SPR-1', 'SR001.001', 40]]);
    assert.deepEqual(r.totals.lines, { added: 1, updated: 1 });
    assert.equal(k.p.searchOrders({ q: 'SPR-1' }).length, 1, 'SR002 satiri da duruyor (gizlenmedi)');
    assert.equal(k.p.orderLines({ customerKey: 'FIRMA X', custOrderKey: 'MS-1', docKey: 'SPR-1' }).length, 2);
  } finally { k.bitir(); }
});

test('yenile: .xlsx kitabi tum sayfalariyla islenir; ~$ kilit dosyasi, .txt ve alt klasor atlanir; ilgisiz Excel bir kez "atlandi" der', () => {
  const k = kur();
  try {
    const kitap = xlsxOf([
      { name: '_SIPARIS', rows: [SIPARIS_BASLIK.split(';'), ['FIRMA X', 'SR001.001', '0010010000 PARCA', 'SPR-1', { n: serial(2025, 9, 13), s: 2 }, 100, 0, 100, 'MS-1', 0.02, 0.01, 30, 'HM1', 40]] },
      { name: '_SEVKIYAT', rows: [['Musteri', 'Malzeme Kodu', 'Tarih'], ['FIRMA X', 'SR001.001', 'x']] },
    ]);
    k.yaz('mikro.xlsx', kitap, 1_700_000_000);
    k.yaz('~$mikro.xlsx', 'kilit', 1_700_000_001);
    k.yaz('notlar.txt', 'x');
    mkdirSync(join(k.kaynak, 'alt'));
    k.yaz('alt-degil.xlsx', xlsxOf([{ name: 'Sayfa1', rows: [['A', 'B'], ['1', '2']] }]), 1_700_000_050); // ilgisiz Excel

    const r = k.p.sources.refresh();
    assert.deepEqual(r.files.map((f) => [f.name, f.state]), [['mikro.xlsx', 'islendi'], ['alt-degil.xlsx', 'atlandi']]);
    assert.deepEqual(r.files[0].skippedSheets.map((s) => s.name), ['_SEVKIYAT']);
    assert.equal(r.files[1].error.startsWith('Çalışma kitabındaki hiçbir sayfa tanınmadı'), true);
    assert.deepEqual([r.processed, r.skipped, r.failed], [1, 1, 0]);

    const r2 = k.p.sources.refresh();
    assert.deepEqual(r2.files.map((f) => f.state), ['degismedi', 'degismedi'], 'ilgisiz dosya her yenilemede yeniden denenmez');
  } finally { k.bitir(); }
});

test('yenile: bozuk / yarim yazilmis dosya "okunamadi" olur, KAYDEDILMEZ ve duzelince islenir; klasor yoksa ya da ayarsizsa acik hata', () => {
  const k = kur();
  try {
    k.yaz('mikro.xlsx', Buffer.from('PK\x03\x04 yarim yazilmis dosya'), 1_700_000_000);
    const r1 = k.p.sources.refresh();
    assert.equal(r1.files[0].state, 'okunamadi');
    assert.match(r1.files[0].error, /Dosya şu an yazılıyor olabilir/);
    assert.equal(r1.failed, 1);
    assert.equal(k.p.sources.status().files[0].state, 'yeni', 'kaydedilmedi: bir sonraki yenilemede yeniden denenir');

    k.yaz('mikro.xlsx', xlsxOf([{ name: '_SIPARIS', rows: [SIPARIS_BASLIK.split(';'), ['FIRMA X', 'SR001.001', '0010010000 PARCA', 'SPR-1', { n: serial(2025, 9, 13), s: 2 }, 100, 0, 100, 'MS-1', 0.02, 0.01, 30, 'HM1', 40]] }]), 1_700_000_900);
    const r2 = k.p.sources.refresh();
    assert.deepEqual([r2.files[0].state, r2.totals.lines.added], ['islendi', 1]);
  } finally { k.bitir(); }

  const bos = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null });
  assert.throws(() => bos.sources.refresh(), (e) => e.status === 409 && e.code === 'no-dir' && /ayarlanmadı/.test(e.message));
  assert.deepEqual(bos.sources.status(), { dir: null, defaultDir: null, isDefault: true, exists: false, files: [], pending: 0, last: null });
  bos.close();
});

test('yenile: hammadde depo stogu (stok) taninir; TAM DEGISTIRME (dusen kod silinir); bos/bozuk sayi null olur, cokmez', () => {
  const k = kur();
  try {
    k.yaz('stok.csv', stokCsv(stokSatir('HM614.YU23.00', 150, 50), stokSatir('HM617.YU18.00', 80)), 1_700_000_000);
    const r1 = k.p.sources.refresh();
    assert.deepEqual([r1.files[0].state, r1.totals.stock], ['islendi', { added: 2, updated: 0, removed: 0 }]);
    assert.deepEqual(k.p.db.listMaterialStock().map((x) => [x.stockCode, x.onHandKg, x.pendingKg]), [['HM614.YU23.00', 150, 50], ['HM617.YU18.00', 80, 0]]);

    // ikinci dosya: HM614 miktari degisti, HM617 dosyadan DUSTU (silinmeli, siparis/is-emri gibi gizli kalmaz), yeni kod HM999 geldi
    k.yaz('stok.csv', stokCsv(stokSatir('HM614.YU23.00', 120, 50), stokSatir('HM999.00', 10)), 1_700_001_000);
    const r2 = k.p.sources.refresh();
    assert.deepEqual(r2.totals.stock, { added: 1, updated: 1, removed: 1 });
    assert.deepEqual(k.p.db.listMaterialStock().map((x) => x.stockCode), ['HM614.YU23.00', 'HM999.00'], 'HM617 silindi, gecmis tutulmaz');

    // bos/bozuk hucre
    k.yaz('stok.csv', stokCsv('HM555.00;Bilinmeyen;;abc;;'), 1_700_002_000);
    k.p.sources.refresh();
    const bos = k.p.db.listMaterialStock().find((x) => x.stockCode === 'HM555.00');
    assert.deepEqual([bos.onHandKg, bos.pendingKg, bos.netKg, bos.tareKg], [null, null, null, null]);
  } finally { k.bitir(); }
});

test('HTTP: GET durum, PUT klasor, POST yenile (yalniz govde ile force); hatali klasor 400', async () => {
  const k = kur();
  const routes = createPlanningRoutes({ planning: k.p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  const json = (method, obj) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    k.yaz('mikro.csv', siparisCsv(satir('SR001.001', 'SPR-1')), 1_700_000_000);
    const d = await j('/api/planning/sources');
    assert.equal(d.status, 200);
    assert.deepEqual([d.json.dir, d.json.pending, d.json.files[0].state], [k.kaynak, 1, 'yeni']);
    const y = await j('/api/planning/sources/refresh', json('POST', {}));
    assert.equal(y.status, 200);
    assert.deepEqual([y.json.processed, y.json.totals.lines.added], [1, 1]);
    assert.equal((await j('/api/planning/sources')).json.pending, 0);
    const z = await j('/api/planning/sources/refresh', json('POST', { force: true }));
    assert.equal(z.json.processed, 1);
    assert.equal((await j('/api/planning/sources/dir', json('PUT', { dir: 'goreli' }))).status, 400);
    const yeniDizin = join(k.dir, 'baska');
    mkdirSync(yeniDizin);
    const p = await j('/api/planning/sources/dir', json('PUT', { dir: yeniDizin }));
    assert.deepEqual([p.status, p.json.dir, p.json.isDefault, p.json.files.length], [200, yeniDizin, false, 0]);
  } finally {
    await new Promise((r) => srv.close(r));
    k.bitir();
  }
});
