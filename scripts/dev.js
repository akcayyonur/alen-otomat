/**
 * Gelistirme kolayligi: backend + simulatoru tek komutla baslatir.
 * (Uretimde ikisi ayri makinede calisir - Edge Agent atolye tarafinda.)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = (name, relative) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL(relative, import.meta.url))], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} durdu (kod ${code}) - hepsi kapatiliyor`);
    process.exit(code ?? 0);
  });
  return child;
};

const backend = run('backend', '../backend/server.js');
// Backend'in portu acmasi icin kisa bir gecikme; simulator zaten yeniden dener.
setTimeout(() => run('simulator', '../simulator/index.js'), 700);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    backend.kill();
    process.exit(0);
  });
}
