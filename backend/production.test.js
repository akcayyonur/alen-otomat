/**
 * Uretim adedi: vardiya sinirlari, parca sayaci izleyicisi, kalici olaylar, rapor toplamlari ve CSV.
 * Saatler YEREL saatle kurulur (vardiyalar yerel saattir), bu yuzden test saat diliminden bagimsizdir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTelemetry } from '../shared/schema.js';
import { shiftOf, productionDate, shiftWindows, addDays, parseDateKey, daysBetween } from '../shared/shifts.js';
import { PartTracker } from './production.js';
import { TelemetryDb } from './db.js';
import { TelemetryStore } from './store.js';
import { buildReport, aggregate, resolveRange, reportCsv, compactMachineCsv, MAX_REPORT_DAYS } from './production-report.js';

const SN = 1000;
const yerel = (g, a, y, sa, dk = 0, sn = 0) => new Date(y, a - 1, g, sa, dk, sn).getTime();

/* ------------------------------------------------------------ vardiyalar */

test('vardiya: 07-19 gunduz, 19-07 gece; gece vardiyasi basladigi gunun sayilir', () => {
  const k = (...a) => { const w = shiftOf(yerel(...a)); return `${w.date} ${w.id}`; };
  assert.equal(k(12, 10, 2026, 6, 59, 59), '2026-10-11 gece', '06:59 hala onceki gunun gecesi');
  assert.equal(k(12, 10, 2026, 7, 0, 0), '2026-10-12 gunduz', '07:00 gunduz baslar');
  assert.equal(k(12, 10, 2026, 18, 59, 59), '2026-10-12 gunduz');
  assert.equal(k(12, 10, 2026, 19, 0, 0), '2026-10-12 gece', '19:00 gece baslar');
  assert.equal(k(12, 10, 2026, 23, 59, 59), '2026-10-12 gece');
  assert.equal(k(13, 10, 2026, 0, 30), '2026-10-12 gece', 'gece yarisi gecince de ayni gece');
  assert.equal(productionDate(yerel(13, 10, 2026, 3)), '2026-10-12');
  // ay ve yil sinirlari
  assert.equal(shiftOf(yerel(1, 1, 2027, 2)).date, '2026-12-31');
  assert.equal(shiftOf(yerel(1, 11, 2026, 5)).date, '2026-10-31');
});

test('vardiya: pencere sinirlari 12 saat, ardisik ve bosluksuz', () => {
  const ws = shiftWindows('2026-10-12', '2026-10-13');
  assert.equal(ws.length, 4);
  for (let i = 0; i < ws.length; i += 1) {
    assert.equal(ws[i].toMs - ws[i].fromMs, 12 * 3_600_000);
    if (i > 0) assert.equal(ws[i].fromMs, ws[i - 1].toMs, 'bosluk/cakisma yok');
  }
  assert.equal(ws[0].fromMs, yerel(12, 10, 2026, 7));
  assert.equal(ws[1].toMs, yerel(13, 10, 2026, 7));
});

test('tarih yardimcilari: gecersiz tarih reddedilir, gun ekleme ay sinirini gecer', () => {
  assert.equal(parseDateKey('2026-02-30'), null);
  assert.equal(parseDateKey('2026-10-12 '), null);
  assert.equal(parseDateKey('12.10.2026'), null);
  assert.deepEqual(parseDateKey('2026-10-12'), { y: 2026, m: 10, d: 12 });
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 31);
});

/* ------------------------------------------------------- parca izleyicisi */

let n = 0;
/** Normalize mesaj (alan adlari sema ile ayni). */
function mesaj(ts, o = {}) {
  n += 1;
  return {
    machineId: o.machineId ?? 'CNC-01',
    ts: new Date(ts).toISOString(),
    status: o.status ?? 'RUNNING',
    partTotal: 'total' in o ? o.total : 1000,
    partCount: 'count' in o ? o.count : 10,
    program: 'program' in o ? o.program : 'P1',
    mainProgram: 'main' in o ? o.main : 'P1',
    cycleTimeSec: 'cycle' in o ? o.cycle : null,
    _n: n,
  };
}

const T0 = yerel(12, 10, 2026, 8, 0, 0);

test('izleyici: sayac artisi olay uretir; ilk mesaj yalniz taban kurar', () => {
  const t = new PartTracker();
  assert.equal(t.observe(mesaj(T0, { total: 1000, count: 10 })), null, 'taban');
  assert.equal(t.observe(mesaj(T0 + SN, { total: 1000, count: 10 })), null, 'degisim yok');
  const ev = t.observe(mesaj(T0 + 2 * SN, { total: 1001, count: 11 }));
  assert.equal(ev.qty, 1);
  assert.equal(ev.program, 'P1');
  assert.equal(ev.machineId, 'CNC-01');
  assert.equal(ev.ts, T0 + 2 * SN);
  assert.equal(ev.partTotal, 1001);
  assert.equal(ev.suspect, false);
  assert.equal(ev.gapMs, 0);
});

test('izleyici: program ana programdan alinir; alt programa gecici gecis parcayi bolmez', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { program: 'O9001', main: 'P7' }));
  const ev = t.observe(mesaj(T0 + SN, { total: 1001, count: 11, program: 'O9001', main: 'P7' }));
  assert.equal(ev.program, 'P7', 'ana program, alt program degil');
  // ana program yoksa calisan program
  const u = new PartTracker();
  u.observe(mesaj(T0, { program: 'P9', main: null }));
  assert.equal(u.observe(mesaj(T0 + SN, { total: 1001, count: 11, program: 'P9', main: null })).program, 'P9');
});

test('izleyici: ayni mesajda program degistiyse parca ESKI programindir', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { program: 'A', main: 'A' }));
  const ev = t.observe(mesaj(T0 + SN, { total: 1001, count: 11, program: 'B', main: 'B' }));
  assert.equal(ev.program, 'A');
  // sonraki parca yeni programin
  const ev2 = t.observe(mesaj(T0 + 30 * SN, { total: 1002, count: 12, program: 'B', main: 'B' }));
  assert.equal(ev2.program, 'B');
});

test('izleyici: sayac geri giderse (operator sifirladi) adet sayilmaz, taban yenilenir', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { total: 1000, count: 10 }));
  assert.equal(t.observe(mesaj(T0 + SN, { total: 0, count: 0 })), null);
  const ev = t.observe(mesaj(T0 + 30 * SN, { total: 1, count: 1 }));
  assert.equal(ev.qty, 1, 'sifirlamadan sonraki parca sayilir');
});

/**
 * Vardiya basinda operator "Parca"yi 0'a ceker. Iki vardiya (130 + 140 parca) boyunca akisi kurar ve SAYILAN adedi dondurur.
 * `toplam`: omur boyu sayac akar mi (fabrikadaki gercek durum) ya da okunamaz (null).
 * `aninda`: sifirlama aninda bir parca daha bitti; `kopukluk`: sifirlama veri kopuklugunda oldu (arada `kopukSn` sn ajan yok).
 */
function sifirlamaAkisi({ toplam = true, aninda = false, kopukSn = 0 } = {}) {
  const t = new PartTracker({ gapMs: 10_000 });
  const T = 5000;
  const say = { adet: 0, olaylar: [] };
  const ver = (ts, total, count) => {
    const ev = t.observe(mesaj(ts, { total: toplam ? total : null, count }));
    if (ev) { say.olaylar.push(ev); if (!ev.suspect) say.adet += ev.qty; }
  };
  let ts = T0;
  ver(ts, T, 0);
  for (let i = 1; i <= 130; i += 1) { ts += 25 * SN; ver(ts, T + i, i); }
  let n0 = 0; // sifirlama sonrasi ilk gorulen "Parca"
  if (aninda) n0 = 1;
  if (kopukSn > 0) { ts += kopukSn * SN; n0 = 12; } else ts += SN;
  ver(ts, T + 130 + n0, n0);
  for (let i = n0 + 1; i <= 140; i += 1) { ts += 25 * SN; ver(ts, T + 130 + i, i); }
  return say;
}

test('sifirlama: "Parca" 0\'a cekilir, omur boyu sayac akar -> hicbir senaryoda kayip yok (fabrikadaki gercek durum)', () => {
  assert.equal(sifirlamaAkisi().adet, 270, 'normal akis');
  assert.equal(sifirlamaAkisi({ aninda: true }).adet, 270, 'sifirlamayla ayni saniyede biten parca');
  assert.equal(sifirlamaAkisi({ kopukSn: 300 }).adet, 270, '5 dk veri kopuklugunda sifirlandi, 12 parca yapildi');
});

test('sifirlama: omur boyu sayac OKUNAMIYORSA sifirlamadan sonra gorulen deger sayilir (kayip yok)', () => {
  assert.equal(sifirlamaAkisi({ toplam: false }).adet, 270, 'normal akis: sifirlamanin kendisi parca degil');
  assert.equal(sifirlamaAkisi({ toplam: false, aninda: true }).adet, 270, 'sifirlamayla ayni saniyede biten parca');
  const k = sifirlamaAkisi({ toplam: false, kopukSn: 300 });
  assert.equal(k.adet, 270, 'kopuklukta yapilan 12 parca da sayildi');
  const olay = k.olaylar.find((e) => e.qty === 12);
  assert.equal(olay.gapMs, 300 * SN, 'ama zamani yaklasik diye isaretli');
  assert.equal(olay.suspect, false);
});

test('sifirlama: omur boyu sayac durmussa (0\'da sabit) parti sayaci sifirlamasi da yakalanir', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { total: 0, count: 130 }));
  assert.equal(t.observe(mesaj(T0 + SN, { total: 0, count: 0 })), null, 'sifirlamanin kendisi parca degil');
  t.observe(mesaj(T0 + 2 * SN, { total: 0, count: 0 }));
  assert.equal(t.observe(mesaj(T0 + 3 * SN, { total: 0, count: 1 })).qty, 1);
  const u = new PartTracker();
  u.observe(mesaj(T0, { total: 0, count: 130 }));
  assert.equal(u.observe(mesaj(T0 + SN, { total: 0, count: 1 })).qty, 1, 'sifirlamayla ayni saniyede biten parca');
});

test('sifirlama: sifirlama sonrasi makul olmayan buyuk deger (elle ayarlanmis) supheli, toplama katilmaz', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { total: null, count: 130 }));
  const ev = t.observe(mesaj(T0 + SN, { total: null, count: 90 })); // 1 sn'de 90 parca olamaz: elle 90'a ayarlandi
  assert.equal(ev.suspect, true);
  assert.equal(t.observe(mesaj(T0 + 30 * SN, { total: null, count: 91 })).suspect, false, 'sonraki parca normal');
});

test('izleyici: omur boyu sayac sabitse parti sayaci kullanilir; sadece parti sayaci varsa o', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { total: 0, count: 5 }));
  assert.equal(t.observe(mesaj(T0 + SN, { total: 0, count: 6 })).qty, 1, 'toplam kipirdamadi, parti artti');
  const u = new PartTracker();
  u.observe(mesaj(T0, { total: null, count: 5 }));
  assert.equal(u.observe(mesaj(T0 + SN, { total: null, count: 6 })).qty, 1);
  // sayaclar okunamayinca (null) taban silinmez
  const v = new PartTracker();
  v.observe(mesaj(T0, { total: 50, count: 5 }));
  assert.equal(v.observe(mesaj(T0 + SN, { total: null, count: null })), null);
  assert.equal(v.observe(mesaj(T0 + 2 * SN, { total: 51, count: 6 })).qty, 1);
});

test('izleyici: makul olmayan sicrama SUPHELI isaretlenir (sessizce yutulmaz), taban yine yenilenir', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { total: 100, count: 10 }));
  const ev = t.observe(mesaj(T0 + SN, { total: 5000, count: 10 }));
  assert.equal(ev.suspect, true);
  assert.equal(ev.qty, 4900);
  const sonraki = t.observe(mesaj(T0 + 30 * SN, { total: 5001, count: 11 }));
  assert.equal(sonraki.suspect, false, 'taban yenilendi, sonraki normal parca supheli degil');
});

test('izleyici: veri kopuklugundan sonra adet gercek ama zamani isaretli (gapMs)', () => {
  const t = new PartTracker({ gapMs: 10_000 });
  t.observe(mesaj(T0, { total: 1000, count: 10 }));
  const ev = t.observe(mesaj(T0 + 60 * SN, { total: 1003, count: 13 }));
  assert.equal(ev.qty, 3);
  assert.equal(ev.suspect, false, '60 sn icinde 3 parca makul');
  assert.equal(ev.gapMs, 60 * SN);
  assert.equal(ev.cycleSec, null, 'kopuklukta cevrim suresi tahmin edilmez');
});

test('izleyici: sirasi bozuk (eski) mesaj tabani bozmaz', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0 + 10 * SN, { total: 1000, count: 10 }));
  assert.equal(t.observe(mesaj(T0, { total: 900, count: 9 })), null);
  assert.equal(t.observe(mesaj(T0 + 11 * SN, { total: 1001, count: 11 })).qty, 1, 'eski mesaj tabani dusurmedi');
});

test('izleyici: sunucu yeniden baslayinca taban son kayitli ornektir', () => {
  const seed = () => ({ ts: T0 - 20 * SN, total: 1000, count: 10, program: 'P1' });
  const t = new PartTracker({ seed });
  const ev = t.observe(mesaj(T0, { total: 1001, count: 11 }));
  assert.equal(ev.qty, 1, 'kapali kalinan surede artan parca kaybolmadi');
  assert.equal(ev.gapMs, 20 * SN, 'ama zamani yaklasik');
  // gelecekteki bir tohum (saat karmasasi) tabani zehirlemez
  const u = new PartTracker({ seed: () => ({ ts: T0 + 3_600_000, total: 99999, count: 1, program: 'X' }) });
  assert.equal(u.observe(mesaj(T0, { total: 1000, count: 10 })), null);
  assert.equal(u.observe(mesaj(T0 + SN, { total: 1001, count: 11 })).qty, 1);
});

/** 1 Hz akis: her cevrim `sure` sn; sayac, cevrim sayaci SIFIRLANDIGI mesajda (ya da `once` ise bir onceki mesajda) artar. */
function akis(t, { cevrim, sure, sayi, once = false, baslangic = T0, program = 'P1', toplamBasi = 1000 }) {
  const olaylar = [];
  let toplam = toplamBasi;
  let ts = baslangic;
  t.observe(mesaj(ts, { total: toplam, count: 10, cycle: 0, program, main: program }));
  for (let i = 0; i < sayi; i += 1) {
    for (let s = 1; s <= sure; s += 1) {
      ts += SN;
      const sonSn = s === sure;
      // sayac: cevrimin son saniyesinde (once=true) ya da sifirlandigi ilk saniyede
      const artir = once ? sonSn : false;
      if (artir) toplam += 1;
      const ev = t.observe(mesaj(ts, { total: toplam, count: toplam - 990, cycle: s < sure + 0 ? s : sure, program, main: program }));
      if (ev) olaylar.push(ev);
    }
    if (!once) {
      ts += SN;
      toplam += 1;
      const ev = t.observe(mesaj(ts, { total: toplam, count: toplam - 990, cycle: 0, program, main: program }));
      if (ev) olaylar.push(ev);
    }
  }
  return olaylar;
}

test('izleyici: cevrim suresi, sayac artmadan onceki tepe degerdir (cevrim sifirlandiktan sonra artsa da)', () => {
  const olaylar = akis(new PartTracker(), { cevrim: true, sure: 24, sayi: 4 });
  assert.equal(olaylar.length, 4);
  assert.equal(olaylar[0].cycleSec, null, 'ilk olay: pencere cevrimin ortasinda baslamis olabilir, tahmin yok');
  for (const ev of olaylar.slice(1)) assert.equal(ev.cycleSec, 24);
});

test('izleyici: sayac cevrim sifirlanmadan ONCE artsa da sonraki parcanin suresi sismez', () => {
  // cevrim 20 sn; sayac 20. saniyede (sifirlanmadan) artar. Sonraki parca icin tepe 20 olmali, 20'den buyuk degil.
  const olaylar = akis(new PartTracker(), { cevrim: true, sure: 20, sayi: 5, once: true });
  assert.equal(olaylar.length, 5);
  for (const ev of olaylar.slice(1)) assert.equal(ev.cycleSec, 20);
});

test('izleyici: program degisiminden sonraki ilk parcanin cevrim suresi yok; ikincisinden itibaren var', () => {
  const t = new PartTracker();
  akis(t, { cevrim: true, sure: 10, sayi: 3, program: 'A' });
  // sayac kesintisiz surer (A 3 parca yapti: 1000 -> 1003); program degisince sayac geri gitmez
  const sonraki = akis(t, { cevrim: true, sure: 12, sayi: 3, program: 'B', baslangic: T0 + 600 * SN, toplamBasi: 1003 });
  assert.equal(sonraki[0].cycleSec, null);
  assert.equal(sonraki[1].cycleSec, 12);
  assert.equal(sonraki[2].cycleSec, 12);
});

test('izleyici: adet 1\'den buyukse cevrim suresi yazilmaz', () => {
  const t = new PartTracker();
  t.observe(mesaj(T0, { total: 100, count: 1, cycle: 5 }));
  t.observe(mesaj(T0 + SN, { total: 100, count: 1, cycle: 6 }));
  const ev = t.observe(mesaj(T0 + 2 * SN, { total: 102, count: 3, cycle: 0 }));
  assert.equal(ev.qty, 2);
  assert.equal(ev.cycleSec, null);
});

/* ------------------------------------------------------ veritabani ve rapor */

function olay(o) {
  return {
    machineId: 'CNC-01', ts: T0, program: 'P1', qty: 1, partTotal: null, partCount: null,
    status: 'RUNNING', cycleSec: null, gapMs: 0, suspect: false, ...o,
  };
}

test('veritabani: pencere toplami program ve tezgah bazinda; supheli haric, yaklasik ayri', () => {
  const db = new TelemetryDb(':memory:');
  try {
    db.recordProduction(olay({ ts: T0, cycleSec: 24 }));
    db.recordProduction(olay({ ts: T0 + 30 * SN, cycleSec: 26 }));
    db.recordProduction(olay({ ts: T0 + 60 * SN, qty: 3, gapMs: 90_000 }));
    db.recordProduction(olay({ ts: T0 + 70 * SN, qty: 4900, suspect: true }));
    db.recordProduction(olay({ ts: T0 + 80 * SN, program: 'P2', machineId: 'CNC-02' }));
    db.recordProduction(olay({ ts: T0 + 90 * SN, program: null }));

    const w = db.productionWindow(T0, T0 + 3_600_000);
    const p1 = w.find((r) => r.machineId === 'CNC-01' && r.program === 'P1');
    assert.equal(p1.qty, 5, 'supheli 4900 sayilmadi');
    assert.equal(p1.approxQty, 3);
    assert.equal(p1.cycleN, 2);
    assert.equal(p1.cycleSum, 50);
    assert.equal(p1.cycleMin, 24);
    assert.equal(p1.cycleMax, 26);
    assert.equal(w.find((r) => r.machineId === 'CNC-02').qty, 1);
    assert.ok(w.some((r) => r.program === null && r.qty === 1), 'programsiz olay da sayilir');
    assert.deepEqual(db.productionSuspect(T0, T0 + 3_600_000), { events: 1, qty: 4900 });
    // aralik yari acik: bitis ani dahil degil
    assert.equal(db.productionWindow(T0, T0 + 30 * SN, 'CNC-01').reduce((a, r) => a + r.qty, 0), 1);
    assert.equal(db.stats().production, 6);
  } finally { db.close(); }
});

test('rapor: olaylar vardiya sinirina gore bolunur (06:59 / 07:00 / 18:59 / 19:00 / ertesi 06:59)', () => {
  const db = new TelemetryDb(':memory:');
  try {
    const ekle = (ts, o = {}) => db.recordProduction(olay({ ts, ...o }));
    ekle(yerel(12, 10, 2026, 6, 59, 59));            // 11 Ekim gecesi
    ekle(yerel(12, 10, 2026, 7, 0, 0), { cycleSec: 24 });  // 12 gunduz
    ekle(yerel(12, 10, 2026, 18, 59, 59), { cycleSec: 26 }); // 12 gunduz
    ekle(yerel(12, 10, 2026, 19, 0, 0));             // 12 gece
    ekle(yerel(12, 10, 2026, 19, 0, 30), { program: 'P2' });
    ekle(yerel(13, 10, 2026, 6, 59, 59));            // 12 gece
    ekle(yerel(13, 10, 2026, 7, 0, 0));              // 13 gunduz

    const now = yerel(13, 10, 2026, 12);
    const rapor = buildReport({ db, machines: [{ id: 'CNC-01', name: 'CNC-01' }, { id: 'CNC-02', name: 'CNC-02' }], from: '2026-10-11', to: '2026-10-13', now });
    const gun = (d) => rapor.days.find((x) => x.date === d);
    assert.equal(gun('2026-10-11').shifts.gece.qty, 1);
    assert.equal(gun('2026-10-12').shifts.gunduz.qty, 2);
    assert.equal(gun('2026-10-12').shifts.gunduz.cycleAvg, 25, '24 ve 26 ortalamasi');
    assert.equal(gun('2026-10-12').shifts.gece.qty, 3);
    assert.equal(gun('2026-10-13').shifts.gunduz.qty, 1);
    assert.equal(rapor.totals.qty, 7);
    assert.equal(rapor.current.date, '2026-10-13');
    assert.equal(rapor.current.shift, 'gunduz');
  } finally { db.close(); }
});

test('rapor: tezgah bazli ve urun bazli toplamlar tutarli; olmayan tezgah 0 ile listelenir', () => {
  const db = new TelemetryDb(':memory:');
  try {
    const g = (sa, dk) => yerel(12, 10, 2026, sa, dk);
    for (let i = 0; i < 120; i += 1) db.recordProduction(olay({ ts: g(8, 0) + i * 1000, program: '01', cycleSec: 24 }));
    for (let i = 0; i < 130; i += 1) db.recordProduction(olay({ ts: g(20, 0) + i * 1000, program: '01', cycleSec: 25 }));
    for (let i = 0; i < 40; i += 1) db.recordProduction(olay({ ts: g(9, 0) + i * 1000, program: '01', machineId: 'CNC-02', cycleSec: 30 }));
    for (let i = 0; i < 10; i += 1) db.recordProduction(olay({ ts: g(10, 0) + i * 1000, program: '02' }));

    const rapor = buildReport({
      db, from: '2026-10-12', to: '2026-10-12', now: yerel(13, 10, 2026, 8),
      machines: [{ id: 'CNC-01', name: 'Tezgah 1' }, { id: 'CNC-02', name: 'Tezgah 2' }, { id: 'CNC-03', name: 'Tezgah 3' }],
    });

    // makine bazli
    const m1 = rapor.byMachine.find((m) => m.machineId === 'CNC-01');
    assert.equal(m1.shifts.gunduz.qty, 130);
    assert.equal(m1.shifts.gece.qty, 130);
    assert.equal(m1.total.qty, 260);
    const p01 = m1.programs.find((p) => p.program === '01');
    assert.equal(p01.shifts.gunduz.qty, 120);
    assert.equal(p01.shifts.gunduz.cycleAvg, 24);
    assert.equal(p01.shifts.gece.qty, 130);
    assert.equal(p01.shifts.gece.cycleAvg, 25);
    assert.equal(p01.total.cycleAvg, 24.5, 'agirlikli ortalama: (120*24 + 130*25)/250 = 24,52');
    assert.equal(m1.programs[0].program, '01', 'cok uretilen program once');
    assert.equal(rapor.byMachine.find((m) => m.machineId === 'CNC-03').total.qty, 0, 'uretmeyen tezgah da listede');

    // urun bazli: ayni program birden cok tezgahta toplanir
    const u01 = rapor.byProduct.find((p) => p.program === '01');
    assert.equal(u01.total.qty, 290);
    assert.equal(u01.shifts.gunduz.qty, 160, '120 (CNC-01) + 40 (CNC-02)');
    assert.deepEqual(u01.machines, [{ machineId: 'CNC-01', qty: 250 }, { machineId: 'CNC-02', qty: 40 }]);
    assert.equal(u01.shifts.gunduz.cycleAvg, 25.5, '(120*24 + 40*30)/160');

    // iki gorunumun genel toplami ayni
    const toplamMakine = rapor.byMachine.reduce((a, m) => a + m.total.qty, 0);
    const toplamUrun = rapor.byProduct.reduce((a, p) => a + p.total.qty, 0);
    assert.equal(toplamMakine, 300);
    assert.equal(toplamUrun, 300);
    assert.equal(rapor.totals.qty, 300);
    assert.equal(rapor.days[0].total.qty, 300);

    // tezgah filtresi
    const t2 = buildReport({ db, from: '2026-10-12', to: '2026-10-12', machineId: 'CNC-02', now: yerel(13, 10, 2026, 8), machines: [{ id: 'CNC-01' }, { id: 'CNC-02' }] });
    assert.equal(t2.totals.qty, 40);
    assert.deepEqual(t2.byMachine.map((m) => m.machineId), ['CNC-02']);
  } finally { db.close(); }
});

test('rapor: ortalama yalniz cevrim suresi BILINEN olaylardan; hic yoksa null (0 degil)', () => {
  const db = new TelemetryDb(':memory:');
  try {
    db.recordProduction(olay({ ts: T0, cycleSec: 20 }));
    db.recordProduction(olay({ ts: T0 + SN, cycleSec: null }));
    db.recordProduction(olay({ ts: T0 + 2 * SN, program: 'Y' }));
    const rapor = buildReport({ db, from: '2026-10-12', to: '2026-10-12', now: yerel(13, 10, 2026, 8), machines: [{ id: 'CNC-01' }] });
    const p = rapor.byProduct.find((x) => x.program === 'P1');
    assert.equal(p.total.qty, 2);
    assert.equal(p.total.cycleN, 1);
    assert.equal(p.total.cycleAvg, 20, 'bilinmeyen olay ortalamayi 0 ile cekmedi');
    assert.equal(rapor.byProduct.find((x) => x.program === 'Y').total.cycleAvg, null);
  } finally { db.close(); }
});

test('rapor: aralik dogrulamasi ve gelecek vardiya', () => {
  assert.deepEqual(resolveRange('2026-10-12', '2026-10-14', yerel(12, 10, 2026, 9)), { from: '2026-10-12', to: '2026-10-14' });
  assert.deepEqual(resolveRange(null, null, yerel(13, 10, 2026, 3)), { from: '2026-10-12', to: '2026-10-12' }, 'varsayilan: bugunun URETIM gunu');
  assert.deepEqual(resolveRange('2026-10-05', null, yerel(12, 10, 2026, 9)), { from: '2026-10-05', to: '2026-10-05' });
  assert.ok(resolveRange('2026-10-14', '2026-10-12').error);
  assert.ok(resolveRange('abc', null).error);
  assert.ok(resolveRange('2026-02-30', null).error);
  assert.ok(resolveRange('2026-01-01', '2026-12-31').error, `${MAX_REPORT_DAYS} gunu asan aralik`);
});

test('rapor: gezinme tarihleri ve hazir araliklar sunucudan gelir', () => {
  const db = new TelemetryDb(':memory:');
  try {
    const now = yerel(12, 10, 2026, 9);
    const r = buildReport({ db, from: '2026-10-12', to: '2026-10-12', now, machines: [] });
    assert.equal(r.prevDate, '2026-10-11');
    assert.equal(r.nextDate, null, 'bugunun ilerisi yok');
    assert.deepEqual(r.presets.last7, { from: '2026-10-06', to: '2026-10-12' });
    assert.deepEqual(r.presets.yesterday, { from: '2026-10-11', to: '2026-10-11' });
    const gecmis = buildReport({ db, from: '2026-10-10', to: '2026-10-10', now, machines: [] });
    assert.equal(gecmis.nextDate, '2026-10-11');
  } finally { db.close(); }
});

/* ------------------------------------------------- geriye dolu + yeniden baslama */

function gecici() {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-uretim-'));
  return { dir, file: join(dir, 't.db'), sil: () => rmSync(dir, { recursive: true, force: true }) };
}

test('geriye doldurma: eski ornekler uretim olayina cevrilir, bir kez calisir, cevrim suresi uydurulmaz', () => {
  const { file, sil } = gecici();
  try {
    const a = new TelemetryDb(file);
    // ozellik oncesi gibi: yalniz ornekler var
    let toplam = 500;
    for (let i = 0; i < 20; i += 1) {
      if (i % 5 === 0) toplam += 1;
      const r = parseTelemetry({ machineId: 'CNC-01', status: 'RUNNING', ts: new Date(T0 + i * 5 * SN).toISOString(), partTotal: toplam, partCount: toplam - 400, program: 'P1', mainProgram: 'P1', cycleTimeSec: 20 });
      assert.ok(r.ok, JSON.stringify(r.errors));
      a.recordSample(r.value, { force: true });
    }
    a.flush();
    a.db.exec("DELETE FROM production; DELETE FROM meta;");
    a.close();

    const b = new TelemetryDb(file);
    const ev = b.productionEvents('CNC-01', 0, Date.now() * 2);
    assert.equal(ev.length, 3, 'taban + 3 artis (i=5,10,15)');
    assert.ok(ev.every((e) => e.qty === 1 && e.program === 'P1' && e.cycleSec === null));
    b.close();

    const c = new TelemetryDb(file); // ikinci acilis: yeniden eklemez
    assert.equal(c.productionEvents('CNC-01', 0, Date.now() * 2).length, 3);
    c.close();
  } finally { sil(); }
});

test('depo: ingest sirasinda olaylar yazilir; yeniden baslamada kapali kalinan sure artisi kaybolmaz', () => {
  const { file, sil } = gecici();
  const acik = [];
  try {
    const ac = () => { const s = new TelemetryStore(file); acik.push(s); return s; };
    const ver = (store, ts, toplam) => {
      const r = parseTelemetry({ machineId: 'CNC-01', status: 'RUNNING', ts: new Date(ts).toISOString(), partTotal: toplam, partCount: toplam - 900, program: 'P1', mainProgram: 'P1' });
      assert.ok(r.ok, JSON.stringify(r.errors));
      store.ingest(r.value);
    };
    const a = ac();
    ver(a, T0, 1000);
    ver(a, T0 + 25 * SN, 1001);
    ver(a, T0 + 50 * SN, 1002);
    a.db.flush();
    assert.equal(a.db.productionEvents('CNC-01', 0, T0 * 2).length, 2);
    clearInterval(a.db.flushTimer);
    a.db.db.close(); // ani kapanis

    const b = ac();
    ver(b, T0 + 600 * SN, 1010); // 10 dk sonra, arada 8 parca uretilmis
    const ev = b.db.productionEvents('CNC-01', 0, T0 * 2).at(-1);
    assert.equal(ev.qty, 8);
    assert.ok(ev.gapMs >= 500 * SN, 'zamani yaklasik olarak isaretli');
    assert.equal(b.db.productionWindow(0, T0 * 2, 'CNC-01')[0].qty, 10, 'toplam tezgah sayacina esit (1000 -> 1010)');
  } finally {
    for (const s of acik) { clearInterval(s.db.flushTimer); try { s.db.db.close(); } catch { /* kapali */ } }
    sil();
  }
});

/* ------------------------------------------------------------------ CSV */

test('CSV (rapor): makine / urun / gunluk gorunumleri Excel biciminde, tutarli', () => {
  const db = new TelemetryDb(':memory:');
  try {
    for (let i = 0; i < 5; i += 1) db.recordProduction(olay({ ts: yerel(12, 10, 2026, 8) + i * SN, cycleSec: 24 }));
    for (let i = 0; i < 3; i += 1) db.recordProduction(olay({ ts: yerel(12, 10, 2026, 20) + i * SN, cycleSec: 25.5 }));
    db.recordProduction(olay({ ts: yerel(12, 10, 2026, 9), machineId: 'CNC-02', program: 'Ç-7' }));
    const rapor = buildReport({ db, from: '2026-10-12', to: '2026-10-12', now: yerel(13, 10, 2026, 8), machines: [{ id: 'CNC-01' }, { id: 'CNC-02' }] });

    const makine = reportCsv(rapor, 'makine');
    assert.ok(makine.startsWith('﻿sep=;\r\n'), 'BOM + sep=;');
    const satirlar = makine.split('\r\n').filter(Boolean);
    assert.equal(satirlar[1], 'tezgah;program;gunduz_adet;gunduz_ort_sn;gece_adet;gece_ort_sn;toplam_adet;ort_cevrim_sn;en_kisa_sn;en_uzun_sn');
    assert.ok(satirlar.includes('CNC-01;P1;5;24;3;25,5;8;24,6;24;25,5'), satirlar.join('\n'));
    assert.ok(satirlar.some((s) => s.startsWith('CNC-02;Ç-7;1;;0;;1;')), 'sayisi 0 olan vardiya 0, bilinmeyen sure bos');

    const urun = reportCsv(rapor, 'urun').split('\r\n').filter(Boolean);
    assert.ok(urun[1].endsWith(';tezgahlar'));
    assert.ok(urun.some((s) => s.startsWith('P1;5;24;3;25,5;8;') && s.endsWith('CNC-01 (8)')));

    const gunluk = reportCsv(rapor, 'gunluk').split('\r\n').filter(Boolean);
    assert.equal(gunluk[1], 'tarih;vardiya;tezgah;program;adet;ort_cevrim_sn;en_kisa_sn;en_uzun_sn;yaklasik_adet');
    assert.ok(gunluk.includes('2026-10-12;Gündüz;CNC-01;P1;5;24;24;24;0'));
    assert.ok(gunluk.includes('2026-10-12;Gece;CNC-01;P1;3;25,5;25,5;25,5;0'));
  } finally { db.close(); }
});

test('CSV (tezgah ozet): saniyelik satirlar atilir; uretilen her parca ve degisimler kalir', () => {
  const { file, sil } = gecici();
  let store;
  try {
    store = new TelemetryStore(file);
    let toplam = 7000;
    // 3 dk, 1 Hz: ilk 100 sn RUNNING (24 sn'de bir parca), sonra 80 sn IDLE (alarm yok)
    for (let s = 0; s < 180; s += 1) {
      const calisiyor = s < 100;
      if (calisiyor && s > 0 && s % 24 === 0) toplam += 1;
      const r = parseTelemetry({
        machineId: 'CNC-01', status: calisiyor ? 'RUNNING' : 'IDLE', ts: new Date(T0 + s * SN).toISOString(),
        partTotal: toplam, partCount: toplam - 6000, program: 'P1', mainProgram: 'P1', cycleTimeSec: calisiyor ? s % 24 : 0,
        spindleRpm: calisiyor ? 1000 + (s % 7) : 0,
      });
      assert.ok(r.ok, JSON.stringify(r.errors));
      store.ingest(r.value);
    }
    store.db.flush();

    const ozet = compactMachineCsv(store.db, 'CNC-01', T0 - 1000, T0 + 600 * SN).split('\r\n').filter(Boolean);
    const veri = ozet.slice(2); // sep= ve baslik
    const parcalar = veri.filter((s) => s.split(';')[1] === 'Parça üretildi');
    assert.equal(parcalar.length, 4, `24,48,72,96. sn: ${veri.join('\n')}`);
    assert.ok(parcalar.every((s) => s.split(';')[4] === '1'), 'adet = 1');
    assert.ok(veri[0].split(';')[1] === 'Kayıt başladı');
    const degisim = veri.filter((s) => s.split(';')[1] === 'Durum değişti');
    assert.equal(degisim.length, 1, 'RUNNING -> IDLE tek satir');
    assert.ok(veri.length <= 7, `7 satirdan fazla degil (ham ${store.db.stats().samples} ornek): ${veri.length}`);

    // ilk parca kismi pencere (cevrim yok); sonrakilerin cevrim suresi dolu
    assert.equal(parcalar[0].split(';')[7], '');
    assert.ok(Number(parcalar[2].split(';')[7].replace(',', '.')) >= 20, parcalar[2]);

    // ham dokum hala her kaydedilen ornegi icerir
    const ham = store.db.samples('CNC-01', T0 - 1000, T0 + 600 * SN, 100_000).rows.length;
    assert.ok(ham > veri.length * 3, `ham ${ham} satir, ozet ${veri.length}`);
  } finally {
    if (store) { clearInterval(store.db.flushTimer); try { store.db.db.close(); } catch { /* kapali */ } }
    sil();
  }
});

test('aggregate: bos girdi cokmez', () => {
  const v = aggregate([], { machineIds: ['CNC-01'] });
  assert.equal(v.totals.qty, 0);
  assert.equal(v.byMachine[0].total.cycleAvg, null);
  assert.deepEqual(v.byProduct, []);
  assert.deepEqual(v.days, []);
});
