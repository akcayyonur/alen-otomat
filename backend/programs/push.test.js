/**
 * TOPLU GONDERME (ezme dahil): plan + uygulama. Sahte FTP sunucusu torna 8'in (Windows CE 7.0) davranisini taklit eder;
 * `renameOverwrites` KAPALI (varsayilan): tornada "RNTO hedefte ayni ad varken ezer mi" hic olculmedi, ozellik buna DAYANMAMALI.
 *
 * Kanitlanan kurallar: tornaya yalniz yedekleyerek yazilir (eski hal kutuphanede), calisan program ezilmez, bozuk iletim tornadaki
 * dosyaya dokunmaz, her hatada eski hal geri konur, silme yalniz kendi gecici/yan adli dosyalarimiz icindir, tornada olup
 * kutuphanede olmayana ve kok dizine dokunulmaz, yarim kalan islem kaldigi yerden surer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { kur, ekle } from './test/harness.js';
import { createProgramRoutes } from './routes.js';
import { sha256 } from './library.js';
import { BusyError, DisabledError, UnsupportedError } from './machine-files.js';

const ic = (ad, v) => Buffer.from(`//${ad} v${v}\r\nG0 X${v}.\r\nM99\r\n`, 'latin1');
const bekle = async (fn, bitti, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (bitti(v)) return v;
    if (Date.now() - t0 > ms) throw new Error('zaman aşımı');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const planla = async (t, folders = null) => {
  const id = t.files.startPushPlan({ machineId: 'CNC-08', folders });
  const p = await bekle(() => t.files.getPushPlan('CNC-08', id), (x) => x.status !== 'calisiyor');
  assert.equal(p.status, 'bitti', p.error);
  return { id, plan: p.plan };
};
const basla = (t, id, extra = {}) => t.files.startPushApply({ machineId: 'CNC-08', planId: id, confirm: 'CNC-08', by: 'ayse', ...extra });
const uygula = async (t, id, extra = {}) => {
  basla(t, id, extra);
  return bekle(() => t.files.getPushPlan('CNC-08', id).apply, (a) => a.status !== 'calisiyor');
};
const artik = (t) => ['MUSTERI_B', 'AA'].flatMap((k) => t.server.names(k).filter((n) => /^ZZ(UP|RB)/i.test(n)).map((n) => `${k}/${n}`));
const komutlar = (s, onek) => s.commands.filter((k) => k.startsWith(onek));
const sonuc = (a, ad) => a.results.find((r) => r.name === ad);
const AYNI = (t, yol, beklenen) => assert.ok(t.server.read(yol)?.equals(beklenen), `${yol} beklenen içerikte değil`);

/** Her senaryonun ortak kurulumu: kutuphane + torna (bkz. test 1'deki beklenen siniflandirma). */
async function kurPush(opts = {}) {
  const t = await kur({
    live: { connected: true, state: 'RUNNING', program: 'P-CALISAN', mainProgram: 'P-CALISAN' },
    seed: (s) => {
      s.put('MUSTERI_B/P-AYNI', ic('AYNI', 1));
      s.put('MUSTERI_B/P-ESKI', ic('ESKI', 1)); // kutuphane v1 ile ayni
      s.put('MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9)); // kutuphanede yok, boyut da farkli
      s.put('MUSTERI_B/P-BOYUT', ic('BOYUT_B', 1)); // boyut ayni, icerik farkli
      s.put('MUSTERI_B/SADECE-TORNA', ic('OZEL', 1));
      s.put('AA/P-CALISAN', ic('CALISAN', 1));
      s.put('AA/ZZUP123456', 'artik');
    },
    ...opts,
  });
  ekle(t.library, 'MUSTERI_B', 'P-AYNI', ic('AYNI', 1));
  ekle(t.library, 'MUSTERI_B', 'P-ESKI', ic('ESKI', 1));
  ekle(t.library, 'MUSTERI_B', 'P-ESKI', ic('ESKI', 2));
  ekle(t.library, 'MUSTERI_B', 'P-FARKLI', ic('FARKLI', 3));
  ekle(t.library, 'MUSTERI_B', 'P-BOYUT', ic('BOYUT_A', 1));
  ekle(t.library, 'MUSTERI_B', 'P-YENI', ic('YENI', 1));
  ekle(t.library, 'AA', 'P-CALISAN', ic('CALISAN', 2));
  ekle(t.library, 'YOKKLASOR', 'P-X', ic('X', 1));
  ekle(t.library, '', 'KOKPROG', ic('KOK', 1));
  return t;
}

/* ------------------------------------------------------------------ plan */

test('plan: yeni / ezilecek (eski surum, farkli, ayni boyut farkli icerik) / ayni / atlanan; torna-ozel ve kok dokunulmaz; tornaya HICBIR sey yazilmaz', async () => {
  const t = await kurPush();
  try {
    const { plan } = await planla(t);
    const s = plan.summary;
    assert.deepEqual(
      [s.kutuphane, s.yeni, s.ezilecek, s.yedeklenecek, s.ayni, s.atlanan, s.tornadaOzel, s.kokKutuphane],
      [7, 1, 3, 2, 1, 2, 1, 1],
    );
    assert.deepEqual(plan.yeni.map((x) => x.name), ['P-YENI']);
    const ez = Object.fromEntries(plan.ezilecek.map((x) => [x.name, x]));
    assert.deepEqual([ez['P-ESKI'].latheStatus, ez['P-ESKI'].latheVersionNo, ez['P-ESKI'].needsBackup], ['eski', 1, false], 'tornadaki hal kütüphanede v1: ayrıca yedek gerekmez');
    assert.deepEqual([ez['P-FARKLI'].latheStatus, ez['P-FARKLI'].needsBackup], ['farkli', true]);
    assert.deepEqual([ez['P-BOYUT'].latheStatus, ez['P-BOYUT'].needsBackup], ['farkli', true], 'boyut aynı ama SHA farklı');
    assert.deepEqual(plan.ayni.map((x) => x.name), ['P-AYNI']);
    const atl = Object.fromEntries(plan.atlanan.map((x) => [x.name, x.reason]));
    assert.match(atl['P-CALISAN'], /çalıştırıyor/);
    assert.match(atl['P-X'], /klasörü yok.*klasör açmaz/);
    assert.deepEqual(plan.tornadaOzel.map((x) => `${x.customer}/${x.name}`), ['MUSTERI_B/SADECE-TORNA']);
    assert.ok(plan.warnings.some((w) => /aktarım artığı/.test(w) && /ZZUP123456/.test(w)), 'ZZUP artığı uyarılır, silinmez');
    assert.equal(plan.unknownState, false);
    assert.equal(plan.gate.allowed, true);
    assert.equal(komutlar(t.server, 'STOR').length + komutlar(t.server, 'RNFR').length + komutlar(t.server, 'DELE').length + komutlar(t.server, 'MKD').length, 0, 'plan salt okunur');
    assert.deepEqual(komutlar(t.server, 'RETR').sort(), ['RETR P-AYNI', 'RETR P-BOYUT', 'RETR P-CALISAN', 'RETR P-ESKI'], 'yalnız boyutu bir sürümle tutan adaylar indirilir (P-FARKLI ve torna-özel indirilmez)');
  } finally { await t.kapat(); }
});

test('plan: klasor secimi yalniz o klasoru kapsar', async () => {
  const t = await kurPush();
  try {
    const { plan } = await planla(t, ['AA']);
    assert.equal(plan.summary.kutuphane, 1);
    assert.equal(plan.filtered, true);
    assert.deepEqual(plan.atlanan.map((x) => x.name), ['P-CALISAN']);
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------------ uygulama */

test('UYGULA: yeniler yazilir, ezilecekler YEDEKLENEREK ezilir (RNTO ezme semantigine dayanmadan), yan adli dosya silinir, artik yok, 2. plan "hepsi ayni"', async () => {
  const t = await kurPush();
  try {
    const { id } = await planla(t);
    const a = await uygula(t, id);
    assert.equal(a.status, 'bitti');
    assert.deepEqual(
      [a.counts.yeni, a.counts.ezilen, a.counts.yedeklendi, a.counts.yedekKutuphanedeVardi, a.counts.hata, a.counts.atlanan, a.counts.yanAdliKaldi],
      [1, 3, 2, 1, 0, 0, 0],
    );
    AYNI(t, 'MUSTERI_B/P-YENI', ic('YENI', 1));
    AYNI(t, 'MUSTERI_B/P-ESKI', ic('ESKI', 2));
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('FARKLI', 3));
    AYNI(t, 'MUSTERI_B/P-BOYUT', ic('BOYUT_A', 1));
    // dokunulmayanlar
    AYNI(t, 'MUSTERI_B/P-AYNI', ic('AYNI', 1));
    AYNI(t, 'MUSTERI_B/SADECE-TORNA', ic('OZEL', 1));
    AYNI(t, 'AA/P-CALISAN', ic('CALISAN', 1));
    assert.equal(t.server.read('O9001').toString('latin1'), 'M99\r\n', 'kök dizindeki ortak program');
    assert.deepEqual(artik(t), ['AA/ZZUP123456'], 'kendi geçici/yan adlı dosyamız kalmadı; eski artığa dokunulmadı');

    // yedekler: tornadaki ESKI haller kutuphanede
    const bFarkli = t.library.db.listBackups('MUSTERI_B', 'P-FARKLI');
    assert.equal(bFarkli.length, 1);
    assert.ok(t.library.db.getBackup(bFarkli[0].id).content.equals(ic('TORNA-ELI', 9)));
    assert.equal(t.library.db.listBackups('MUSTERI_B', 'P-BOYUT').length, 1);
    assert.equal(t.library.db.listBackups('MUSTERI_B', 'P-ESKI').length, 0, 'zaten kütüphanede v1');
    // yedekler SURUM degildir: surum numaralari ve "guncel surum" bozulmaz
    assert.equal(t.library.db.listVersions(t.library.db.findProgram('MUSTERI_B', 'P-FARKLI').id).length, 1);

    // yalniz kendi gecici/yan adli dosyalarimiz silinir; hicbir RNTO mevcut bir adin uzerine gitmez (mock default: 550 verirdi)
    for (const k of komutlar(t.server, 'DELE')) assert.match(k, /^DELE ZZ(UP|RB)\d{6}$/, `izinsiz DELE: ${k}`);
    assert.equal(komutlar(t.server, 'DELE').length, 3, 'yalnız ezilen 3 programın yan adlı dosyası');
    assert.equal(komutlar(t.server, 'MKD').length, 0, 'klasör açılmaz');

    // denetim: program basina bir kayit (kind toplu), adimlar
    const rows = t.library.db.listTransfers({ machineId: 'CNC-08' }).filter((r) => r.kind === 'toplu');
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.status === 'basarili' && r.requestedBy === 'ayse'));
    const farkliRow = rows.find((r) => r.name === 'P-FARKLI');
    assert.ok(farkliRow.steps.some((x) => x.step === 'yedek' && x.ok && /yedek #/.test(x.detail)));
    assert.ok(farkliRow.steps.some((x) => x.step === 'yedek-temizle' && x.ok));

    // envanter/matris guncellendi
    const cmp = t.library.compareMachine('CNC-08');
    const durum = Object.fromEntries(cmp.entries.map((e) => [`${e.customer}/${e.name}`, e.status]));
    assert.deepEqual([durum['MUSTERI_B/P-YENI'], durum['MUSTERI_B/P-ESKI'], durum['MUSTERI_B/P-FARKLI'], durum['MUSTERI_B/P-BOYUT']], ['guncel', 'guncel', 'guncel', 'guncel']);

    // kaldigi yerden: yeni plan = hepsi ayni (calisan program haric)
    const { plan: p2 } = await planla(t);
    assert.deepEqual([p2.summary.yeni, p2.summary.ezilecek, p2.summary.ayni, p2.summary.atlanan], [0, 0, 5, 2]);
  } finally { await t.kapat(); }
});

test('UYGULA: ozel secim (skipKeys) disinda kalanlara dokunulmaz; plan ikinci kez uygulanamaz (409)', async () => {
  const t = await kurPush();
  try {
    const { id, plan } = await planla(t);
    const atla = plan.ezilecek.filter((x) => x.name !== 'P-ESKI').map((x) => x.key);
    const a = await uygula(t, id, { skipKeys: atla });
    assert.deepEqual([a.counts.yeni, a.counts.ezilen], [1, 1]);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9));
    assert.throws(() => basla(t, id), (e) => e.status === 409);
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------------ kapilar */

test('KAPILAR: yanlis onay metni, kapali ozellik, dogrulanmamis model (22TB), plan yok, bos secim', async () => {
  const t = await kurPush();
  try {
    const { id, plan } = await planla(t);
    assert.throws(() => basla(t, id, { confirm: 'CNC-01' }), /CNC-08/);
    assert.throws(() => basla(t, 'yok-boyle-plan'), /Plan bulunamadı/);
    assert.throws(() => basla(t, id, { skipKeys: [...plan.yeni, ...plan.ezilecek].map((x) => x.key) }), /Gönderilecek program yok/);
    assert.equal(komutlar(t.server, 'STOR').length, 0, 'reddedilen istek tornaya yazmaz');

    t.machines[0].controllerModel = '22TB'; // config/drivers.json: sendEnabled=false
    assert.throws(() => basla(t, id), UnsupportedError);
    const p22 = await planla(t); // plan (okuma) kapali modelde de cikar, kapi planda gorunur
    assert.equal(p22.plan.gate.allowed, false);
    assert.match(p22.plan.gate.reason, /doğrulan/i);
    assert.equal(komutlar(t.server, 'STOR').length, 0);
  } finally { await t.kapat(); }

  const kapali = await kurPush({ disabled: true });
  try {
    const { id } = await planla(kapali);
    assert.throws(() => basla(kapali, id), DisabledError);
  } finally { await kapali.kapat(); }
});

test('KAPILAR: canli veri yoksa "unknown-state" onayi gerekir; onayla devam eder', async () => {
  const t = await kurPush({ live: null });
  try {
    const { id, plan } = await planla(t);
    assert.equal(plan.unknownState, true);
    assert.equal(plan.summary.atlanan, 1, 'çalışan program bilinmiyor: yalnız klasörü olmayan atlanır');
    assert.throws(() => basla(t, id), (e) => e.code === 'unknown-state');
    const a = await uygula(t, id, { acks: ['unknown-state'] });
    assert.equal(a.status, 'bitti');
    assert.equal(a.counts.hata, 0);
  } finally { await t.kapat(); }
});

test('KAPILAR: islem suruyorsa (uygulama) ikinci plan/uygulama 409', async () => {
  const t = await kurPush({ ftp: { delayMs: 15 } });
  try {
    const { id } = await planla(t);
    basla(t, id);
    assert.throws(() => t.files.startPushPlan({ machineId: 'CNC-08' }), BusyError);
    assert.throws(() => t.files.startImportPlan({ machineId: 'CNC-08' }), BusyError);
    await bekle(() => t.files.getPushPlan('CNC-08', id).apply, (a) => a.status !== 'calisiyor');
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------------ hata enjeksiyonu */

test('HATA: bozuk iletim (SHA tutmuyor) -> tornadaki dosyaya HIC dokunulmaz, gecici dosya silinir, yan ad yok, yedek yok', async () => {
  const t = await kurPush({ ftp: { corruptStor: true } });
  try {
    const { id } = await planla(t);
    const a = await uygula(t, id);
    assert.equal(a.counts.hata, 4);
    assert.equal(a.counts.ezilen + a.counts.yeni, 0);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9));
    AYNI(t, 'MUSTERI_B/P-ESKI', ic('ESKI', 1));
    assert.equal(t.server.read('MUSTERI_B/P-YENI'), null);
    assert.deepEqual(artik(t), ['AA/ZZUP123456']);
    assert.equal(t.library.db.stats().backups, 0, 'tornaya hiç dokunulmadığı için yedek de alınmadı');
    assert.equal(komutlar(t.server, 'RNFR').length, 0, 'doğrulanmayan dosya için hiçbir yeniden adlandırma yapılmadı');
  } finally { await t.kapat(); }
});

test('HATA: yeni dosya nihai ada cevrilemezse (RNTO 550) ESKI HAL GERI KONUR, gecici dosya silinir', async () => {
  const t = await kurPush({ ftp: { failRntoWhen: (to, from) => from.startsWith('ZZUP') } });
  try {
    const { id, plan } = await planla(t);
    const a = await uygula(t, id, { skipKeys: plan.yeni.map((x) => x.key) });
    assert.equal(a.counts.hata, 3);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9));
    AYNI(t, 'MUSTERI_B/P-ESKI', ic('ESKI', 1));
    AYNI(t, 'MUSTERI_B/P-BOYUT', ic('BOYUT_B', 1));
    assert.deepEqual(artik(t), ['AA/ZZUP123456'], 'yan adlı dosya asıl adına döndü, geçici dosya silindi');
    const row = t.library.db.listTransfers({ machineId: 'CNC-08' }).find((r) => r.kind === 'toplu' && r.name === 'P-FARKLI');
    assert.equal(row.status, 'basarisiz');
    assert.ok(row.steps.some((x) => x.step === 'geri-al' && x.ok && /eski hal geri konuldu/.test(x.detail)));
  } finally { await t.kapat(); }
});

test('HATA: yedek kutuphaneye yazilamazsa eski hal geri konur ve ezilmez', async () => {
  const t = await kurPush();
  try {
    const { id } = await planla(t);
    t.library.db.addBackup = () => { throw new Error('disk dolu'); };
    const a = await uygula(t, id);
    // yedek gerektirmeyen (kutuphanede v1 olan) P-ESKI ve yeni P-YENI yazilir; yedek gerektiren 2 program yazilmaz
    assert.deepEqual([a.counts.yeni, a.counts.ezilen, a.counts.hata], [1, 1, 2]);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9));
    AYNI(t, 'MUSTERI_B/P-BOYUT', ic('BOYUT_B', 1));
    assert.deepEqual(artik(t), ['AA/ZZUP123456']);
    assert.match(sonuc(a, 'P-FARKLI').detail, /disk dolu/);
  } finally { await t.kapat(); }
});

test('HATA: geri alma da basarisiz olursa "dogrulanamadi" + eski halin yan adi acikca raporlanir (tornada veri kaybi yok)', async () => {
  const t = await kurPush({ ftp: { failRntoWhen: (to, from) => /^ZZ(UP|RB)/.test(from) } });
  try {
    const { id, plan } = await planla(t);
    const a = await uygula(t, id, { skipKeys: [...plan.yeni, ...plan.ezilecek].filter((x) => x.name !== 'P-FARKLI').map((x) => x.key) });
    assert.equal(a.total, 1);
    assert.equal(a.results[0].status, 'dogrulanamadi');
    assert.match(a.results[0].detail, /GERİ ALMA BAŞARISIZ/);
    const yanAd = t.server.names('MUSTERI_B').find((n) => /^ZZRB\d{6}$/.test(n));
    assert.ok(yanAd, 'eski hal yan adla duruyor');
    assert.ok(t.server.read(`MUSTERI_B/${yanAd}`).equals(ic('TORNA-ELI', 9)), 'içerik kayıpsız');
    assert.match(a.results[0].detail, new RegExp(yanAd));
    assert.equal(t.library.db.listBackups('MUSTERI_B', 'P-FARKLI').length, 1, 'kütüphanede de yedek var');
  } finally { await t.kapat(); }
});

test('UYARI: yan adli dosya silinemezse (DELE 550) yazma basarili sayilir, dosya kalir ve raporlanir; sonraki plan artigi uyarir', async () => {
  const t = await kurPush({ ftp: { failDeleWhen: (n) => n.startsWith('ZZRB') } });
  try {
    const { id } = await planla(t);
    const a = await uygula(t, id);
    assert.equal(a.counts.hata, 0);
    assert.equal(a.counts.yanAdliKaldi, 3);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('FARKLI', 3));
    assert.equal(t.server.names('MUSTERI_B').filter((n) => n.startsWith('ZZRB')).length, 3);
    assert.match(sonuc(a, 'P-FARKLI').warning, /silinemedi/);
    const { plan } = await planla(t);
    assert.ok(plan.warnings.some((w) => /4 aktarım artığı/.test(w)), 'üç yan adlı dosya + önceki ZZUP artığı');
  } finally { await t.kapat(); }
});

test('YARIS: plandan sonra operator dosyayi degistirdiyse ezilen, PLAN ANINDAKI degil O ANKI hal yedeklenir', async () => {
  const t = await kurPush();
  try {
    const { id } = await planla(t);
    t.server.put('MUSTERI_B/P-FARKLI', ic('OPERATOR-DUZELTTI', 5));
    await uygula(t, id);
    const [b] = t.library.db.listBackups('MUSTERI_B', 'P-FARKLI');
    assert.ok(t.library.db.getBackup(b.id).content.equals(ic('OPERATOR-DUZELTTI', 5)));
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('FARKLI', 3));
  } finally { await t.kapat(); }
});

test('YARIS: uygulama aninda torna o programi calistiriyorsa atlanir (yazilmaz); plandan sonra yeni surum olduysa atlanir', async () => {
  let canli = { connected: true, state: 'RUNNING', program: 'P-CALISAN', mainProgram: 'P-CALISAN' };
  const t = await kurPush({ live: () => canli });
  try {
    const { id } = await planla(t);
    canli = { connected: true, state: 'RUNNING', program: 'P-FARKLI', mainProgram: 'P-FARKLI' }; // operator baska programa gecti
    ekle(t.library, 'MUSTERI_B', 'P-BOYUT', ic('BOYUT_A', 2)); // kutuphanede yeni surum
    const a = await uygula(t, id);
    assert.equal(sonuc(a, 'P-FARKLI').outcome, 'atlandi');
    assert.match(sonuc(a, 'P-FARKLI').detail, /çalıştırıyor/);
    assert.equal(sonuc(a, 'P-BOYUT').outcome, 'atlandi');
    assert.match(sonuc(a, 'P-BOYUT').detail, /yeni sürüm oluştu/);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9));
    AYNI(t, 'MUSTERI_B/P-BOYUT', ic('BOYUT_B', 1));
    const rows = t.library.db.listTransfers({ machineId: 'CNC-08' }).filter((r) => r.kind === 'toplu' && r.status === 'reddedildi');
    assert.equal(rows.length, 2, 'atlananlar da denetim kaydında');
    assert.equal(a.counts.yeni + a.counts.ezilen, 2, 'diğerleri yazıldı');
  } finally { await t.kapat(); }
});

test('HATA: baglanti surekli koparsa is biter, kalanlar "hata" olur, tornada hicbir dosya degismez', async () => {
  const t = await kurPush({ ftp: { dropOnStor: true } });
  try {
    const { id } = await planla(t);
    const a = await uygula(t, id);
    assert.equal(a.status, 'bitti');
    assert.equal(a.counts.hata, 4);
    AYNI(t, 'MUSTERI_B/P-FARKLI', ic('TORNA-ELI', 9));
    AYNI(t, 'MUSTERI_B/P-ESKI', ic('ESKI', 1));
    assert.deepEqual(artik(t), ['AA/ZZUP123456']);
  } finally { await t.kapat(); }
});

test('DURDUR: uygulama durdurulur (o anki program bitirilir), kalanlara dokunulmaz; yeni plan kaldigi yerden surdurur', async () => {
  const t = await kurPush({ ftp: { delayMs: 12 } });
  try {
    const { id } = await planla(t);
    basla(t, id);
    await bekle(() => t.files.getPushPlan('CNC-08', id).apply, (x) => x.done >= 1);
    t.files.stopPushApply({ machineId: 'CNC-08', planId: id });
    const a = await bekle(() => t.files.getPushPlan('CNC-08', id).apply, (x) => x.status !== 'calisiyor');
    assert.equal(a.status, 'durduruldu');
    assert.ok(a.done < a.total, `durdu: ${a.done}/${a.total}`);
    assert.deepEqual(artik(t), ['AA/ZZUP123456'], 'yarım iş bırakmadı');

    const { id: id2, plan } = await planla(t);
    assert.ok(plan.summary.ayni >= 1);
    const b = await uygula(t, id2);
    assert.equal(b.status, 'bitti');
    const { plan: son } = await planla(t);
    assert.deepEqual([son.summary.yeni, son.summary.ezilecek], [0, 0]);
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------------ yedekler + HTTP */

test('YEDEK: kutuphaneye YENI SURUM olarak geri alinir (surum numarasi ileri gider); ayni icerik tekrar yedeklenmez', async () => {
  const t = await kurPush();
  try {
    const { id } = await planla(t);
    await uygula(t, id);
    const prog = t.library.db.findProgram('MUSTERI_B', 'P-FARKLI');
    const [b] = t.library.db.listBackups('MUSTERI_B', 'P-FARKLI');
    const r = t.library.restoreBackup({ id: b.id, by: 'ayse' });
    assert.equal(r.created, true);
    assert.equal(r.version.versionNo, 2);
    assert.equal(r.version.source, 'yedek');
    assert.ok(t.library.db.getVersion(prog.id, 2).content.equals(ic('TORNA-ELI', 9)));
    assert.throws(() => t.library.restoreBackup({ id: 99999 }), /Yedek bulunamadı/);

    // ayni icerik ikinci kez ezilirse (baska torna) yeni yedek satiri acilmaz
    const x = t.library.db.addBackup({ customer: 'MUSTERI_B', name: 'P-FARKLI', machineId: 'CNC-01', content: ic('TORNA-ELI', 9), sha256: sha256(ic('TORNA-ELI', 9)) });
    assert.equal(x.created, false);
    assert.equal(x.id, b.id);
  } finally { await t.kapat(); }
});

test('HTTP: plan -> uygula -> ilerleme/sonuc, durdur, onay hatasi 400, plan yok 404, ikinci uygulama 409; yedek listesi/indirme/geri alma', async () => {
  const t = await kurPush();
  const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json().catch(() => null), res: r }; };
  const post = (path, obj) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
  try {
    const cfg = await j('/api/library/config');
    assert.equal(cfg.body.bulkPush, true);
    assert.equal(cfg.body.overwriteEnabled, false, 'tek program gönderme hâlâ ezmez');

    const pl = await post('/api/machines/CNC-08/programs/push-plan', {});
    assert.equal(pl.status, 202);
    const planId = pl.body.planId;
    let g;
    for (let i = 0; i < 400; i += 1) { g = await j(`/api/machines/CNC-08/programs/push-plan/${planId}`); if (g.body.status !== 'calisiyor') break; await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(g.body.status, 'bitti');
    assert.equal(g.body.apply, null);
    assert.equal(g.body.plan.summary.ezilecek, 3);

    assert.equal((await post('/api/machines/CNC-08/programs/push-apply', { planId, confirm: 'CNC-01' })).status, 400);
    assert.equal((await post('/api/machines/CNC-08/programs/push-apply', { planId: 'yok', confirm: 'CNC-08' })).status, 404);
    const ap = await post('/api/machines/CNC-08/programs/push-apply', { planId, confirm: 'CNC-08', by: 'ayse' });
    assert.equal(ap.status, 202);
    assert.equal(ap.body.total, 4);
    assert.equal((await post('/api/machines/CNC-08/programs/push-apply', { planId, confirm: 'CNC-08' })).status, 409);
    for (let i = 0; i < 400; i += 1) { g = await j(`/api/machines/CNC-08/programs/push-plan/${planId}`); if (g.body.apply.status !== 'calisiyor') break; await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(g.body.apply.status, 'bitti');
    assert.equal(g.body.apply.results.length, 4);
    assert.equal((await post('/api/machines/CNC-08/programs/push-stop', { planId })).status, 404, 'çalışan iş yok');

    // yedekler
    const prog = await j(`/api/library/programs/${t.library.db.findProgram('MUSTERI_B', 'P-FARKLI').id}`);
    assert.equal(prog.body.backups.length, 1);
    const bid = prog.body.backups[0].id;
    assert.equal('content' in prog.body.backups[0], false, 'liste içerik taşımaz');
    const dl = await fetch(`${base}/api/library/backups/${bid}?download=1`);
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(ic('TORNA-ELI', 9)));
    assert.match(dl.headers.get('content-disposition'), /filename="P-FARKLI"/);
    assert.equal((await j('/api/library/backups/9999')).status, 404);
    const rs = await post(`/api/library/backups/${bid}/restore`, { by: 'ayse' });
    assert.equal(rs.status, 201);
    assert.equal(rs.body.version.versionNo, 2);
  } finally { await new Promise((r) => srv.close(r)); await t.kapat(); }
});
