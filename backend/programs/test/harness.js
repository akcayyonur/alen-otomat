/**
 * Testler icin ortak kurulum: bellek ici kutuphane + sahte FTP sunucusu +
 * bir MachineFiles. Tezgah CNC-08 sahte sunucuya (127.0.0.1) baglanir.
 */
import { Library } from '../library.js';
import { MachineFiles } from '../machine-files.js';
import { MockFtpServer } from './mock-ftp.js';

export const ORNEK = Buffer.from(
  '//100200300  ORNEK TEST PROGRAMI\r\n$1\r\nG0 X0. \r\nM99\r\n\r\n\r\n$2\r\nN11\r\nM99\r\n\r\n\r\n',
  'latin1',
);

/**
 * @param {{ftp?: object, live?: object|null|((id:string)=>object|null), disabled?: boolean,
 *   seed?: (s: MockFtpServer) => void}} [opts]
 */
export async function kur({ ftp = {}, live = { connected: true, state: 'RUNNING', program: '100200300', mainProgram: '100200300' }, disabled = false, seed } = {}) {
  const server = new MockFtpServer(ftp);
  server.put('MDIBlock', 'M99', new Date(2026, 9, 7, 8, 19));
  server.put('O9001', 'M99\r\n', new Date(2026, 1, 19, 6, 28));
  server.mkdir('MUSTERI_B');
  server.mkdir('AA');
  seed?.(server);
  await server.start();

  const library = new Library(':memory:');
  const machines = [{ id: 'CNC-08', name: 'ARIX Torna 8', ip: '127.0.0.1', driverId: 'syntec-remoteapi' }];
  const files = new MachineFiles({
    library,
    getMachine: (id) => machines.find((m) => m.id === id) ?? null,
    liveInfo: typeof live === 'function' ? live : () => live,
    ftpOptionsFor: () => ({ host: '127.0.0.1', port: server.port, commandTimeoutMs: 2_000, connectTimeoutMs: 2_000, dataIdleTimeoutMs: 2_000 }),
    flags: { transferDisabled: disabled },
    pauseMs: 0,
  });

  return {
    server, library, files, machines,
    async kapat() { await server.stop(); library.close(); },
  };
}

/** Kutuphaneye ORNEK'i (musteri, ad) ile ekler. */
export function ekle(library, customer, name, content = ORNEK) {
  return library.addUpload({ customer, name, content, createdBy: 'test' });
}
