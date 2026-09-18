/**
 * Asgari Modbus TCP istemcisi - bagimlilik yok.
 * Yalnizca okuma: FC03 (holding register) ve FC04 (input register).
 */
import net from 'node:net';

const FC_HOLDING = 0x03;
const FC_INPUT = 0x04;
/** Modbus spesifikasyonu tek istekte en fazla 125 register'a izin verir. */
export const MAX_PER_READ = 125;

export class ModbusClient {
  constructor({ host, port = 502, unitId = 1, timeoutMs = 3000 }) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.transactionId = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      const onError = (err) => { socket.destroy(); reject(err); };
      socket.once('error', onError);
      socket.setTimeout(this.timeoutMs, () => onError(new Error('baglanti zaman asimi')));
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.off('error', onError);
        socket.on('error', () => { /* istek bazinda ele aliniyor */ });
        this.socket = socket;
        resolve();
      });
    });
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }

  #nextTransactionId() {
    this.transactionId = (this.transactionId + 1) & 0xffff;
    return this.transactionId;
  }

  /** MBAP basligi + PDU. Cevap ayni transaction id ile eslesmeli. */
  #request(functionCode, address, quantity) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('baglanti yok'));

      const tid = this.#nextTransactionId();
      const frame = Buffer.alloc(12);
      frame.writeUInt16BE(tid, 0);        // transaction id
      frame.writeUInt16BE(0, 2);          // protocol id (her zaman 0)
      frame.writeUInt16BE(6, 4);          // sonraki bayt sayisi
      frame.writeUInt8(this.unitId, 6);
      frame.writeUInt8(functionCode, 7);
      frame.writeUInt16BE(address, 8);
      frame.writeUInt16BE(quantity, 10);

      let buffer = Buffer.alloc(0);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket?.off('data', onData);
        this.socket?.off('error', onError);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('istek zaman asimi')); }, this.timeoutMs);
      const onError = (err) => { cleanup(); reject(err); };

      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        // Once MBAP basligi (7 bayt) tamamlanmali, sonra bildirdigi uzunluk kadar veri.
        if (buffer.length < 7) return;
        const bodyLength = buffer.readUInt16BE(4);
        const total = 6 + bodyLength;
        if (buffer.length < total) return;

        cleanup();
        const response = buffer.subarray(0, total);
        if (response.readUInt16BE(0) !== tid) {
          return reject(new Error('transaction id eslesmedi'));
        }

        const fc = response.readUInt8(7);
        if (fc & 0x80) {
          const code = response.readUInt8(8);
          return reject(new Error(`modbus istisnasi ${code}: ${EXCEPTIONS[code] ?? 'bilinmiyor'}`));
        }

        const byteCount = response.readUInt8(8);
        const values = [];
        for (let i = 0; i < byteCount; i += 2) values.push(response.readUInt16BE(9 + i));
        resolve(values);
      };

      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.write(frame);
    });
  }

  readHolding(address, quantity) {
    return this.#request(FC_HOLDING, address, quantity);
  }

  readInput(address, quantity) {
    return this.#request(FC_INPUT, address, quantity);
  }

  /** Aralik MAX_PER_READ'i asiyorsa parcalara bolerek okur. */
  async readRange(address, quantity, { input = false } = {}) {
    const out = [];
    for (let offset = 0; offset < quantity; offset += MAX_PER_READ) {
      const chunk = Math.min(MAX_PER_READ, quantity - offset);
      const read = input ? this.readInput.bind(this) : this.readHolding.bind(this);
      out.push(...await read(address + offset, chunk));
    }
    return out;
  }
}

const EXCEPTIONS = {
  1: 'gecersiz fonksiyon',
  2: 'gecersiz adres',
  3: 'gecersiz veri',
  4: 'cihaz hatasi',
  6: 'cihaz mesgul',
};

/**
 * Syntec'in 32-bit R register'i Modbus'ta iki 16-bit register'a bolunur:
 * R[n] High = n*2, Low = n*2+1.
 */
export function combine32(high, low, { signed = true } = {}) {
  const value = (high << 16 >>> 0) + low;
  if (!signed) return value >>> 0;
  return value > 0x7fffffff ? value - 0x100000000 : value;
}
