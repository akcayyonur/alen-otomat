/**
 * Demo: backend + kayitli GERCEK verinin canli gibi oynatilmasi.
 *
 * `npm run dev` sahte veri uretir (simulator); bu ise dunku gercek tezgah
 * kaydini (data/gercek.db) oynatir. Backend AYRI bir veritabanina (data/demo.db)
 * yazar, boylece oynatilan veri gercek kaydi kirletmez. Her baslatmada
 * demo.db sifirlanir.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const yol = (goreli) => fileURLToPath(new URL(goreli, import.meta.url));

const DEMO_DB = 'data/demo.db';
for (const ek of ['', '-wal', '-shm']) rmSync(yol(`../${DEMO_DB}${ek}`), { force: true });

const run = (ad, goreli, env = {}) => {
  const child = spawn(process.execPath, [yol(goreli), ...(ad === 'oynat' ? process.argv.slice(2) : [])], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    console.log(`[demo] ${ad} durdu (kod ${code}) - hepsi kapatiliyor`);
    process.exit(code ?? 0);
  });
  return child;
};

const backend = run('backend', '../backend/server.js', { DB_FILE: DEMO_DB });
setTimeout(() => run('oynat', '../simulator/replay.js'), 700);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    backend.kill();
    process.exit(0);
  });
}
