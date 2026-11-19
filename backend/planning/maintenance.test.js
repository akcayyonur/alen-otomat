/**
 * Bakım (maintenance.js, EYS.FR.016 + Bakım Sicil Kartları): makine tipi → bakım kalemi (periyot ADMIN ayarlar)
 * → makine (asset) başına tik/rutin/arızi geçmişi. `products` ile BAĞLANMAZ. TÜM veriler sentetiktir.
 *
 * Yetki ('bakim' ekranı read/write, tip/kalem/makine CRUD + Excel içeri aktarma admin-only) backend/auth/policy.test.js'te
 * sınanır; burada yalnız iş mantığı (periyot ayrıştırma, durum hesabı, CRUD), Excel içeri aktarma ve HTTP uçlarının kendisi.
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { nextDueAt, dueStatus, parsePeriodText, AUTO_PERSON } from './maintenance.js';
import { xlsxOf, serial } from './test/xlsx-fixture.js';

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();
const ms = (y, mo, d, h = 0) => new Date(y, mo - 1, d, h).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

/* ====================================================================================== periyot metni ayrıştırma */

test('parsePeriodText: sicil kartındaki bilinen tüm kalıplar doğru ayrıştırılır', () => {
  assert.deepEqual(parsePeriodText('Her vardiya başlarken'), { periodUnit: 'vardiya', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: 'Her vardiya başlarken' });
  assert.deepEqual(parsePeriodText('Vardiyada 2  kez'), { periodUnit: 'vardiya', periodEvery: 1, timesPerPeriod: 2, anchorMonths: null, timingNote: null });
  assert.deepEqual(parsePeriodText('Günlük'), { periodUnit: 'gun', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: null });
  assert.deepEqual(parsePeriodText('Haftalık'), { periodUnit: 'hafta', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: null });
  assert.deepEqual(parsePeriodText('Aylık'), { periodUnit: 'ay', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: null });
  assert.deepEqual(parsePeriodText('4 aylık\n(Mart - Temmuz -Kasım)'), { periodUnit: 'ay', periodEvery: 4, timesPerPeriod: 1, anchorMonths: [3, 7, 11], timingNote: null });
  assert.deepEqual(parsePeriodText('6 aylık\n(Mart ve Eylül)'), { periodUnit: 'ay', periodEvery: 6, timesPerPeriod: 1, anchorMonths: [3, 9], timingNote: null });
  assert.deepEqual(parsePeriodText('Yıllık\n(Mayıs)'), { periodUnit: 'yil', periodEvery: 1, timesPerPeriod: 1, anchorMonths: [5], timingNote: null });
  assert.deepEqual(parsePeriodText('6 Aylık'), { periodUnit: 'ay', periodEvery: 6, timesPerPeriod: 1, anchorMonths: null, timingNote: null }, 'ay belirtilmeden -> rolling, anchor YOK');
  assert.equal(parsePeriodText('Üç ayda bir'), null, 'taninmayan kalip -> null, asla tahmin edilmez');
});

/* ====================================================================================== durum hesabı (saf) */

test('nextDueAt/dueStatus: GUN (ayrık dönem, grace=0) — yalnız ŞİMDİKİ+ÖNCEKİ güne bakar', () => {
  const item = { periodUnit: 'gun', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null };
  const referenceAt = ms(2026, 9, 1); // makine/kalem cok once var olmus (eski tek bir kacirma sonsuza dek kovalamaz)
  const now = ms(2026, 10, 1, 10); // bugun hic tik yok, ONCEKI gun (30 Eylul) de tiklenmemisti
  const due = nextDueAt(item, [], { referenceAt, now });
  assert.equal(due, ms(2026, 10, 1), 'onceki gun (30 Eylul) kacirildi -> son tarih o gunun sonu (1 Ekim 00:00), zaten gecmis');
  assert.equal(dueStatus(due, 'gun', now), 'gecikti');
  // onceki gun (30 Eylul) tiklenmisse: bugunun kendi sonuna kadar normal
  const due2 = nextDueAt(item, [ms(2026, 9, 30, 14)], { referenceAt, now });
  assert.equal(due2, ms(2026, 10, 2), 'dun yapildi, bugunun sonuna kadar vakit var');
  assert.equal(dueStatus(due2, 'gun', ms(2026, 10, 1, 23)), 'tamam', 'grace=0: gun surerken hala tamam');
  assert.equal(dueStatus(due2, 'gun', ms(2026, 10, 2)), 'gecikti', 'gun bitince gecikti');
  // bugun de tiklenince: nextDueAt yarinin sonuna kayar
  const due3 = nextDueAt(item, [ms(2026, 9, 30, 14), ms(2026, 10, 1, 9)], { referenceAt, now });
  assert.equal(due3, ms(2026, 10, 3));
  assert.equal(dueStatus(due3, 'gun', now), 'tamam');
});

test('nextDueAt/dueStatus: VARDIYA, "vardiyada 2 kez" — o vardiyada ikinci tik gelmeden tamam sayilmaz', () => {
  const item = { periodUnit: 'vardiya', periodEvery: 1, timesPerPeriod: 2, anchorMonths: null };
  const referenceAt = ms(2026, 10, 12, 8); // gunduz vardiyasi icinde (07-19) ise basladi
  const mid = ms(2026, 10, 12, 10); // ayni vardiya suruyor, henuz bitmedi
  const after = ms(2026, 10, 12, 20); // gunduz vardiyasi (19:00) bitti, gece vardiyasindayiz

  const due0 = nextDueAt(item, [], { referenceAt, now: mid });
  assert.equal(due0, ms(2026, 10, 12, 19), 'gunduz vardiyasinin sonu (ONCEKI vardiya referenceAt\'tan once bitti, sayilmaz)');
  assert.equal(dueStatus(due0, 'vardiya', mid), 'tamam', 'vardiya surerken erken degil');
  assert.equal(dueStatus(due0, 'vardiya', after), 'gecikti', 'vardiya bitti, 2 tik tamamlanmadi');

  const due1 = nextDueAt(item, [ms(2026, 10, 12, 9)], { referenceAt, now: mid });
  assert.equal(due1, ms(2026, 10, 12, 19), 'bir tik var ama 2 gerekiyor, ayni pencere');

  const due2 = nextDueAt(item, [ms(2026, 10, 12, 9), ms(2026, 10, 12, 9, 30)], { referenceAt, now: mid });
  assert.equal(due2, ms(2026, 10, 13, 7), 'iki tik tamamlandi, sira bir sonraki (gece) vardiyasinin sonunda');
  assert.equal(dueStatus(due2, 'vardiya', mid), 'tamam');
});

test('nextDueAt/dueStatus: HAFTA (grace=2 gun) — hafta sonuna 2 gun kala sariya doner', () => {
  const item = { periodUnit: 'hafta', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null };
  // 2026-10-12 Pazartesi; hafta [12 Ekim, 19 Ekim) -> son tarih 19 Ekim 00:00. referenceAt bu haftadan ONCE,
  // yani ONCEKI hafta (5-12 Ekim) de gecerli ve BOS -> henuz hafta surerken bile hemen gecikmis gosterilmemeli
  // (onceki hafta de tiklenmediyse "gecikti" dogru, ama biz burada ONCEKI haftayi da tikleyerek normal akisi sinariz).
  const referenceAt = ms(2026, 9, 1);
  const due = nextDueAt(item, [ms(2026, 10, 6)], { referenceAt, now: ms(2026, 10, 13) }); // onceki hafta (5-12 Ekim) tiklendi
  assert.equal(due, ms(2026, 10, 19));
  assert.equal(dueStatus(due, 'hafta', ms(2026, 10, 13)), 'tamam', 'onceki hafta tamamdi, bu hafta daha surerken erken degil');
  assert.equal(dueStatus(due, 'hafta', ms(2026, 10, 17)), 'yaklasiyor', '2 gun kala sari');
  assert.equal(dueStatus(due, 'hafta', ms(2026, 10, 19)), 'gecikti', 'hafta bitti, bu hafta hic tik yok');

  const due2 = nextDueAt(item, [ms(2026, 10, 6), ms(2026, 10, 13)], { referenceAt, now: ms(2026, 10, 16) });
  assert.equal(due2, ms(2026, 10, 26), 'bu hafta tamamlandi, sira bir sonraki haftada');
  assert.equal(dueStatus(due2, 'hafta', ms(2026, 10, 16)), 'tamam');
});

test('nextDueAt: AY + anchorMonths (takvime sabit, "4 aylık Mart-Temmuz-Kasım") — yalnız anchor aylarda due olur', () => {
  const item = { periodUnit: 'ay', periodEvery: 4, timesPerPeriod: 1, anchorMonths: [3, 7, 11] };
  const referenceAt = ms(2026, 1, 1); // Ocak'ta ise baslamis
  assert.equal(nextDueAt(item, [], { referenceAt, now: ms(2026, 1, 15) }), ms(2026, 4, 1), 'Ocak sonrasi ilk anchor Mart, son tarih = Nisan 1 (Mart penceresi biter)');
  // Mart icinde bir kez yapilinca siradaki anchor Temmuz'a kayar
  const doneInMarch = [ms(2026, 3, 10)];
  assert.equal(nextDueAt(item, doneInMarch, { referenceAt, now: ms(2026, 5, 1) }), ms(2026, 8, 1), 'Temmuz penceresi biter = Agustos 1');
});

test('nextDueAt: AY rolling (every=6, anchor YOK, ör. "6 Aylık" yağ değişimi) — son yapılandan 6 ay sonrasi', () => {
  const item = { periodUnit: 'ay', periodEvery: 6, timesPerPeriod: 1, anchorMonths: null };
  const referenceAt = ms(2026, 1, 1);
  assert.equal(nextDueAt(item, [], { referenceAt, now: ms(2026, 1, 15) }), ms(2026, 7, 1), 'hic yapilmadi -> taban andan (referenceAt) itibaren bir donem grace suresi');
  assert.equal(nextDueAt(item, [ms(2026, 2, 10)], { referenceAt, now: ms(2026, 3, 1) }), ms(2026, 8, 10));
});

test('dueStatus: periyot tanımsızsa (periodUnit yok/geçersiz) null döner — asla tahmin edilmez', () => {
  assert.equal(nextDueAt({ periodUnit: null }, [], { referenceAt: 0 }), null);
  assert.equal(dueStatus(null, 'gun'), null);
});

/* ====================================================================================== tip / kalem / makine CRUD */

test('tip: ad zorunlu ve benzersiz; silme makinesi varsa reddedilir', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { by: 'admin', now: at(10) });
  assert.throws(() => p.maintenance.createType({ name: 'cnc torna' }), /zaten var/, 'Turkce katlamali karsilastirma (foldTr)');
  p.maintenance.createAsset({ typeId: t.id, sicilNo: 'BS.001' }, { now: at(10) });
  assert.throws(() => p.maintenance.deleteType(t.id), /makine var/);
  p.close();
});

test('kalem: periyot birimi gecerli olmali; anchorMonths 1-12 disinda reddedilir', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'Kompresör' }, { now: at(10) });
  assert.throws(() => p.maintenance.createItem(t.id, { description: 'x', periodUnit: 'saat' }), /vardiya\/gun\/hafta\/ay\/yil/);
  assert.throws(() => p.maintenance.createItem(t.id, { description: 'x', periodUnit: 'ay', anchorMonths: [13] }), /1-12/);
  const it = p.maintenance.createItem(t.id, { description: 'Yağ değişimi', periodUnit: 'ay', periodEvery: 6 }, { now: at(10) });
  assert.equal(it.periodEvery, 6);
  assert.equal(it.requiresNote, 'hayir', 'varsayilan');
  p.close();
});

test('kalem: tik/log gecmisi olan kalem SILINEMEZ (pasif yapilabilir)', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'Kompresör' }, { now: at(10) });
  const it = p.maintenance.createItem(t.id, { description: 'Yağ değişimi', periodUnit: 'ay' }, { now: at(10) });
  const a = p.maintenance.createAsset({ typeId: t.id }, { now: at(10) });
  p.maintenance.addLog(a.id, { itemId: it.id, doneOn: at(10) }, { by: 'usta', now: at(10) });
  assert.throws(() => p.maintenance.deleteItem(it.id), /pasif/);
  const pasif = p.maintenance.updateItem(it.id, { active: 'pasif' });
  assert.equal(pasif.active, 'pasif');
  p.close();
});

test('makine: sicil no benzersiz; gecmisi olan makine SILINEMEZ', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: at(10) });
  const a = p.maintenance.createAsset({ typeId: t.id, sicilNo: 'BS.001', assetNo: '5', brand: 'HUMMER' }, { now: at(10) });
  assert.throws(() => p.maintenance.createAsset({ typeId: t.id, sicilNo: 'bs.001' }), /zaten kayıtlı/);
  assert.throws(() => p.maintenance.createAsset({ typeId: 9999 }), /bulunamadı/);
  const it = p.maintenance.createItem(t.id, { description: 'x', periodUnit: 'gun' }, { now: at(10) });
  p.maintenance.addLog(a.id, { itemId: it.id, doneOn: at(10) }, { now: at(10) });
  assert.throws(() => p.maintenance.deleteAsset(a.id), /pasif/);
  p.close();
});

/* ====================================================================================== log ekleme kuralları */

test('log: tik (itemId ile) kind=kontrol olmali; serbest kayit (itemId yok) rutin/arizi olmali', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: at(10) });
  const it = p.maintenance.createItem(t.id, { description: 'x', periodUnit: 'gun' }, { now: at(10) });
  const a = p.maintenance.createAsset({ typeId: t.id }, { now: at(10) });
  assert.throws(() => p.maintenance.addLog(a.id, { itemId: it.id, kind: 'rutin' }), /kontrol.*olmalı/);
  assert.throws(() => p.maintenance.addLog(a.id, { kind: 'kontrol' }), /rutin.*arizi/);
  assert.throws(() => p.maintenance.addLog(a.id, { kind: 'rutin' }), /firma ya da açıklama/);
  const log = p.maintenance.addLog(a.id, { kind: 'rutin', company: 'DIŞ FİRMA' }, { by: 'usta', now: at(10) });
  assert.equal(log.kind, 'rutin');
  assert.equal(log.person, 'usta');
  const tik = p.maintenance.addLog(a.id, { itemId: it.id }, { by: 'usta', now: at(10) });
  assert.equal(tik.kind, 'kontrol');
  assert.equal(tik.doneOn, new Date(at(10)).setHours(0, 0, 0, 0), 'tarih verilmezse bugunun gece yarisi');
  p.close();
});

test('log: baska tipe ait bir kalem bu makineye tiklenemez', () => {
  const p = kur();
  const t1 = p.maintenance.createType({ name: 'CNC Torna' }, { now: at(10) });
  const t2 = p.maintenance.createType({ name: 'Kompresör' }, { now: at(10) });
  const it2 = p.maintenance.createItem(t2.id, { description: 'x', periodUnit: 'gun' }, { now: at(10) });
  const a1 = p.maintenance.createAsset({ typeId: t1.id }, { now: at(10) });
  assert.throws(() => p.maintenance.addLog(a1.id, { itemId: it2.id }), /tipine ait değil/);
  p.close();
});

/* ====================================================================================== genel görünüm (overview) */

test('overview: durum hesaplanir, arama suzer, en kotu durum tip/makine seviyesine yukarı taşır', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: at(10) });
  const it1 = p.maintenance.createItem(t.id, { description: 'Günlük kontrol', periodUnit: 'gun' }, { now: ms(2026, 10, 1) });
  const a1 = p.maintenance.createAsset({ typeId: t.id, sicilNo: 'BS.001', brand: 'HUMMER' }, { now: ms(2026, 10, 1) });
  const a2 = p.maintenance.createAsset({ typeId: t.id, sicilNo: 'BS.002', brand: 'ARİX' }, { now: ms(2026, 10, 1) });
  p.maintenance.addLog(a1.id, { itemId: it1.id, doneOn: ms(2026, 10, 12) }, { now: ms(2026, 10, 12) });
  const now = ms(2026, 10, 12, 10);
  const ov = p.maintenance.overview({ now });
  assert.equal(ov.types.length, 1);
  const ty = ov.types[0];
  assert.equal(ty.assets.length, 2);
  const a1out = ty.assets.find((x) => x.id === a1.id);
  const a2out = ty.assets.find((x) => x.id === a2.id);
  assert.equal(a1out.items[0].status, 'tamam', 'bugun tiklendi');
  assert.equal(a2out.items[0].status, 'gecikti', 'hic tiklenmedi');
  assert.equal(a1out.worstStatus, 'tamam');
  assert.equal(a2out.worstStatus, 'gecikti');
  assert.equal(ty.worstStatus, 'gecikti', 'tip seviyesi en kotu makineyi yansitir');
  assert.deepEqual(p.maintenance.overview({ q: 'ARİX', now }).types[0].assets.map((a) => a.id), [a2.id]);
  assert.equal(p.maintenance.overview({ q: 'olmayan-makine', now }).types.length, 0);
  p.close();
});

/* ====================================================================================== Excel'den iceri aktarma */

/** BS.001'in gerçek sütun yerleşimini birebir izleyen sentetik bir sicil kartı sayfası (A=0..J=9). */
function bakimKartiRows({ typeName, sicilNo, assetNo, brand, model, motorKw = 7.5, items }) {
  return [
    [null, null, 'MAKİNE / CİHAZ SİCİL KARTI', null, null, null, null, null, 'Yayın Tarihi: ', null, { s: 2, n: serial(2024, 9, 25) }],
    [null, null, null, null, null, null, null, null, 'Revizyon Tarihi: ', null, { s: 2, n: serial(2026, 1, 23) }],
    [null, null, null, null, null, null, null, null, 'Rev. No:', null, 4],
    ['MAKİNE / CİHAZ TANIMI:', null, null, typeName, null, null, null, null, `Sicil No:  ${sicilNo}`],
    ['MAKİNE / CİHAZ NUMARASI:', null, null, assetNo, null, 'MOTOR GÜCÜ:', null, motorKw, null, 'KW'],
    ['MARKA:', brand, null, null, null, 'MODEL:', model],
    ['ÜRETİM TARİHİ:', null, null, null, null, 'SATINALMA TARİHİ:', null, null, 'EYLÜL 2024'],
    ['NOT:'],
    ['MAKİNA İLE İLGİLİ ACİL DURUMDA ARANACAK KİŞİ: ÜRETİM SORUMLUSU'],
    ['YAPILACAK BAKIM', null, null, null, null, 'PERİYODU', null, 'SORUMLU', null, 'KAYDEDİLECEĞİ YER'],
    ...items.map(([desc, periyodu, sorumlu, kayit]) => [desc, null, null, null, null, periyodu, null, sorumlu, null, kayit]),
    [`(!): Değişim ve müdahale olması durumunda kayıt tutulur. Yapılan işlemler "Rutin Bakım Kaydı" bölümüne kaydedilir.`],
    ['HAZIRLAYAN'],
  ];
}

const CNC_ITEMS = [
  ['Takım tutucuları ve kesme ucunun sağlamlık kontrolü (!)', 'Her vardiya başlarken', 'CNC Operatörü', "Değişim yapılırsa\nEYS.FR.016'ya not edilir"],
  ['Tezgah içindeki Talaşın temizlenmesi', 'Vardiyada 2  kez', 'CNC Operatörü', 'Kayıt tutulmaz'],
  ['Hava Filtrelerinin ve Soğutucu fanlarının hava ile temizlenmesi', 'Haftalık', 'Bakım Operatörü', 'EYS.FR.016 Bakım Kayıt Formu'],
  ['Kızakların sıkılıp vidalı millerin temizlenmesi', 'Aylık', 'Bakım Operatörü', 'EYS.FR.016 Bakım Kayıt Formu'],
  ['Rulman kontrolü varsa dağılmış olanın değiştirilmesi', '4 aylık\n(Mart - Temmuz -Kasım)', 'Bakım Operatörü', 'EYS.FR.016 Bakım Kayıt Formu'],
  ['Sürücü yataklarının sağlamlık kontrolü', '6 aylık\n(Mart ve Eylül)', 'Bakım Operatörü', 'EYS.FR.016 Bakım Kayıt Formu'],
  ['Hidrolik basınç yağının değiştirilmesi', 'Yıllık\n(Mayıs)', 'Bakım Operatörü', 'EYS.FR.016 Bakım Kayıt Formu'],
];

test('iceri aktarma: 2 CNC torna sayfasi AYNI tipi paylasir — kalemler yalniz İLK sayfadan olusur', () => {
  const p = kur();
  const buf = xlsxOf([
    { name: 'BS.001', rows: bakimKartiRows({ typeName: 'CNC TORNA ', sicilNo: 'BS.001', assetNo: '- 5 -', brand: 'HUMMER', model: 'T - 42 CL', items: CNC_ITEMS }) },
    { name: 'BS.002', rows: bakimKartiRows({ typeName: 'CNC TORNA ', sicilNo: 'BS.002', assetNo: '- 2 -', brand: 'HUMMER', model: 'T - 42 CL', items: CNC_ITEMS }) },
  ]);
  const r = p.maintenance.importXlsx(buf, { by: 'kurulum', now: at(10) });
  assert.equal(r.totalSheets, 2);
  assert.equal(r.addedTypes, 1, 'CNC TORNA tipi bir kez olustu');
  assert.equal(r.addedAssets, 2);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.warnings, []);

  const ov = p.maintenance.overview({ now: at(10) });
  assert.equal(ov.types.length, 1);
  const ty = ov.types[0];
  assert.equal(ty.name, 'CNC TORNA', 'baştaki/sondaki boşluk kırpıldı (text() trim)');
  assert.equal(ty.items.length, 7, 'kalemler yalnız BİR kez olustu (2. sayfa tekrar yaratmadi)');
  assert.equal(ty.assets.length, 2);
  const a1 = ty.assets.find((a) => a.sicilNo === 'BS.001');
  assert.equal(a1.brand, 'HUMMER');
  assert.equal(a1.motorPowerKw, 7.5);
  assert.equal(a1.items.length, 7, 'her makine tipin TÜM kalemlerini gorur');
  const rulman = a1.items.find((i) => i.description.startsWith('Rulman'));
  assert.deepEqual(rulman.anchorMonths, [3, 7, 11]);
  assert.equal(rulman.periodEvery, 4);

  // ayni dosya tekrar yuklenirse: sicil no'lar zaten kayitli -> hepsi atlanir
  const r2 = p.maintenance.importXlsx(buf, { now: at(11) });
  assert.equal(r2.addedAssets, 0);
  assert.equal(r2.skipped, 2);
  assert.match(r2.warnings[0], /zaten kayıtlı/);
  p.close();
});

test('iceri aktarma: taninmayan periyot metni UYARIYLA iceri alinir, sessizce tahmin edilmez', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'BS.999',
    rows: bakimKartiRows({
      typeName: 'YIKAMA MAKİNESİ', sicilNo: 'BS.999', assetNo: 'Y1', brand: 'KROMAŞ', model: 'VRX',
      items: [['Hortum temizliği', 'Üç ayda bir', 'CNC Operatörü', 'Kayıt tutulmaz']],
    }),
  }]);
  const r = p.maintenance.importXlsx(buf, { now: at(10) });
  assert.equal(r.addedAssets, 1);
  assert.match(r.warnings[0], /tanınmadı/);
  const ty = p.maintenance.overview({ now: at(10) }).types[0];
  assert.equal(ty.items[0].periodUnit, 'gun', 'elle duzeltilene kadar guvenli bir varsayilan');
  p.close();
});

test('iceri aktarma: bakim tablosu bulunamazsa uyari verir ama makineyi yine de ekler', () => {
  const p = kur();
  const buf = xlsxOf([{ name: 'Boş', rows: [['MAKİNE / CİHAZ TANIMI:', null, null, 'KOMPRESÖR'], ['Sicil No:  BS.900']] }]);
  const r = p.maintenance.importXlsx(buf, { now: at(10) });
  assert.equal(r.addedAssets, 1);
  assert.match(r.warnings.join(' '), /bakım kalemleri tablosu/);
  p.close();
});

/* ====================================================================================== otomatik tik */
/* Kullanıcı bulgusu (2026-11-19): usta bu ekranı günlük kullanmıyor, tikler yalnız denetimde dolduruluyordu.
 * Çözüm: vade gelince sistem HER MAKİNE için BAĞIMSIZ rastgele bir anda kendisi "kontrol" tiki atar; anahtar
 * (varsayılan AÇIK) Bakım ekranının üst çubuğundan (yalnız admin) kapatılabilir. Bkz. CLAUDE.md §6. */

test('otomatik tik: ayar hiç ayarlanmamışsa VARSAYILAN AÇIK, anahtar kapat/aç round-trip', () => {
  const p = kur();
  assert.equal(p.maintenance.autoTickEnabled(), true, 'ozelligin asil amaci bu, varsayilan ACIK');
  assert.deepEqual(p.maintenance.setAutoTickEnabled(false), { enabled: false });
  assert.equal(p.maintenance.autoTickEnabled(), false);
  assert.deepEqual(p.maintenance.setAutoTickEnabled(true), { enabled: true });
  assert.equal(p.maintenance.autoTickEnabled(), true);
  p.close();
});

test('otomatik tik: kalemin vadesi henüz gelmemişse (durum tamam) hiçbir şey PLANLANMAZ', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'Kompresör' }, { now: at(10) });
  p.maintenance.createItem(t.id, { description: 'Yağ değişimi', periodUnit: 'yil', periodEvery: 5 }, { now: at(10) });
  p.maintenance.createAsset({ typeId: t.id }, { now: at(10) });
  const r = p.maintenance.runAutoTick({ now: at(10) + 86_400_000, random: () => { throw new Error('cekilis olmamali'); } });
  assert.deepEqual(r, { scheduled: 0, fired: 0 });
  assert.equal(p.maintenance.db.prepare('SELECT COUNT(*) c FROM maintenance_auto_queue').get().c, 0);
  p.close();
});

test('otomatik tik: anahtar KAPALIYSA ne yeni bir an PLANLANIR ne de bekleyen bir plan ATEŞLENİR', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: ms(2026, 10, 1) });
  const it = p.maintenance.createItem(t.id, { description: 'Günlük kontrol', periodUnit: 'gun' }, { now: ms(2026, 10, 1) });
  const a = p.maintenance.createAsset({ typeId: t.id }, { now: ms(2026, 10, 1) });
  const now0 = ms(2026, 10, 3, 10); // onceki gun kacirildi, zaten gecikmis

  // once ACIKKEN bir hedef planlanir
  p.maintenance.runAutoTick({ now: now0, random: () => 0.01 });
  assert.equal(p.maintenance.db.prepare('SELECT COUNT(*) c FROM maintenance_auto_queue').get().c, 1);

  // ...sonra anahtar KAPATILIR: hedef anina gelinse bile ATESLENMEZ
  p.maintenance.setAutoTickEnabled(false);
  const target = Number(p.maintenance.db.prepare('SELECT target_at FROM maintenance_auto_queue').get().target_at);
  const r = p.maintenance.runAutoTick({ now: target + 1000 });
  assert.deepEqual(r, { scheduled: 0, fired: 0 }, 'kapaliyken hicbir sey yapilmaz');
  assert.equal(p.maintenance.listLogs(a.id, { itemId: it.id }).length, 0, 'gercek bir tik OLUSMADI');

  // kapaliyken, henuz hic planlanmamis BASKA bir kalem icin de yeni bir plan OLUSMAZ
  const it2 = p.maintenance.createItem(t.id, { description: 'Talas temizligi', periodUnit: 'gun' }, { now: ms(2026, 10, 1) });
  p.maintenance.runAutoTick({ now: target + 2000 });
  assert.equal(p.maintenance.db.prepare('SELECT COUNT(*) c FROM maintenance_auto_queue WHERE item_id = ?').get(it2.id).c, 0);
  p.close();
});

test('otomatik tik: vade gelince HER MAKİNE için BAĞIMSIZ rastgele bir an planlanır, hedefe kadar ateşlenmez, hedeften sonra GERÇEK bir tik oluşur', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: ms(2026, 10, 1) });
  const it = p.maintenance.createItem(t.id, { description: 'Günlük kontrol', periodUnit: 'gun' }, { now: ms(2026, 10, 1) });
  const a1 = p.maintenance.createAsset({ typeId: t.id, sicilNo: 'BS.001' }, { now: ms(2026, 10, 1) });
  const a2 = p.maintenance.createAsset({ typeId: t.id, sicilNo: 'BS.002' }, { now: ms(2026, 10, 1) });

  const now0 = ms(2026, 10, 3, 10);
  const due = ms(2026, 10, 3); // onceki gun kacirildi, zaten gecikmis (grace=0 -> yakalama penceresi devrede)
  const windowMs = 6 * 3_600_000; // yakalama penceresi (AUTO_CATCHUP_MAX_MS)
  const fracs = [0.1, 0.9]; // asset1, asset2 - HER MAKINE icin AYRI cekilis
  let callIdx = 0;
  const seq = () => fracs[callIdx++];

  const r1 = p.maintenance.runAutoTick({ now: now0, random: seq });
  assert.deepEqual(r1, { scheduled: 2, fired: 0 }, 'iki makine de gecikmis -> ikisi de planlanir, henuz hicbiri ateslenmez');

  const rows = p.maintenance.db.prepare('SELECT * FROM maintenance_auto_queue ORDER BY asset_id').all();
  assert.equal(rows.length, 2);
  const row1 = rows.find((x) => Number(x.asset_id) === a1.id);
  const row2 = rows.find((x) => Number(x.asset_id) === a2.id);
  assert.equal(Number(row1.due_at), due);
  assert.equal(Number(row1.target_at), now0 + Math.floor(0.1 * windowMs));
  assert.equal(Number(row2.target_at), now0 + Math.floor(0.9 * windowMs));
  assert.notEqual(Number(row1.target_at), Number(row2.target_at), 'her makine BAGIMSIZ rastgele bir an aliyor, ayni saniyeye senkronlanmiyor');

  // ayni "now"da ikinci cagri: hicbiri henuz hedef anina gelmedi -> ne yeni planlama ne atesleme (cekilis de hic yapilmaz)
  const r2 = p.maintenance.runAutoTick({ now: now0, random: () => { throw new Error('yeni cekilis olmamali'); } });
  assert.deepEqual(r2, { scheduled: 0, fired: 0 });
  assert.equal(p.maintenance.listLogs(a1.id, { itemId: it.id }).length, 0, 'hedef anina kadar GERCEK bir tik olusmaz');

  // asset1'in hedef anina gelince GERCEK bir tik olusur ('kontrol', kayit sahibi 'Otomatik'); asset2 hala bekliyor
  const afterTarget1 = Number(row1.target_at) + 1;
  const r3 = p.maintenance.runAutoTick({ now: afterTarget1 });
  assert.deepEqual(r3, { scheduled: 0, fired: 1 });
  const logs1 = p.maintenance.listLogs(a1.id, { itemId: it.id });
  assert.equal(logs1.length, 1);
  assert.equal(logs1[0].kind, 'kontrol');
  assert.equal(logs1[0].person, AUTO_PERSON);
  assert.equal(p.maintenance.listLogs(a2.id, { itemId: it.id }).length, 0, 'asset2 hedefi henuz gelmedi');

  // asset2'nin hedef anina gelince o da ateslenir
  const afterTarget2 = Number(row2.target_at) + 1;
  const r4 = p.maintenance.runAutoTick({ now: afterTarget2 });
  assert.equal(r4.fired, 1);
  assert.equal(p.maintenance.listLogs(a2.id, { itemId: it.id })[0].person, AUTO_PERSON);
  p.close();
});

test('otomatik tik: henüz VADESİ GELMEMİŞ ama grace penceresine girmiş kalem için hedef [şu an, vade] aralığında seçilir (yakalama penceresiyle SINIRLI DEĞİL)', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: ms(2026, 1, 1) });
  const it = p.maintenance.createItem(t.id, { description: 'Haftalık temizlik', periodUnit: 'hafta' }, { now: ms(2026, 1, 1) });
  const a = p.maintenance.createAsset({ typeId: t.id }, { now: ms(2026, 1, 1) });
  p.maintenance.addLog(a.id, { itemId: it.id, doneOn: ms(2026, 10, 6) }, { now: ms(2026, 10, 6) }); // onceki hafta (5-12 Ekim) yapildi

  const now0 = ms(2026, 10, 17); // bu hafta [12-19 Ekim), vadeye (19 Ekim 00:00) 2 gun kala -> 'yaklasiyor'
  const due = ms(2026, 10, 19);
  const r = p.maintenance.runAutoTick({ now: now0, random: () => 0.25 });
  assert.deepEqual(r, { scheduled: 1, fired: 0 });
  const row = p.maintenance.db.prepare('SELECT * FROM maintenance_auto_queue WHERE asset_id = ? AND item_id = ?').get(a.id, it.id);
  assert.equal(Number(row.due_at), due);
  assert.equal(Number(row.target_at), now0 + Math.floor(0.25 * (due - now0)), 'hedef su andan vadeye kadar olan araliktan secilir, 6 saatlik yakalama penceresi burada devrede DEGIL');
  p.close();
});

test('otomatik tik: eski (ateşlenmiş / yetim) kuyruk satırları zamanla temizlenir', () => {
  const p = kur();
  const t = p.maintenance.createType({ name: 'CNC Torna' }, { now: at(10) });
  const it = p.maintenance.createItem(t.id, { description: 'Yıllık bakım', periodUnit: 'yil', periodEvery: 5 }, { now: at(10) });
  const a = p.maintenance.createAsset({ typeId: t.id }, { now: at(10) });
  const now0 = at(10);
  // elle eski bir "ateslenmis" ve bir de "ateslenmemis/yetim" (usta elle tikleyince due_at'i gecersizlesen) satir ekle
  p.maintenance.db.prepare('INSERT INTO maintenance_auto_queue (asset_id, item_id, due_at, target_at, fired_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(a.id, it.id, now0 - 1000, now0 - 1000, now0 - 1000, now0 - 1000);
  p.maintenance.db.prepare('INSERT INTO maintenance_auto_queue (asset_id, item_id, due_at, target_at, fired_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(a.id, it.id, now0 - 2000, now0 - 2000, null, now0 - 2000);
  assert.equal(p.maintenance.db.prepare('SELECT COUNT(*) c FROM maintenance_auto_queue').get().c, 2);
  const far = now0 + 500 * 86_400_000; // 500 gun sonra: ikisi de esigi asar (ateslenmis: 400 gun, yetim: 30 gun)
  const r = p.maintenance.runAutoTick({ now: far });
  assert.deepEqual(r, { scheduled: 0, fired: 0 }, 'bu kalem 5 yillik periyotla hala TAMAM (500 gun < 5 yil), hicbir sey planlanmaz/ateslenmez');
  assert.equal(p.maintenance.db.prepare('SELECT COUNT(*) c FROM maintenance_auto_queue').get().c, 0, 'iki eski satir da temizlendi');
  p.close();
});

test('HTTP: otomatik tik anahtarı GET/PUT', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const g1 = await fetch(`${base}/api/planning/maintenance/auto-tick`);
    assert.equal(g1.status, 200);
    assert.deepEqual(await g1.json(), { enabled: true });
    const put = await fetch(`${base}/api/planning/maintenance/auto-tick`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { enabled: false });
    const g2 = await fetch(`${base}/api/planning/maintenance/auto-tick`);
    assert.deepEqual(await g2.json(), { enabled: false });
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

/* ====================================================================================== HTTP */

test('HTTP: tip/kalem/makine olustur, genel gorunum, tik at, gecmis, Excel iceri aktar', async () => {
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
    const tip = await j('/api/planning/maintenance/types', 'POST', { name: 'Kompresör' });
    assert.equal(tip.status, 201);
    const kalem = await j(`/api/planning/maintenance/types/${tip.json.id}/items`, 'POST', { description: 'Yağ değişimi', periodUnit: 'ay', periodEvery: 6 });
    assert.equal(kalem.status, 201);
    const makine = await j('/api/planning/maintenance/assets', 'POST', { typeId: tip.json.id, sicilNo: 'BS.008', brand: 'EKOMAK' });
    assert.equal(makine.status, 201);

    const ov = await j('/api/planning/maintenance');
    assert.equal(ov.json.types.length, 1);
    assert.equal(ov.json.types[0].assets[0].items[0].status, 'tamam', 'yeni eklenen kalem/makineye grace suresi taninir');

    const tikKayit = await j(`/api/planning/maintenance/assets/${makine.json.id}/logs`, 'POST', { itemId: kalem.json.id, doneOn: '12.10.2026' });
    assert.equal(tikKayit.status, 201);
    const ov2 = await j('/api/planning/maintenance');
    assert.equal(ov2.json.types[0].assets[0].items[0].status, 'tamam');

    const gecmis = await j(`/api/planning/maintenance/assets/${makine.json.id}/logs?itemId=${kalem.json.id}`);
    assert.equal(gecmis.json.items.length, 1);

    const buf = xlsxOf([{ name: 'BS.900', rows: bakimKartiRows({ typeName: 'KOMPRESÖR', sicilNo: 'BS.900', assetNo: 'KOM3', brand: 'EKOMAK', model: 'X', items: [['Hava filtresi', 'Haftalık', 'Bakım Operatörü', 'Kayıt tutulmaz']] }) }]);
    const rImport = await fetch(`${base}/api/planning/maintenance/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    assert.equal(rImport.status, 200);
    assert.equal((await rImport.json()).addedAssets, 1);

    assert.equal((await j(`/api/planning/maintenance/assets/${makine.json.id}`, 'DELETE')).status, 409, 'gecmisi var, silinemez');
    assert.equal((await j('/api/planning/maintenance/assets/99999', 'PUT', { brand: 'x' })).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
