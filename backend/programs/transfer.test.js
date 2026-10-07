/**
 * Tezgah dosya islemleri: tarama, iceri alma, on kontrol ve GONDERME.
 * Sahte FTP sunucusu torna 8'in gercek (Windows CE 7.0) davranisini taklit eder;
 * hata enjeksiyonu: bozuk iletim, RNTO hatasi, salt okunur sunucu, yaris, kopma.
 *
 * Bu testler guvenlik kurallarinin KODDA zorlandigini kanitlar: ezme yok, calisan
 * programin adiyla gonderme yok, onay metni, gecici ad + dogrulama, temizlik.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kur, ekle, ORNEK } from './test/harness.js';
import { sha256, ValidationError } from './library.js';
import { BusyError, DisabledError, UnsupportedError, driverFtpOptions, NotFoundError } from './machine-files.js';

const komutlar = (s, onek) => s.commands.filter((k) => k.startsWith(onek));
const yazma = (s) => s.commands.filter((k) => /^(STOR|RNFR|RNTO|DELE|MKD|RMD)\b/.test(k));

/** Hicbir DELE, ZZUP gecici adi (ya da kendi bozuk nihai dosyamiz) disina dokunmamali. */
function silmeGuvenli(s, izinliAd = null) {
  for (const k of komutlar(s, 'DELE')) {
    const ad = k.slice(5);
    assert.ok(/^ZZUP\d{6}$/.test(ad) || ad === izinliAd, `izinsiz DELE: ${k}`);
  }
}

/* ------------------------------------------------------------------ tarama */

test('tarama: kok + musteri klasorleri, sistem dosyasi isaretli, SHA yalniz adayi indirilir', async () => {
  const t = await kur({
    seed: (s) => {
      s.put('MUSTERI_B/100200300', ORNEK);                  // kutuphanede AYNI icerik
      s.put('MUSTERI_B/P-FARKLI', 'tezgahtaki farkli\r\n');  // kutuphanede boyutu tutmayan
      s.put('MUSTERI_B/SADECE-TEZGAH', 'x\r\n');
      s.put('AA/ORNEK-013', ORNEK);                    // kutuphanede yok
    },
  });
  try {
    ekle(t.library, 'MUSTERI_B', '100200300');
    ekle(t.library, 'MUSTERI_B', 'P-FARKLI', Buffer.from('kutuphanedeki boyut baska olsun!!\r\n'));
    const r = await t.files.scan('CNC-08');

    assert.equal(r.folders, 2);
    assert.equal(r.entries, 6, 'MDIBlock + O9001 + 3 MUSTERI_B + 1 AA');
    assert.equal(r.hashed, 1, 'yalniz boyutu tutan tek aday indirilir (100200300)');
    assert.deepEqual(komutlar(t.server, 'RETR'), ['RETR 100200300']);

    const cmp = t.library.compareMachine('CNC-08');
    const durum = Object.fromEntries(cmp.entries.map((e) => [`${e.customer}/${e.name}`, e.status]));
    assert.equal(durum['MUSTERI_B/100200300'], 'guncel');
    assert.equal(durum['MUSTERI_B/P-FARKLI'], 'farkli', 'boyut tutmuyor: indirmeden kesin farkli');
    assert.equal(durum['MUSTERI_B/SADECE-TEZGAH'], 'kutuphanede-yok');
    assert.equal(durum['/MDIBlock'], 'sistem');
    assert.equal(durum['/O9001'], 'kutuphanede-yok');
    assert.equal(cmp.scan.status, 'tamam');
    assert.equal(yazma(t.server).length, 0, 'tarama tezgaha HICBIR sey yazmaz');
  } finally { await t.kapat(); }
});

test('tarama: bir klasor listelenemezse uyari verir, digerleri taranir', async () => {
  const t = await kur({ ftp: { failCwd: ['MUSTERI_B'] }, seed: (s) => { s.put('MUSTERI_B/P1', 'a'); s.put('AA/P2', 'b'); } });
  try {
    const r = await t.files.scan('CNC-08');
    assert.ok(r.warnings.some((w) => w.startsWith('MUSTERI_B:')), 'MUSTERI_B icin uyari');
    assert.ok(t.library.db.getInventory('CNC-08').some((e) => e.name === 'P2'));
    assert.ok(!t.library.db.getInventory('CNC-08').some((e) => e.name === 'P1'));
  } finally { await t.kapat(); }
});

test('tarama: baglanti kopunca hata, ESKI ENVANTER KORUNUR', async () => {
  const t = await kur({ seed: (s) => s.put('MUSTERI_B/P1', 'a') });
  try {
    await t.files.scan('CNC-08');
    assert.equal(t.library.db.getInventory('CNC-08').length, 3);
    await t.server.stop();
    await assert.rejects(() => t.files.scan('CNC-08'), /bağlantı kurulamadı|bağlantı/);
    assert.equal(t.library.db.getInventory('CNC-08').length, 3, 'envanter silinmemeli');
    assert.equal(t.library.db.getScan('CNC-08').status, 'hata');
  } finally { await t.library.close(); }
});

test('tarama: alt klasor ve cozumlenemeyen satir uyari olur', async () => {
  const t = await kur({ seed: (s) => { s.mkdir('MUSTERI_B/ALT'); s.put('MUSTERI_B/P1', 'a'); } });
  try {
    const r = await t.files.scan('CNC-08');
    assert.ok(r.warnings.some((w) => /MUSTERI_B\\ALT.*alt klasör/.test(w)));
  } finally { await t.kapat(); }
});

/* -------------------------------------------------------------- iceri alma */

test('iceri alma: tezgahtaki program kutuphaneye girer (kaynak tezgah-tarama), tekrar yeni surum acmaz', async () => {
  const t = await kur({ seed: (s) => s.put('MUSTERI_B/IC-ALINACAK', ORNEK) });
  try {
    await t.files.scan('CNC-08');
    const a = await t.files.importFromMachine({ machineId: 'CNC-08', customer: 'musteri_b', name: 'ic-alinacak', by: 'ayse' });
    assert.equal(a.created, true);
    assert.equal(a.program.customer, 'MUSTERI_B', 'tezgahtaki gercek harf kullanilir');
    assert.equal(a.version.source, 'tezgah-tarama');
    assert.equal(a.version.sourceMachine, 'CNC-08');
    assert.equal(a.version.sha256, sha256(ORNEK));
    const b = await t.files.importFromMachine({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'IC-ALINACAK' });
    assert.equal(b.created, false);
    assert.equal(yazma(t.server).length, 0);
    await assert.rejects(() => t.files.importFromMachine({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'YOK' }), NotFoundError);
    await assert.rejects(() => t.files.importFromMachine({ machineId: 'CNC-08', customer: 'YOKKLASOR', name: 'X' }), NotFoundError);
  } finally { await t.kapat(); }
});

test('iceri alma: cok buyuk ve ikili dosya reddedilir', async () => {
  const t = await kur({ seed: (s) => { s.put('MUSTERI_B/BUYUK', Buffer.alloc(1_100_000, 65)); s.put('MUSTERI_B/IKILI', Buffer.from([65, 0, 66])); } });
  try {
    await assert.rejects(() => t.files.importFromMachine({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'BUYUK' }), (e) => e instanceof ValidationError && e.status === 413);
    await assert.rejects(() => t.files.importFromMachine({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'IKILI' }), /ikili/);
  } finally { await t.kapat(); }
});

/* -------------------------------------------------------------- on kontrol */

test('on kontrol: temiz durumda gonderilebilir, tezgaha HICBIR sey yazmaz', async () => {
  const t = await kur();
  try {
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const p = await t.files.precheck({ machineId: 'CNC-08', programId: program.id });
    assert.equal(p.canSend, true);
    assert.equal(p.folder, 'AA');
    assert.deepEqual(p.checks.map((c) => `${c.id}:${c.level}`), ['calisan-program:ok', 'klasor:ok', 'cakisma:ok']);
    assert.ok(p.folderNames.includes('MUSTERI_B'));
    assert.equal(yazma(t.server).length, 0);
  } finally { await t.kapat(); }
});

test('on kontrol: hedef klasor tezgahta yoksa ENGEL (klasor otomatik acilmaz)', async () => {
  const t = await kur();
  try {
    const { program } = ekle(t.library, 'YENI-MUSTERI', 'P1');
    const p = await t.files.precheck({ machineId: 'CNC-08', programId: program.id });
    assert.equal(p.canSend, false);
    assert.equal(p.checks.find((c) => c.id === 'klasor').level, 'block');
    assert.ok(!t.server.commands.some((k) => k.startsWith('MKD')), 'MKD gonderilmemeli');
  } finally { await t.kapat(); }
});

test('on kontrol: ayni adli dosya ENGEL (buyuk/kucuk harf duyarsiz); icerik ayniysa bunu soyler', async () => {
  const t = await kur({ seed: (s) => { s.put('AA/ornek-013', 'baska icerik\r\n'); s.put('MUSTERI_B/ORNEK-013', ORNEK); } });
  try {
    const farkli = ekle(t.library, 'AA', 'ORNEK-013').program;
    const p1 = await t.files.precheck({ machineId: 'CNC-08', programId: farkli.id });
    assert.equal(p1.canSend, false);
    const c1 = p1.checks.find((c) => c.id === 'cakisma');
    assert.equal(c1.level, 'block');
    assert.match(c1.title, /üzerine yazılmaz/);

    const ayni = ekle(t.library, 'MUSTERI_B', 'ORNEK-013').program;
    const p2 = await t.files.precheck({ machineId: 'CNC-08', programId: ayni.id });
    assert.match(p2.checks.find((c) => c.id === 'cakisma').title, /zaten var ve içeriği aynı/);
    assert.equal(p2.canSend, false);
  } finally { await t.kapat(); }
});

test('on kontrol: calisan/secili programin adiyla gonderilemez (klasorlu secili ad dahil)', async () => {
  for (const live of [
    { connected: true, state: 'RUNNING', program: 'ORNEK-013', mainProgram: '1' },
    { connected: true, state: 'RUNNING', program: '1', mainProgram: 'MUSTERI_B\\ornek-013' },
  ]) {
    const t = await kur({ live });
    try {
      const { program } = ekle(t.library, 'AA', 'ORNEK-013');
      const p = await t.files.precheck({ machineId: 'CNC-08', programId: program.id });
      assert.equal(p.canSend, false);
      assert.equal(p.checks.find((c) => c.id === 'calisan-program').level, 'block');
    } finally { await t.kapat(); }
  }
});

test('on kontrol: canli veri yoksa onay (unknown-state) gerekir; kok dizin da onay ister', async () => {
  const t = await kur({ live: null });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    const p = await t.files.precheck({ machineId: 'CNC-08', programId: program.id });
    assert.equal(p.canSend, false, 'onay olmadan gonderilemez');
    assert.deepEqual(p.needsAck, ['unknown-state']);
    const p2 = await t.files.precheck({ machineId: 'CNC-08', programId: program.id, acks: ['unknown-state'] });
    assert.equal(p2.canSend, true);

    const kok = ekle(t.library, '', 'ORTAK-1').program;
    const p3 = await t.files.precheck({ machineId: 'CNC-08', programId: kok.id, acks: ['unknown-state'] });
    assert.equal(p3.canSend, false);
    assert.deepEqual(p3.needsAck.sort(), ['root-target', 'unknown-state']);
    const p4 = await t.files.precheck({ machineId: 'CNC-08', programId: kok.id, acks: ['unknown-state', 'root-target'] });
    assert.equal(p4.canSend, true);
  } finally { await t.kapat(); }
});

test('on kontrol: kalan gecici dosya bilgi olarak gosterilir, silinmez', async () => {
  const t = await kur({ seed: (s) => s.put('AA/ZZUP123456', 'yarim') });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    const p = await t.files.precheck({ machineId: 'CNC-08', programId: program.id });
    assert.equal(p.checks.find((c) => c.id === 'gecici-kalinti').level, 'info');
    assert.equal(p.canSend, true);
    assert.ok(t.server.read('AA/ZZUP123456'), 'kalinti otomatik silinmemeli');
  } finally { await t.kapat(); }
});

/* ---------------------------------------------------------------- gonderme */

test('gonder: gecici ad -> dogrula -> nihai ad; bayt bayt ayni, kayit tam, envanter guncel', async () => {
  const t = await kur();
  try {
    const { program, version } = ekle(t.library, 'AA', 'ORNEK-013');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08', by: 'ayse', clientIp: '10.0.0.5' });

    assert.equal(kayit.status, 'basarili', kayit.error);
    assert.deepEqual(t.server.names('AA'), ['ORNEK-013'], 'yalniz nihai dosya, gecici kalinti yok');
    assert.ok(t.server.read('AA/ORNEK-013').equals(ORNEK), 'tezgahtaki icerik gonderilenle BAYT BAYT ayni');
    assert.equal(kayit.shaVerified, version.sha256);
    assert.equal(kayit.requestedBy, 'ayse');
    assert.equal(kayit.clientIp, '10.0.0.5');
    assert.deepEqual(kayit.steps.map((s) => s.step), ['on-kontrol', 'yukle', 'boyut-dogrula', 'geri-oku-sha', 'nihai-ada-cevir', 'son-dogrulama']);
    assert.ok(kayit.steps.every((s) => s.ok));
    assert.ok(kayit.steps.every((s) => s.detail === null || typeof s.detail === 'string'), 'adim ayrintilari metin olmali (nesne denetim kaydina yazilmaz)');

    // Protokol: ikili mod, gecici adla STOR, RNFR/RNTO.
    const stor = komutlar(t.server, 'STOR');
    assert.equal(stor.length, 1);
    assert.match(stor[0], /^STOR ZZUP\d{6}$/, 'once GECICI adla');
    assert.ok(t.server.commands.includes('TYPE I'));
    assert.equal(komutlar(t.server, 'RNTO')[0], 'RNTO ORNEK-013');
    silmeGuvenli(t.server);
    assert.equal(komutlar(t.server, 'DELE').length, 0, 'basarili akista silme yok');

    // Envanter ve karsilastirma: artik "guncel".
    const e = t.library.compareMachine('CNC-08').entries.find((x) => x.name === 'ORNEK-013');
    assert.equal(e.status, 'guncel');
    // Denetim kaydi kalici.
    assert.equal(t.library.db.listTransfers({ machineId: 'CNC-08' })[0].id, kayit.id);
  } finally { await t.kapat(); }
});

test('gonder: musteri adi tezgahtaki gercek harfle yazilir (musteri_b -> MUSTERI_B)', async () => {
  const t = await kur();
  try {
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'musteri_b', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'basarili', kayit.error);
    assert.deepEqual(t.server.names('MUSTERI_B'), ['ORNEK-013']);
  } finally { await t.kapat(); }
});

test('gonder: onay metni tezgah kimligi degilse REDDEDILIR ve tezgaha hic baglanilmaz', async () => {
  const t = await kur();
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    for (const confirm of ['', 'onaylıyorum', 'cnc-08', 'CNC-07', undefined]) {
      await assert.rejects(() => t.files.send({ machineId: 'CNC-08', programId: program.id, confirm }), ValidationError);
    }
    assert.equal(t.server.sessions, 0, 'tezgaha hic baglanilmamali');
    assert.equal(t.library.db.listTransfers().length, 0);
  } finally { await t.kapat(); }
});

test('gonder: engel varsa REDDEDILIR, tezgaha yazilmaz, denetim kaydi tutulur', async () => {
  const t = await kur({ seed: (s) => s.put('AA/P1', 'mevcut dosya\r\n') });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'reddedildi');
    assert.match(kayit.error, /üzerine yazılmaz/);
    assert.equal(yazma(t.server).length, 0, 'STOR/RNFR/DELE hic gonderilmemeli');
    assert.equal(t.server.read('AA/P1').toString(), 'mevcut dosya\r\n', 'mevcut dosya aynen duruyor');
    assert.equal(t.library.db.listTransfers()[0].status, 'reddedildi');
  } finally { await t.kapat(); }
});

test('gonder: canli veri yoksa onay (acks) olmadan reddedilir, onayla gider', async () => {
  const t = await kur({ live: null });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    const once = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(once.status, 'reddedildi');
    assert.equal(yazma(t.server).length, 0);
    const sonra = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08', acks: ['unknown-state'] });
    assert.equal(sonra.status, 'basarili', sonra.error);
    assert.deepEqual(sonra.acks, ['unknown-state'], 'onay denetim kaydina yazilir');
  } finally { await t.kapat(); }
});

test('gonder: iletimde icerik bozulursa BASARISIZ, gecici dosya silinir, nihai ad olusmaz', async () => {
  const t = await kur({ ftp: { corruptStor: true } });
  try {
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'basarisiz');
    assert.match(kayit.error, /SHA-256 tutmuyor/);
    assert.deepEqual(t.server.names('AA'), [], 'ne gecici ne nihai dosya kalmali');
    assert.equal(komutlar(t.server, 'RNTO').length, 0, 'dogrulama tutmadan adlandirma yapilmaz');
    assert.ok(kayit.steps.some((s) => s.step === 'temizlik' && s.ok));
    silmeGuvenli(t.server);
  } finally { await t.kapat(); }
});

test('gonder: RNTO hata verirse BASARISIZ ve gecici dosya temizlenir', async () => {
  const t = await kur({ ftp: { failRnto: true } });
  try {
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'basarisiz');
    assert.match(kayit.error, /RNTO/);
    assert.deepEqual(t.server.names('AA'), []);
    silmeGuvenli(t.server);
  } finally { await t.kapat(); }
});

test('gonder: sunucu yazmaya kapaliysa (STOR 550) anlasilir hata, tezgah degismez', async () => {
  const t = await kur({ ftp: { readOnly: true } });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'basarisiz');
    assert.match(kayit.error, /STOR/);
    assert.deepEqual(t.server.names('AA'), []);
    assert.equal(komutlar(t.server, 'DELE').length, 0, 'olmayan dosya icin DELE gonderilmemeli');
  } finally { await t.kapat(); }
});

test('gonder: adlandirma aninda baska biri ayni adi olusturduysa EZILMEZ', async () => {
  const t = await kur({
    ftp: { beforeRnfr: (s, klasor) => { if (klasor === 'AA') s.put('AA/ORNEK-013', 'operatorun dosyasi\r\n'); } },
  });
  try {
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'basarisiz');
    assert.equal(t.server.read('AA/ORNEK-013').toString(), 'operatorun dosyasi\r\n', 'baskasinin dosyasi aynen kaldi');
    assert.deepEqual(t.server.names('AA'), ['ORNEK-013'], 'gecici dosya temizlendi');
    silmeGuvenli(t.server);
  } finally { await t.kapat(); }
});

test('gonder: ozellik kapaliysa (TRANSFER_DISABLED) gonderilemez, on kontrol engel gosterir', async () => {
  const t = await kur({ disabled: true });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    await assert.rejects(() => t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' }), DisabledError);
    const p = await t.files.precheck({ machineId: 'CNC-08', programId: program.id });
    assert.equal(p.canSend, false);
    assert.equal(p.checks[0].id, 'ozellik');
    assert.equal(t.server.sessions, 0);
    // Okuma islemleri kapali degil.
    const r = await t.files.scan('CNC-08');
    assert.ok(r.entries > 0);
  } finally { await t.kapat(); }
});

test('gonder: ayni tezgaha eszamanli islem 409 (BusyError), ilk islem etkilenmez', async () => {
  const t = await kur({ ftp: { delayMs: 40 } });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    const arg = { machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' };
    const birinci = t.files.send(arg);
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(() => t.files.send(arg), BusyError);
    await assert.rejects(() => t.files.scan('CNC-08'), BusyError);
    assert.equal((await birinci).status, 'basarili');
  } finally { await t.kapat(); }
});

test('gonder: bilinmeyen tezgah/program 404, guvenlik: hicbir senaryoda mevcut dosya silinmez', async () => {
  const t = await kur({ seed: (s) => { s.put('AA/BASKASININ', 'dokunma\r\n'); } });
  try {
    const { program } = ekle(t.library, 'AA', 'P1');
    await assert.rejects(() => t.files.send({ machineId: 'CNC-99', programId: program.id, confirm: 'CNC-99' }), NotFoundError);
    await assert.rejects(() => t.files.send({ machineId: 'CNC-08', programId: 9999, confirm: 'CNC-08' }), NotFoundError);
    const kayit = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'AA', confirm: 'CNC-08' });
    assert.equal(kayit.status, 'basarili');
    assert.equal(t.server.read('AA/BASKASININ').toString(), 'dokunma\r\n');
    silmeGuvenli(t.server);
  } finally { await t.kapat(); }
});

/* ---------------------------------------------------------------- surucu */

test('surucu ayari: Syntec -> FTP 21 anonim; IP yoksa ya da surucu desteklemiyorsa UnsupportedError', () => {
  const o = driverFtpOptions({ id: 'X', ip: '192.168.88.98', driverId: 'syntec-remoteapi' });
  assert.equal(o.host, '192.168.88.98');
  assert.equal(o.port, 21);
  assert.equal(o.user, 'anonymous');
  assert.throws(() => driverFtpOptions({ id: 'X', ip: null, driverId: 'syntec-remoteapi' }), UnsupportedError);
  assert.throws(() => driverFtpOptions({ id: 'X', ip: '1.2.3.4', driverId: 'yok-surucu' }), UnsupportedError);
});
