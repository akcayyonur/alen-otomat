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

/**
 * @param {object[]} rows bir sonraki refresh()'te SIPARIS_SQL icin donecek satirlar
 * @param {object[]} stokRows ayni refresh()'teki (siparisten BAGIMSIZ) STOK_SQL icin donecek satirlar - varsayilan
 *   bos: cogu test yalniz SIPARIS_SQL yolunu sinadigi icin stok senkronu "0 satir" doner, mevcut beklentileri degistirmez.
 */
function kur(rows = [], stokRows = []) {
  const sorgular = [];
  const client = {
    configured: () => true, host: '192.168.1.112', port: 8094,
    sqlQuery: async (sql) => { sorgular.push(sql); return sql.includes('SIPARISLER') ? rows : stokRows; },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  // sorgular(): bu refresh()'te yapilan TUM sqlQuery cagrilari (artik iki tane - SIPARIS_SQL + STOK_SQL);
  // sonSorgu(): geriye donuk uyumluluk icin SONUNCUSU (eskiden tek cagri oldugu icin yeterliydi).
  return { p, client, sorgular: () => sorgular, sonSorgu: () => sorgular[sorgular.length - 1], bitir: () => p.close() };
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
    assert.deepEqual(r.totals.lines, { added: 2, updated: 0, removed: 0 });
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

    // SQL'de tip filtresi (sip_tip = 0) ve STOKLAR_USER join'i gercekten gonderiliyor mu (SIPARIS_SQL'in KENDISI -
    // artik STOK_SQL de ayrica gonderiliyor, sonSorgu() ikincisini doner, bu yuzden sorgular() icinden aranir).
    const siparisSorgusu = k.sorgular().find((s) => s.includes('SIPARISLER'));
    assert.match(siparisSorgusu, /sip_tip = 0/);
    assert.match(siparisSorgusu, /STOKLAR_USER/);

    const st = k.p.mikro.status();
    assert.equal(st.configured, true);
    assert.deepEqual([st.last.by, st.last.rows], ['ayse', 2]);
  } finally { k.bitir(); }
});

/** 'isemri' bicimindeki basliklarla (STOK_SQL'in dondurdugu sekil) tek bir stok karti satiri. */
const stokSatir = (over = {}) => ({
  'ALEN KOD': 'SR004.019', 'MAMÜL ADI': 'DN40 ÇİFT TARAFLI NİPEL', HAMMADDE: 'HM2', 'ÜRETİM SN': '45',
  'BRÜT GR': '0,0300', 'NET GR': '0,0150', 'TAM BOY': '25', ...over,
});

test('refresh: siparisi hic olmayan SR kodu (STOK_SQL, siparisten BAGIMSIZ) da urun kartina islenir - gercek SR004/SR005.019 bulgusu', async () => {
  const k = kur([], [stokSatir()]); // SIPARIS_SQL bos (hic siparis yok), STOK_SQL bu kodu getiriyor
  try {
    const r = await k.p.mikro.refresh({ by: 'ayse' });
    assert.deepEqual(r.totals.lines, { added: 0, updated: 0, removed: 0 }, 'siparis satiri yok, hic olmamali');
    assert.deepEqual(r.totals.products, { added: 1, updated: 0, protected: 0 });
    assert.equal(r.rows, 1, 'SIPARIS_SQL 0 + STOK_SQL 1');
    assert.deepEqual(r.changes.products.added.map((x) => x.stockCode), ['SR004.019']);

    const kart = k.p.getProduct('SR004.019');
    assert.equal(kart.name, 'DN40 ÇİFT TARAFLI NİPEL');
    assert.equal(kart.material, 'HM2');
    assert.equal(kart.plannedSec, 45);
    assert.equal(kart.grossKg, 0.03, 'BRUT GR');
    assert.equal(kart.netKg, 0.015, 'NET GR');
    assert.equal(kart.lengthMm, 25, 'TAM BOY - isemri bicimine 2026-11-16da eklenen istege bagli alan');

    // Alen kod bicimine uyan stok kodlari icin dogru WHERE kosulu gonderiliyor mu (iki harf + 3 rakam + nokta + 3 rakam)
    assert.match(k.sonSorgu(), /\[0-9\]\[0-9\]\[0-9\]\.\[0-9\]\[0-9\]\[0-9\]/);
    assert.match(k.sonSorgu(), /STOKLAR_USER/);
  } finally { k.bitir(); }
});

test('refresh: ayni urun hem siparisten hem STOK_SQL\'den gelirse cakismaz - ikinci gecis sadece "unchanged" sayilir', async () => {
  const k = kur([satir()], [stokSatir({ 'ALEN KOD': 'SR001.001', 'MAMÜL ADI': '0010010000 PARCA', HAMMADDE: 'HM1', 'ÜRETİM SN': '30', 'BRÜT GR': '0,0200', 'NET GR': '0,0100', 'TAM BOY': '40' })]);
  try {
    const r = await k.p.mikro.refresh();
    // siparis tarafi karti zaten ekledi (BR/NT/SN ayni degerlerle) - STOK_SQL gecisi "zaten ayni" der, ikinci kez eklemez
    assert.deepEqual(r.totals.products, { added: 1, updated: 0, protected: 0 });
    assert.equal(k.p.getProduct('SR001.001').material, 'HM1');
  } finally { k.bitir(); }
});

test('refresh: bos sonuc (satir yok) cokmez; daha once HIC siparis yoksa markStale\'in isaretleyecegi bir satir da yok', async () => {
  const k = kur([]);
  try {
    const r = await k.p.mikro.refresh();
    assert.deepEqual([r.rows, r.totals.lines, r.totals.products], [0, { added: 0, updated: 0, removed: 0 }, { added: 0, updated: 0, protected: 0 }]);
  } finally { k.bitir(); }
});

/* ============================================================================ Mikro'da silinen siparis (2026-11-19) */
/* Kullanici bulgusu: Mikro'dan bir siparis silinince ("SPR-755" gercek ornegi) "Siparişler" ekraninda SONSUZA
 * DEK kalmaya devam ediyordu - sources.js'in (Excel) "kismi export olabilir, gizleme" ihtiyati mikro.js'e
 * (MikroAPI SQL, TAM dokum, tarih/LIMIT filtresi yok) kopyalanmisti (`keepOld: true`). Duzeltme: mikro.js artik
 * `keepOld: false` gecirir - bu cekilista HIC GORUNMEYEN bir satir GERCEKTEN silinmis sayilir (`markStale`). */

test('refresh: ONCEKI senkronda gelen bir siparis SONRAKI senkronda HIC GORUNMUYORSA stale isaretlenir, "Siparişler" listesinden kalkar', async () => {
  const k = kur([satir(), satir({ Mamul_Kodu: 'SR002.001', Evrak_No: 'SPR-1' })]);
  try {
    await k.p.mikro.refresh();
    assert.equal(k.p.searchOrders({ q: 'SPR-1' }).length, 1, 'ilk senkrondan sonra siparis listede gorunur');

    // ikinci senkronda Mikro'dan BOS donuyor (gercek SPR-755 gibi: evrak Mikro'dan tamamen silindi)
    k.client.sqlQuery = async (sql) => (sql.includes('SIPARISLER') ? [] : []);
    const r2 = await k.p.mikro.refresh();
    assert.equal(r2.totals.lines.removed, 2, 'iki satir da (SR001.001 + SR002.001) artik gorunmuyor, ikisi de eski isaretlenir');
    assert.equal(k.p.searchOrders({ q: 'SPR-1' }).length, 0, 'silinen siparis artik listede YOK');

    // satirlar SILINMEDI, yalniz stale=1 isaretlendi (markStale'in dosya basindaki ilkesi: "ileride is emirleri
    // bunlara baglanacak" - ham tabloda hala duruyorlar, yalniz orderLines()/searchOrders() artik gostermiyor).
    const ham = k.p.db.db.prepare('SELECT stale FROM order_lines WHERE doc_key = ?').all('SPR-1');
    assert.equal(ham.length, 2);
    assert.equal(ham.every((x) => x.stale === 1), true);
  } finally { k.bitir(); }
});

test('refresh: siparis AYNEN devam ediyorsa (her senkronda da geliyorsa) stale isaretlenmez', async () => {
  const k = kur([satir()]);
  try {
    await k.p.mikro.refresh();
    const r2 = await k.p.mikro.refresh(); // ayni satir yine geliyor
    assert.equal(r2.totals.lines.removed, 0);
    assert.equal(k.p.searchOrders({ q: 'SPR-1' }).length, 1);
  } finally { k.bitir(); }
});

test('refresh: BAZI siparisler kalkar BAZILARI kalirsa yalniz kalkanlar stale isaretlenir', async () => {
  const k = kur([satir(), satir({ Mamul_Kodu: 'SR002.001', Evrak_No: 'SPR-2', Must_Sip_No: 'MS-2' })]);
  try {
    await k.p.mikro.refresh();
    k.client.sqlQuery = async (sql) => (sql.includes('SIPARISLER') ? [satir()] : []); // yalniz SPR-1 kaliyor, SPR-2 kalkti
    const r2 = await k.p.mikro.refresh();
    assert.equal(r2.totals.lines.removed, 1);
    assert.equal(k.p.searchOrders({ q: 'SPR-1' }).length, 1, 'hala gelen siparis listede kalir');
    assert.equal(k.p.searchOrders({ q: 'SPR-2' }).length, 0, 'artik gelmeyen siparis listeden kalkar');
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

test('refresh: Mikro ana veri kaynagi - karttaki deger Mikro\'dan HANGI SEBEPLE olursa olsun farkliysa (elle duzenlenmemisse) HER SENKRONDA Mikro\'ya uyar, "ilk temas" ya da "anlik goruntu" gibi bir ayirim yok', async () => {
  // Gercek olay (2026-11-09, Nİ178.002, kullanici karari): kart eskiden csv-isemri'den brut/net TERS gelmisti ve
  // "Mikro'dan yenile" bunu hicbir zaman duzeltemiyordu, cunku eski kod "Mikro'nun SON gonderdigi deger" (anlik
  // goruntu) ile kiyaslayip "Mikro gercekten degisti mi" diye soruyordu - kart yanlis olsa bile anlik goruntu
  // Mikro'nun GUNCEL degeriyle hep ayni kaliyordu (onceki bir senkronda sessizce oraya yazilmisti), yani soru hep
  // "hayir" cevap veriyordu. Kullanici karari: boyle bir soru SORULMAYACAK - yalniz "kart ile Mikro'nun GUNCEL
  // degeri ayni mi" sorulur, farkliysa (elle duzenlenmemisse) uygulanir. Anlik goruntu mekanizmasi (`src_snapshot`,
  // `getSnapshot`/`setSnapshot`) tamamen kaldirildi; bu artik Nİ178.002 gibi onceden kilitli kartlari da bir
  // dahaki senkronda KENDILIGINDEN duzeltir (elle mudahale gerekmez).
  const k = kur([satir()]);
  try {
    k.p.db.saveProduct('SR001.001', { stockCode: 'SR001.001', grossKg: 0.01, netKg: 0.02 }, { source: 'csv-isemri', by: null, edited: false });

    const res = await k.p.mikro.refresh();
    assert.equal(res.totals.products.updated, 1, 'ilk senkronda duzeltilmis olmali');
    assert.equal(res.totals.products.protected, 0);
    const kart = k.p.getProduct('SR001.001');
    assert.equal(kart.grossKg, 0.02, 'BR'); // satir()'de BR:0,0200
    assert.equal(kart.netKg, 0.01, 'NT');   // satir()'de NT:0,0100

    const res2 = await k.p.mikro.refresh(); // Mikro gercekten degismedi: artik "ayni" oldugu icin bir daha yazilmaz
    assert.equal(res2.totals.products.updated, 0);
  } finally { k.bitir(); }
});

test('refresh: edited=true kart yine de korunur, "korunan" olarak bildirilir (tek istisna, degismedi)', async () => {
  const k = kur([satir()]);
  try {
    k.p.db.saveProduct('SR001.001', { stockCode: 'SR001.001', grossKg: 0.01, netKg: 0.02 }, { source: 'elle', by: 'usta', edited: true });

    const r = await k.p.mikro.refresh();
    assert.equal(r.totals.products.protected, 1);
    assert.deepEqual(r.changes.products.protected[0].stockCode, 'SR001.001');
    const kart = k.p.getProduct('SR001.001');
    assert.equal(kart.grossKg, 0.01, 'elle girilen deger korundu');
    assert.equal(kart.netKg, 0.02, 'elle girilen deger korundu');
  } finally { k.bitir(); }
});

test('refresh: yeni acilan kart Mikro gercekten degismedikce bir sonraki senkronda tekrar yazilmaz (unchanged)', async () => {
  const k = kur([satir()]);
  try {
    await k.p.mikro.refresh(); // kart "added" ile olusur, degerler Mikro'nunkiyle zaten ayni
    const r2 = await k.p.mikro.refresh(); // ayni satirlarla ikinci senkron
    assert.equal(r2.totals.products.updated, 0, 'Mikro gercekten degismedi, tekrar yazilmamali');
    assert.equal(r2.totals.products.added, 0);
    assert.equal(r2.totals.products.protected, 0);
  } finally { k.bitir(); }
});

test('refresh: ayni anda iki senkron 409 busy verir', async () => {
  // refresh() artik SIRAYLA IKI sqlQuery cagrisi yapiyor (SIPARIS_SQL + STOK_SQL, bkz. dosya basi) - her cagri
  // kendi bekleyen Promise'ini kuyruga ekler, biri cozulunce digeri HEMEN acilmayabilir (bir sonraki await'e kadar
  // mikrogorev bekler); bu yuzden tek "cozBekleyeni" yerine bir kuyruk + "birinci tamamlanana kadar coz" dongusu.
  const bekleyenler = [];
  const client = {
    configured: () => true, host: 'x', port: 1,
    sqlQuery: () => new Promise((r) => { bekleyenler.push(() => r([])); }),
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  try {
    const birinci = p.mikro.refresh();
    await assert.rejects(() => p.mikro.refresh(), (e) => e.status === 409 && e.code === 'busy');
    let bitti = false;
    birinci.then(() => { bitti = true; }, () => { bitti = true; });
    while (!bitti) {
      if (bekleyenler.length > 0) bekleyenler.shift()();
      await new Promise((r) => setImmediate(r));
    }
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
