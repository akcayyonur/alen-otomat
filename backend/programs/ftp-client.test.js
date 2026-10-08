/**
 * FTP istemcisi ve LIST cozumleyici testleri. Sahte sunucu, torna 8'in gercek
 * (Windows CE 7.0) protokol diyalogunu taklit eder; bkz. test/mock-ftp.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FtpClient, FtpError, withFtp } from './ftp-client.js';
import { parseList } from './list-parse.js';
import { MockFtpServer } from './test/mock-ftp.js';

async function sunucu(opts, hazirla) {
  const s = new MockFtpServer(opts);
  hazirla?.(s);
  await s.start();
  return s;
}
const secenek = (s) => ({ host: '127.0.0.1', port: s.port, commandTimeoutMs: 2_000, connectTimeoutMs: 2_000, dataIdleTimeoutMs: 2_000 });

test('LIST cozumleyici: gercek torna 8 cikti bicimi (DOS)', () => {
  // Birebir gercek satirlar (adlar degistirilmis).
  const metin = [
    '10-07-26  08:19                   22 MDIBlock',
    '02-19-26  06:28                  244 O9001',
    '01-12-26  15:18       <DIR>          MUSTERI_C',
    '12-16-25  14:20       <DIR>          MUSTERI A',
    '01-02-26  15:46                  916 140100102',
    '',
  ].join('\r\n');
  const { entries, unparsed } = parseList(metin);
  assert.equal(unparsed.length, 0);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries[0], { name: 'MDIBlock', isDir: false, size: 22, modified: '2026-10-07 08:19' });
  assert.deepEqual(entries[2], { name: 'MUSTERI_C', isDir: true, size: null, modified: '2026-01-12 15:18' });
  assert.equal(entries[3].name, 'MUSTERI A', 'bosluklu klasor adi korunmali');
  assert.equal(entries[4].size, 916);
});

test('LIST cozumleyici: eski yil (>=70) ve AM/PM, UNIX bicimi, tanimsiz satir', () => {
  const dos = parseList('12-31-99  11:05PM          10 ESKI\r\n01-01-00  12:00AM         <DIR> YENI');
  assert.equal(dos.entries[0].modified, '1999-12-31 23:05');
  assert.equal(dos.entries[1].modified, '2000-01-01 00:00');

  const unix = parseList('total 8\r\n-rw-r--r-- 1 user group 1555 Oct  7 14:55 ORNEK-013\r\ndrwxr-xr-x 2 user group 0 Dec 16 2025 MUSTERI_B\r\nbozuk satir');
  assert.equal(unix.entries.length, 2);
  assert.equal(unix.entries[0].size, 1555);
  assert.equal(unix.entries[1].isDir, true);
  assert.equal(unix.unparsed.length, 1);
});

test('istemci: baglan, kok LIST, alt klasore gir, geri cik', async () => {
  const s = await sunucu({}, (m) => { m.put('O9001', 'M99\r\n'); m.mkdir('AA'); m.put('AA/ORNEK', 'G0\r\n'); });
  try {
    await withFtp(secenek(s), async (c) => {
      const kok = parseList(await c.listRaw()).entries;
      assert.deepEqual(kok.map((e) => e.name).sort(), ['AA', 'O9001']);
      await c.cwd('AA');
      assert.deepEqual(parseList(await c.listRaw()).entries.map((e) => e.name), ['ORNEK']);
      assert.equal(await c.pwd(), '/AA');
      await c.toRoot();
      assert.equal(await c.pwd(), '/');
    });
    assert.ok(s.commands.includes('USER anonymous'));
    assert.ok(s.commands.some((k) => k.startsWith('EPSV')), 'once EPSV denenmeli');
    assert.ok(!s.commands.some((k) => k.startsWith('FEAT')), 'olmayan FEAT\'e gerek yok');
  } finally { await s.stop(); }
});

// GERCEK TORNA bulgusu (.99, 2026-10-07): bos klasorde LIST, 125'den hemen sonra 226 verir, veri kanalina
// hic bayt gondermez ve kanali KAPATMAZ. Kanalin kapanmasini bekleyen istemci 20 sn zaman asimina duser
// (ilk gercek gonderme denemesi "veri aktarimi zaman asimina ugradi" ile boyle basarisiz oldu).
test('istemci: bos klasorde sunucu veri kanalini kapatmaz -> 226 ile biter, zaman asimina dusmez', async () => {
  const s = await sunucu({ holdEmptyData: true }, (m) => { m.mkdir('BOS'); m.mkdir('AA'); m.put('AA/DOLU', 'G0\r\n'); m.put('AA/BOSDOSYA', ''); });
  try {
    await withFtp({ ...secenek(s), dataIdleTimeoutMs: 10_000 }, async (c) => {
      await c.cwd('BOS');
      const t0 = Date.now();
      assert.equal(parseList(await c.listRaw()).entries.length, 0);
      assert.ok(Date.now() - t0 < 3_000, `veri kanalinin kapanmasini beklememeli (${Date.now() - t0} ms)`);
      await c.cdup();

      // Ayni oturum sonraki komutlarla surer; dolu klasor ve bos dosya da dogru okunur.
      await c.cwd('AA');
      assert.deepEqual(parseList(await c.listRaw()).entries.map((e) => e.name).sort(), ['BOSDOSYA', 'DOLU']);
      const t1 = Date.now();
      assert.equal((await c.retr('BOSDOSYA')).length, 0);
      assert.ok(Date.now() - t1 < 3_000, 'bos dosya RETR de kanalin kapanmasini beklememeli');
      assert.equal((await c.retr('DOLU')).toString(), 'G0\r\n');
    });
  } finally { await s.stop(); }
});

test('istemci: bos klasorun LIST sonucu 0 satirdir (hata degil)', async () => {
  const s = await sunucu({}, (m) => m.mkdir('AA'));
  try {
    await withFtp(secenek(s), async (c) => {
      await c.cwd('AA');
      assert.equal(parseList(await c.listRaw()).entries.length, 0);
    });
  } finally { await s.stop(); }
});

test('istemci: STOR ikili modda ve bayt bayt ayni, RETR geri okur', async () => {
  const s = await sunucu({}, (m) => m.mkdir('AA'));
  // CRLF, satir sonu bosluklari, sondaki bos satirlar ve 0xFF/0x00 baytlari: hicbiri degismemeli.
  const icerik = Buffer.concat([Buffer.from('//T\r\nG0 X1. \r\n\r\n\r\n', 'latin1'), Buffer.from([0x00, 0xff, 0x0d, 0x0a])]);
  try {
    await withFtp(secenek(s), async (c) => {
      await c.cwd('AA');
      await c.stor('ZZUP1', icerik);
      const geri = await c.retr('ZZUP1');
      assert.ok(geri.equals(icerik), 'geri okunan icerik ayni olmali');
    });
    assert.ok(s.read('AA/ZZUP1').equals(icerik));
    assert.ok(s.commands.includes('TYPE I'), 'dosya aktarimi ikili modda olmali');
  } finally { await s.stop(); }
});

test('istemci: rename ve dele; olmayan dosyada FtpError', async () => {
  const s = await sunucu({}, (m) => { m.mkdir('AA'); m.put('AA/ZZUP1', 'x'); });
  try {
    await withFtp(secenek(s), async (c) => {
      await c.cwd('AA');
      await c.rename('ZZUP1', 'ORNEK-013');
      assert.deepEqual(s.names('AA'), ['ORNEK-013']);
      await assert.rejects(() => c.retr('YOKTUR'), (e) => e instanceof FtpError && e.code === 550);
      await c.dele('ORNEK-013');
      assert.deepEqual(s.names('AA'), []);
    });
  } finally { await s.stop(); }
});

test('istemci: salt okunur sunucuda STOR reddi anlasilir hata verir', async () => {
  const s = await sunucu({ readOnly: true }, (m) => m.mkdir('AA'));
  try {
    await withFtp(secenek(s), async (c) => {
      await c.cwd('AA');
      await assert.rejects(() => c.stor('ZZUP1', Buffer.from('x')), (e) => e instanceof FtpError && e.code === 550 && e.step === 'STOR');
    });
  } finally { await s.stop(); }
});

test('istemci: komut enjeksiyonu ve yol gezinmesi reddedilir (sunucuya hic gitmez)', async () => {
  const s = await sunucu({}, (m) => m.mkdir('AA'));
  try {
    await withFtp(secenek(s), async (c) => {
      await assert.rejects(() => c.retr('A\r\nDELE ZZ'), FtpError);
      await assert.rejects(() => c.retr('../O9001'), FtpError);
      await assert.rejects(() => c.cwd('AA/BB'), FtpError);
      await assert.rejects(() => c.cwd('..'), FtpError);
      await assert.rejects(() => c.rename('A', 'B\0C'), FtpError);
      await assert.rejects(() => c.stor('X\\Y', Buffer.from('x')), FtpError);
    });
    assert.ok(!s.commands.some((k) => /^DELE/.test(k)), 'enjekte edilen komut sunucuya ulasmamali');
  } finally { await s.stop(); }
});

test('istemci: sunucu yanit vermezse zaman asimi, baglanti kapanir', async () => {
  const s = await sunucu({ delayMs: 1_500 });
  try {
    const c = new FtpClient({ ...secenek(s), commandTimeoutMs: 300 });
    await assert.rejects(() => c.connect(), (e) => e instanceof FtpError && /yanıt vermedi/.test(e.message));
    c.close();
  } finally { await s.stop(); }
});

test('istemci: kapali port icin okunur hata', async () => {
  const c = new FtpClient({ host: '127.0.0.1', port: 1, connectTimeoutMs: 500 });
  await assert.rejects(() => c.connect(), (e) => e instanceof FtpError && e.step === 'connect');
});

test('istemci: RETR boyut siniri asilirsa durur', async () => {
  const s = await sunucu({}, (m) => m.put('BUYUK', Buffer.alloc(5_000, 65)));
  try {
    await withFtp(secenek(s), async (c) => {
      await assert.rejects(() => c.retr('BUYUK', { maxBytes: 1_000 }), (e) => e instanceof FtpError && /çok büyük/.test(e.message));
    });
  } finally { await s.stop(); }
});
