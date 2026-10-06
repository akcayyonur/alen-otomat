/**
 * `--log <dosya>`: backend ciktisini dosyaya da yazar. Servis olarak Gorev
 * Zamanlayici node'u DOGRUDAN calistirir (cmd /c ... >> log sarmalayicisi yok),
 * bu yuzden gunlugu surecin kendisi tutmali.
 *
 * Gercek bir backend sureci baslatilir: console yamasi ancak boyle sinanir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backend'i verilen argumanlarla baslatir; log dosyasinda `bekle` gorunene dek bekler. */
async function calistir(args, logFile, bekle) {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-log-'));
  const port = 38000 + Math.floor(Math.random() * 900);
  const cocuk = spawn(process.execPath, [SERVER, ...args(dir)], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: join(dir, 't.db') },
    stdio: 'ignore',
  });
  const dosya = logFile(dir);
  try {
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      if (existsSync(dosya) && readFileSync(dosya, 'utf8').includes(bekle)) break;
    }
    return existsSync(dosya) ? readFileSync(dosya, 'utf8') : null;
  } finally {
    cocuk.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--log: ciktiyi zaman damgasiyla dosyaya yazar, olmayan klasoru olusturur', async () => {
  const icerik = await calistir(
    (dir) => ['--log', join(dir, 'ic', 'ice', 'backend.log')],
    (dir) => join(dir, 'ic', 'ice', 'backend.log'),
    '[backend] veritabani',
  );

  assert.ok(icerik, 'log dosyasi olusmadi');
  assert.match(icerik, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[backend\] dashboard/m, 'zaman damgali satir yok');
  assert.match(icerik, /\[backend\] veritabani -> /);
});

test('--log yoksa dosya yazilmaz: gelistirmede cikti yalnizca ekrana gider', async () => {
  const icerik = await calistir(
    () => [],
    (dir) => join(dir, 'olmamali.log'),
    'asla-gorunmeyecek',
  );
  assert.equal(icerik, null);
});
