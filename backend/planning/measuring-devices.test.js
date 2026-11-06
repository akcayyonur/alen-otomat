/**
 * Ölçüm cihazları takip (measuring-devices.js, EYS.LS.006): mastar/kumpas/mihengir vb. envanteri + kalibrasyon
 * zamanlaması. `products`/ölçü planıyla HİÇ BAĞLANMAZ. TÜM veriler sentetiktir.
 *
 * Yetki ('olcucihazlari' ekranı read/write, silme/Excel içeri aktarma admin-only) backend/auth/policy.test.js'te
 * sınanır; burada yalnız iş mantığı, kalibrasyon durumu hesabı ve HTTP uçlarının kendisi.
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { calibrationStatus } from './measuring-devices.js';
import { xlsxOf, serial } from './test/xlsx-fixture.js';

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

/* ====================================================================================== kalibrasyon durumu (saf hesap) */

test('kalibrasyon durumu: EYS.LS.006 kosullu bicimlendirmesiyle BIREBIR (ay sinirlari, gun sayisi DEGIL)', () => {
  const now = new Date(2026, 9, 15).getTime(); // 15 Ekim 2026
  // kirmizi: Kasim ayi basindan (1 Kasim) ONCESI -> bu ay icinde ya da gecmis
  assert.equal(calibrationStatus(new Date(2026, 9, 31).getTime(), now), 'kirmizi', '31 Ekim: bu ay icinde');
  assert.equal(calibrationStatus(new Date(2026, 8, 1).getTime(), now), 'kirmizi', 'gecmis tarih');
  // sari: 1 Kasim (dahil) ile 1 Aralik (haric) arasi
  assert.equal(calibrationStatus(new Date(2026, 10, 1).getTime(), now), 'sari', '1 Kasim: tam sinirda, sari');
  assert.equal(calibrationStatus(new Date(2026, 10, 30).getTime(), now), 'sari', '30 Kasim');
  // yesil: 1 Aralik (dahil) ve sonrasi
  assert.equal(calibrationStatus(new Date(2026, 11, 1).getTime(), now), 'yesil', '1 Aralik: tam sinirda, yesil');
  assert.equal(calibrationStatus(new Date(2027, 5, 1).getTime(), now), 'yesil', 'cok ileri tarih');
  // bilinmiyor: tarih yok
  assert.equal(calibrationStatus(null, now), 'bilinmiyor');
});

/* ====================================================================================== CRUD */

test('olustur: yalniz kategori + cihaz tanimi zorunlu; varsayilan kullanilabilir/aktif', () => {
  const p = kur();
  const a = p.measuringDevices.create({ category: 'Mastar', name: '1/2" - 20UNF 2A HALKA' }, { by: 'kalite', now: at(10) });
  assert.equal(a.category, 'Mastar');
  assert.equal(a.name, '1/2" - 20UNF 2A HALKA');
  assert.equal(a.usable, 'kullanilabilir');
  assert.equal(a.active, 'aktif');
  assert.equal(a.calibration, 'bilinmiyor', 'tarih yok -> bilinmiyor');
  assert.throws(() => p.measuringDevices.create({ category: '', name: 'x' }), /kategorisi gerekli/);
  assert.throws(() => p.measuringDevices.create({ category: 'Mastar', name: '' }), /tanımı gerekli/);
  p.close();
});

test('olustur: tum EYS.LS.006 alanlari kaydedilir', () => {
  const p = kur();
  const a = p.measuringDevices.create({
    category: 'Kumpas', trackingNo: '005k-1025-07010', name: 'DİJİTAL KUMPAS', serialNo: 'A24231928', modelBrand: 'MITUTOYO',
    measureRange: '0-150', resolutionMm: '0,01', usable: 'kullanilabilir', lastCalibratedOn: '13.10.2025',
    calibrationCompany: 'EGEMET', nextCalibrationOn: '13.10.2026', department: 'ÜRETİM', heldBy: 'ÜRETİM ORTAK KULLANIM',
    deliveredOn: '16.04.2025', active: 'aktif', issueNote: 'DARBE ALDI', note: 'KULLANIM DIŞI',
  }, { now: at(10) });
  assert.equal(a.resolutionMm, 0.01);
  assert.equal(a.nextCalibrationOn, new Date(2026, 9, 13).getTime());
  assert.equal(a.calibrationCompany, 'EGEMET');
  assert.equal(a.issueNote, 'DARBE ALDI');
  assert.throws(() => p.measuringDevices.create({ category: 'x', name: 'y', usable: 'kirik' }), /Cihaz durumu/);
  assert.throws(() => p.measuringDevices.create({ category: 'x', name: 'y', active: 'belirsiz' }), /Kayıt durumu/);
  p.close();
});

test('duzenle: yalniz gonderilen alanlar degisir', () => {
  const p = kur();
  const a = p.measuringDevices.create({ category: 'Mastar', name: 'x' }, { now: at(10) });
  const r = p.measuringDevices.update(a.id, { nextCalibrationOn: '24.11.2026', calibrationCompany: 'EGEMET' }, { by: 'kalite' });
  assert.equal(r.nextCalibrationOn, new Date(2026, 10, 24).getTime());
  assert.equal(r.calibrationCompany, 'EGEMET');
  assert.equal(r.category, 'Mastar', 'dokunulmayan alan aynen kaldi');
  assert.throws(() => p.measuringDevices.update(9999, { note: 'x' }), /bulunamadı/);
  p.close();
});

test('liste: pasif kayitta kalibrasyon alarmi BASTIRILIR (emeklideki cihaz "zamani gecmis" gormez)', () => {
  const p = kur();
  const gecmis = p.measuringDevices.create({ category: 'Mastar', name: 'eski', nextCalibrationOn: '01.01.2020', active: 'pasif' }, { now: at(10) });
  const r = p.measuringDevices.get(gecmis.id, { now: at(11) });
  assert.equal(r.calibration, 'pasif', 'pasif -> kirmizi degil');
  p.close();
});

test('liste: arama, aktif/pasif ve kalibrasyon durumu suzgeci', () => {
  const p = kur();
  const a = p.measuringDevices.create({ category: 'Mastar', name: '1/2 halka', trackingNo: 'TK-001' }, { now: at(10) });
  const b = p.measuringDevices.create({ category: 'Kumpas', name: 'dijital kumpas', trackingNo: 'TK-002', active: 'pasif' }, { now: at(11) });
  const now = at(12);
  assert.deepEqual(p.measuringDevices.list({ now }).items.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(p.measuringDevices.list({ active: 'aktif', now }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.measuringDevices.list({ active: 'pasif', now }).items.map((x) => x.id), [b.id]);
  assert.deepEqual(p.measuringDevices.list({ q: 'kumpas', now }).items.map((x) => x.id), [b.id]);
  assert.deepEqual(p.measuringDevices.list({ q: 'TK-001', now }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.measuringDevices.list({ calibration: 'bilinmiyor', active: 'aktif', now }).items.map((x) => x.id), [a.id]);
  assert.deepEqual(p.measuringDevices.list({ calibration: 'pasif', now }).items.map((x) => x.id), [b.id]);
  p.close();
});

test('sil: kayit kalkar', () => {
  const p = kur();
  const a = p.measuringDevices.create({ category: 'Mastar', name: 'x' });
  assert.deepEqual(p.measuringDevices.delete(a.id), { ok: true });
  assert.throws(() => p.measuringDevices.get(a.id), /bulunamadı/);
  assert.throws(() => p.measuringDevices.delete(9999), /bulunamadı/);
  p.close();
});

/* ====================================================================================== Excel'den iceri aktarma (EYS.LS.006) */

const DEVICE_HEADERS = [
  'Cihaz Kategorisi', 'Takip No', 'Cihaz Tanımı', 'Mastar Özelliği', 'ARA KONTROL', 'Seri No', 'Model-Marka',
  'Ölçüm Aralığı (mm)', 'Çözünürlük (mm)', 'Sapma Durumu', 'Cihaz Durumu', 'Kalibrasyon Durumu-Tarih',
  'KALİBRASYON FİRMASI', 'Gelecek Kalib.Tarihi', 'Bölüm-Alt Bölüm', 'Teslim Alan Ad & Soyad & İmza', 'Teslim Tarihi',
  'Kalibrasyon Durumu', 'Hata Bilgisi', 'GÜNCEL',
];

function deviceRow({ category = '', trackingNo = '', name = '', gaugeType = '', serialNo = '', modelBrand = '', usable = '', nextCal = null, active = '' } = {}) {
  return [
    category, trackingNo, name, gaugeType, 'OK', serialNo, modelBrand, '0-150', 0.01, '', usable, { s: 2, n: serial(2025, 10, 13) },
    'EGEMET', nextCal, 'KALİTE ODASI - ÜRETİM', 'ASLAN EMRE KILIÇ', { s: 2, n: serial(2025, 12, 8) }, active, '', '',
  ];
}

test('iceri aktarma: baslik gercek Excel gibi 5. satirda (ustunde lejant); satirlar dogru okunur', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      ['LİSTE TAKİP SORUMLUSU', '', '', '', 'DOKÜMAN NO:', '', 'EYS.LS.006'],
      ['KALİTE BÖLÜMÜ', '', '', '', 'YAYIN TARİHİ:'],
      ['', '', '', '', 'GÜNCELLEME TARİHİ:'],
      ['ÖLÇÜM CİHAZLARI TAKİP LİSTESİ'],
      DEVICE_HEADERS,
      deviceRow({ category: 'MASTAR', trackingNo: '113020979', name: '1 1/2 R ISO7 No 3', gaugeType: 'HALKA', usable: 'Kullanılabilir', nextCal: { s: 2, n: serial(2026, 11, 28) }, active: 'AKTİF' }),
      deviceRow({ category: 'KUMPAS', trackingNo: '005k-1025-07010', name: 'DİJİTAL KUMPAS', serialNo: 'A24231928', modelBrand: 'MITUTOYO', usable: 'Kullanılabilir', nextCal: { s: 2, n: serial(2026, 10, 13) }, active: 'AKTİF' }),
    ],
  }]);
  const r = p.measuringDevices.importXlsx(buf, { by: 'kalite', now: at(10) });
  assert.equal(r.total, 2);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.warnings, []);
  const list = p.measuringDevices.list({ now: at(10) }).items;
  assert.equal(list.length, 2);
  const kumpas = list.find((d) => d.category === 'KUMPAS');
  assert.equal(kumpas.name, 'DİJİTAL KUMPAS');
  assert.equal(kumpas.modelBrand, 'MITUTOYO');
  assert.equal(kumpas.nextCalibrationOn, new Date(2026, 9, 13).getTime());
  p.close();
});

test('iceri aktarma: bos satirlar atlanir, kategori/tanim eksik satir uyariyla atlanir, Takip No ile tekrar yukleme ATLAR', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      DEVICE_HEADERS,
      deviceRow({ category: 'MASTAR', trackingNo: 'TK-100', name: 'ürün A' }),
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''], // tamamen bos satir
      deviceRow({ category: '', trackingNo: 'TK-101', name: '' }), // kategori+tanim eksik
      deviceRow({ category: 'KUMPAS', trackingNo: 'TK-102', name: 'ürün B' }),
    ],
  }]);
  const r1 = p.measuringDevices.importXlsx(buf, { now: at(10) });
  assert.equal(r1.total, 2, 'bos satir hic sayilmadi (kategori+tanim ikisi de bos)');
  assert.equal(r1.added, 2);
  assert.equal(r1.skipped, 0);
  assert.equal(p.measuringDevices.list({ now: at(10) }).total, 2);

  // ayni dosya tekrar yuklensin: Takip No'lar zaten kayitli -> HEPSI atlanir, yeni kayit olusmaz
  const r2 = p.measuringDevices.importXlsx(buf, { now: at(11) });
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 2);
  assert.match(r2.warnings[0], /zaten kayıtlı/);
  assert.equal(p.measuringDevices.list({ now: at(10) }).total, 2, 'yineleme yaratilmadi');
  p.close();
});

test('iceri aktarma: baslik bulunamazsa anlasilir hata', () => {
  const p = kur();
  const buf = xlsxOf([{ name: 'Sayfa1', rows: [['A', 'B', 'C'], [1, 2, 3]] }]);
  assert.throws(() => p.measuringDevices.importXlsx(buf), /EYS\.LS\.006/);
  p.close();
});

/* ====================================================================================== HTTP */

test('HTTP: olustur, listele, ayrinti, duzenle, sil, Excel iceri aktar', async () => {
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
    const olustur = await j('/api/planning/devices', 'POST', { category: 'Mastar', name: '1/2" - 20UNF 2A' });
    assert.equal(olustur.status, 201);
    const d = olustur.json;

    const liste = await j('/api/planning/devices');
    assert.equal(liste.json.total, 1);
    assert.equal((await j(`/api/planning/devices/${d.id}`)).json.name, '1/2" - 20UNF 2A');

    const duzenle = await j(`/api/planning/devices/${d.id}`, 'PUT', { nextCalibrationOn: '24.11.2026' });
    assert.equal(duzenle.status, 200);
    assert.equal(duzenle.json.nextCalibrationOn, new Date(2026, 10, 24).getTime());

    assert.equal((await j('/api/planning/devices', 'POST', { category: '', name: 'x' })).status, 400);

    const buf = xlsxOf([{ name: 'Sayfa1', rows: [DEVICE_HEADERS, deviceRow({ category: 'KUMPAS', trackingNo: 'HTTP-1', name: 'http testi' })] }]);
    const rImport = await fetch(`${base}/api/planning/devices/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    assert.equal(rImport.status, 200);
    const importJson = await rImport.json();
    assert.equal(importJson.added, 1);

    assert.equal((await j(`/api/planning/devices/${d.id}`, 'DELETE')).status, 200);
    assert.equal((await j(`/api/planning/devices/${d.id}`)).status, 404);
    assert.equal((await j('/api/planning/devices/99999')).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
