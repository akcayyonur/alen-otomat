/**
 * Dosyaya gunluk: `--log <dosya>` verilirse console ciktisi hem ekrana hem
 * dosyaya yazilir (dosyada zaman damgasiyla).
 *
 * Servis olarak acilista cikti bir dosyaya gitmeli. Bunu `cmd /c "node ... >>
 * log 2>&1"` sarmalayicisiyla yapmak Gorev Zamanlayici'ya fazladan bir kabuk
 * katmani ekliyordu ve guvenlik yazilimlari bu zinciri supheli bulabiliyor.
 * Gunlugu surecin kendisi yazinca gorev dogrudan node'u calistirir.
 *
 * `--log` yoksa hicbir sey yapmaz: gelistirmede (npm start) cikti ekranda kalir.
 *
 * Dosya 10 MB'i asinca .1'e tasinir (eskisi silinir); servis aylarca acik
 * kalinca disk dolmasin.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format } from 'node:util';

const MAX_BYTES = 10 * 1024 * 1024;

const idx = process.argv.indexOf('--log');
const file = idx !== -1 && process.argv[idx + 1] ? resolve(process.argv[idx + 1]) : null;

if (file) {
  let size = 0;
  try {
    mkdirSync(dirname(file), { recursive: true });
    size = statSync(file).size;
  } catch {
    /* dosya yok ya da yazilamiyor: asagida her yazimda yeniden denenir */
  }

  const rotate = () => {
    try {
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
    } catch {
      /* kilitliyse bir sonraki yazimda tekrar denenir */
    }
    size = 0;
  };

  const write = (text) => {
    try {
      if (size > MAX_BYTES) rotate();
      const line = `${new Date().toISOString()} ${text}\n`;
      appendFileSync(file, line, 'utf8');
      size += Buffer.byteLength(line);
    } catch {
      /* disk dolu / kilitli: veri akisini durdurma */
    }
  };

  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(format(...args));
    };
  }

  // Gorevde konsol yok: bir cokus sessizce kaybolmasin.
  process.on('warning', (w) => write(`[uyari] ${w.name}: ${w.message}`));
  process.on('uncaughtException', (err) => {
    write(`[KRITIK] ${err?.stack ?? err}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    write(`[KRITIK] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
