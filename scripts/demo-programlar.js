/**
 * Program kutuphanesi DEMOSU - torna olmadan.
 *
 * Gercek bir tornanin Windows CE FTP sunucusunu taklit eden iki SAHTE FTP sunucusu
 * (CNC-07 :2122, CNC-08 :2121), sahte telemetri (simulator) ve backend'i birlikte
 * baslatir. Dosya sistemleri uydurma musteri klasorleri ve uydurma programlarla
 * dolu (gercek musteri verisi YOK); kutuphane de birkac ornek programla tohumlanir:
 * guncel / eski / farkli / tezgahta-yok durumlarini gostermek icin.
 *
 * Her sey gecici bir klasore yazilir; kapaninca silinir. config/machines.json,
 * data/ ve gercek tezgahlara DOKUNULMAZ.
 *
 *   npm run demo:programlar
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockFtpServer } from '../backend/programs/test/mock-ftp.js';

const kok = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.PORT ?? '3000';
const tmp = mkdtempSync(join(tmpdir(), 'cnc-demo-programlar-'));

/** Uydurma NC programi (gercek icerik degil): CRLF, $1/$2 kanallari, // yorum. */
function nc(ad, aciklama, ek = '') {
  return Buffer.from(
    `//${ad}  ${aciklama}\r\n$1\r\nG0 X0. Z0.\r\nT1 G0 X20. Z2.\r\nG1 Z-10. F0.2\r\nG0 X30.${ek}\r\nM99\r\n\r\n$2\r\nN11\r\nG0 Z20.\r\nM99\r\n\r\n`,
    'latin1',
  );
}

// ---------------------------------------------------------------- sahte tornalar
const t8 = new MockFtpServer();
const t7 = new MockFtpServer();
const eski = (g) => new Date(Date.now() - g * 86_400_000);

for (const s of [t7, t8]) {
  s.put('MDIBlock', 'M99\r\n');
  s.put('O9001', 'M99\r\n', eski(200));
  for (const m of ['ALFA', 'BETA', 'GAMA', 'DELTA']) s.mkdir(m);
}
// CNC-08: ALFA/BETA/GAMA dolu, DELTA bos (yeni musteri klasoru gibi), KAPPA buyuk klasor (130 dosya)
t8.put('ALFA/ALF-001', nc('ALF-001', 'FLANS 12 MM'), eski(40));
t8.put('ALFA/ALF-002', nc('ALF-002', 'SOMUN 3/4'), eski(40));
t8.put('ALFA/ALF-003', nc('ALF-003', 'YUZUK'), eski(12));
t8.put('BETA/BET-010', nc('BET-010', 'PIM', '\r\nG4 X0.1'), eski(90));   // kutuphanedekinden FARKLI
t8.put('BETA/BET-011', nc('BET-011', 'BUSON'), eski(90));
t8.put('GAMA/100200300', nc('100200300', 'ORNEK TEST PROGRAMI'), eski(3));
t8.mkdir('KAPPA');
for (let i = 1; i <= 130; i += 1) t8.put(`KAPPA/KAP-${String(i).padStart(3, '0')}`, nc(`KAP-${i}`, 'DEMO'), eski(30 + (i % 50)));
// CNC-07: daha az program; ALF-001 burada ESKI surum
t7.put('ALFA/ALF-001', nc('ALF-001', 'FLANS 12 MM'), eski(80));
t7.put('GAMA/GAM-005', nc('GAM-005', 'KAPAK'), eski(10));

await t8.start(2121);
await t7.start(2122);

// ---------------------------------------------------------- gecici envanter dosyasi
const inv = JSON.parse(readFileSync(join(kok, 'config/machines.json'), 'utf8'));
for (const m of inv.machines) {
  if (m.id === 'CNC-08') Object.assign(m, { ip: '127.0.0.1', ftpPort: 2121, name: 'ARIX Torna 8 (DEMO)' });
  else if (m.id === 'CNC-07') Object.assign(m, { ip: '127.0.0.1', ftpPort: 2122, name: 'ARIX Torna 7 (DEMO)' });
  else m.ip = null;
}
const machinesFile = join(tmp, 'machines.json');
writeFileSync(machinesFile, JSON.stringify(inv, null, 2));

// ---------------------------------------------------------------------- surecler
const env = {
  ...process.env,
  PORT,
  DB_FILE: join(tmp, 'telemetry.db'),
  LIBRARY_DB_FILE: join(tmp, 'library.db'),
  MACHINES_FILE: machinesFile,
};
const child = (ad, dosya, e = env) => {
  const c = spawn(process.execPath, [join(kok, dosya)], { stdio: 'inherit', env: e, cwd: kok });
  c.on('exit', (kod) => { console.log(`[demo] ${ad} durdu (kod ${kod})`); kapat(kod ?? 0); });
  return c;
};
const backend = child('backend', 'backend/server.js');
let sim;

let kapaniyor = false;
function kapat(kod = 0) {
  if (kapaniyor) return;
  kapaniyor = true;
  backend.kill();
  sim?.kill();
  t7.stop();
  t8.stop();
  setTimeout(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* kilitli olabilir */ } process.exit(kod); }, 400);
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => kapat(0));

// ---------------------------------------------------------------- kutuphaneyi tohumla
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* henuz acilmadi */ }
  await new Promise((r) => setTimeout(r, 250));
}
sim = child('simulator', 'simulator/index.js', { ...env, INGEST_URL: `${base}/api/ingest` });

async function yukle(musteri, ad, icerik, not = '') {
  const q = new URLSearchParams({ customer: musteri, name: ad, by: 'Demo', note: not });
  await fetch(`${base}/api/library/programs?${q}`, { method: 'POST', body: icerik });
}
await yukle('ALFA', 'ALF-001', nc('ALF-001', 'FLANS 12 MM'), 'ilk sürüm');
await yukle('ALFA', 'ALF-001', nc('ALF-001', 'FLANS 12 MM', '\r\nG0 X40.'), 'bir pah eklendi');   // v2: CNC-07'de eski
await yukle('ALFA', 'ALF-002', nc('ALF-002', 'SOMUN 3/4'));
await yukle('ALFA', 'ALF-004', nc('ALF-004', 'DISLI'), 'henüz hiçbir tezgahta yok');
await yukle('BETA', 'BET-010', nc('BET-010', 'PIM'));                                           // CNC-08'dekinden farkli
await yukle('GAMA', 'GAM-005', nc('GAM-005', 'KAPAK'));
await yukle('GAMA', '100200300', nc('100200300', 'ORNEK TEST PROGRAMI'));
await yukle('', 'ORTAK-1', nc('ORTAK-1', 'ORTAK ALT PROGRAM'), 'kök dizin (ortak alan) örneği');
for (const id of ['CNC-07', 'CNC-08']) {
  const r = await fetch(`${base}/api/machines/${id}/programs/scan`, { method: 'POST' });
  console.log(`[demo] ${id} tarandı: ${(await r.json()).entries} program`);
}

console.log('');
console.log(`[demo] Program kütüphanesi demosu hazır -> http://localhost:${PORT}/#/programlar`);
console.log('[demo] Sahte tornalar: CNC-08 (FTP :2121), CNC-07 (FTP :2122). Gerçek tornaya DOKUNULMAZ.');
console.log('[demo] Durdurmak için Ctrl+C.');
