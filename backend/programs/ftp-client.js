/**
 * Minimal FTP istemcisi - yalnizca Node'un gomulu `node:net` modulu, bagimlilik yok.
 *
 * Neden FTP: Syntec RemoteAPI'nin dosya yolu musteri klasorlerine yazamiyor,
 * ~100 dosyadan buyuk klasorleri listeleyemiyor ve uretim sirasinda aktarimi
 * baslatmiyor (torna 8, 2026-10-07). Tornanin Windows CE FTP sunucusu (kok =
 * NcFiles, anonim) ise hepsini yapiyor: STOR/RETR/RNFR/RNTO/DELE/MKD/LIST.
 *
 * Bu sinif BILEREK dar tutuldu: yalnizca aktarim akisinin ihtiyaci olan komutlar.
 * Gercek sunucudan ogrenilen davranislar:
 *   - EPSV calisir (229); PASV de var. Aktif mod (PORT) kullanilmaz.
 *   - LIST icin TYPE A, dosya aktarimi icin TYPE I (ikili) - satir sonu cevirisi
 *     OLMAMALI, yoksa icerik degisir ve SHA-256 tutmaz.
 *   - FEAT/SIZE/MDTM yok (500). Boyut dogrulamasi LIST ile yapilir.
 *   - Bos klasorun LIST'i 125 + 226 ile 0 satir doner.
 *   - Alt klasore CWD <ad> ile girilir, CDUP ile cikilir.
 *
 * GUVENLIK: komut argumanlarinda CR/LF/NUL reddedilir (FTP komut enjeksiyonu);
 * dosya islemlerinde yol ayiraclari (/ \) reddedilir - klasor gezinmesi yalnizca
 * cwd() ile ve segment segment yapilir.
 */
import net from 'node:net';

export class FtpError extends Error {
  /** @param {string} message @param {{code?: number|null, step?: string|null}} [extra] */
  constructor(message, { code = null, step = null } = {}) {
    super(message);
    this.name = 'FtpError';
    this.code = code;
    this.step = step;
  }
}

const DEFAULTS = Object.freeze({
  port: 21,
  user: 'anonymous',
  password: 'cnc-telemetri@local',
  connectTimeoutMs: 8_000,
  commandTimeoutMs: 15_000,
  /** Veri baglantisinda bu sure veri gelmezse kopuk sayilir. */
  dataIdleTimeoutMs: 20_000,
  /** RETR icin ust sinir; program dosyalari KB mertebesinde. */
  maxBytes: 2_000_000,
});

function assertSafe(value, what) {
  if (typeof value !== 'string' || value.trim() === '') throw new FtpError(`${what} bos olamaz`);
  if (/[\r\n\0]/.test(value)) throw new FtpError(`${what} gecersiz karakter iceriyor`);
}

/** Dosya adi: yol ayiraci ve gezinme yok. */
function assertFileName(name) {
  assertSafe(name, 'dosya adi');
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    throw new FtpError(`dosya adi gecersiz: "${name}"`);
  }
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new FtpError(`bağlantı zaman aşımı (${host}:${port})`, { step: 'connect' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new FtpError(`bağlantı kurulamadı (${host}:${port}): ${err.code ?? err.message}`, { step: 'connect' }));
    });
  });
}

export class FtpClient {
  /**
   * @param {{host: string, port?: number, user?: string, password?: string,
   *   connectTimeoutMs?: number, commandTimeoutMs?: number, dataIdleTimeoutMs?: number, maxBytes?: number}} options
   */
  constructor(options) {
    this.opt = { ...DEFAULTS, ...options };
    if (!this.opt.host) throw new FtpError('FTP adresi yok');
    this.socket = null;
    this.partial = '';
    /** @type {{code:number, text:string}[]} */
    this.replies = [];
    this.current = null; // cok satirli yanit birikimi
    this.waiter = null;
    this.closedError = null;
    this.type = null;
    /** Kok klasorden kac seviye icerideyiz (CDUP ile geri donmek icin). */
    this.depth = 0;
    /** Oturum boyunca gonderilen komutlar: hata ayiklama ve denetim kaydi. */
    this.log = [];
  }

  /* ---------------------------------------------------------------- kontrol kanali */

  #onData(chunk) {
    const text = this.partial + chunk.toString('latin1');
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (this.current === null) {
        const m = /^(\d{3})([ -])/.exec(line);
        if (!m) continue; // yanit disi gurultu
        if (m[2] === ' ') this.replies.push({ code: Number(m[1]), text: line });
        else this.current = { code: Number(m[1]), lines: [line] };
      } else {
        this.current.lines.push(line);
        if (new RegExp(`^${this.current.code} `).test(line)) {
          this.replies.push({ code: this.current.code, text: this.current.lines.join('\n') });
          this.current = null;
        }
      }
    }
    this.#wake();
  }

  #wake() {
    if (this.waiter && (this.replies.length > 0 || this.closedError)) {
      const { resolve, reject, timer } = this.waiter;
      clearTimeout(timer);
      this.waiter = null;
      if (this.replies.length > 0) resolve(this.replies.shift());
      else reject(this.closedError);
    }
  }

  #nextReply(step, timeoutMs = this.opt.commandTimeoutMs) {
    if (this.replies.length > 0) return Promise.resolve(this.replies.shift());
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.close();
        reject(new FtpError(`tezgah yanıt vermedi (${step})`, { step }));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  async #command(line, step = line.split(' ')[0]) {
    if (!this.socket || this.closedError) throw this.closedError ?? new FtpError('bağlantı kapalı', { step });
    this.log.push(step === 'PASS' ? 'PASS ****' : line);
    this.socket.write(`${line}\r\n`);
    return this.#nextReply(step);
  }

  /** Beklenen kodlardan biri degilse FtpError. */
  #expect(reply, codes, step) {
    if (!codes.includes(reply.code)) {
      throw new FtpError(`${step}: beklenmeyen yanıt: ${reply.text}`, { code: reply.code, step });
    }
    return reply;
  }

  /* ----------------------------------------------------------------------- oturum */

  async connect() {
    this.socket = await connectSocket(this.opt.host, this.opt.port, this.opt.connectTimeoutMs);
    this.socket.on('data', (c) => this.#onData(c));
    const onEnd = (err) => {
      if (this.closedError) return;
      this.closedError = new FtpError(
        err ? `bağlantı koptu: ${err.code ?? err.message}` : 'tezgah bağlantıyı kapattı',
        { step: 'baglanti' },
      );
      this.#wake();
    };
    this.socket.on('error', onEnd);
    this.socket.on('close', () => onEnd(null));

    this.#expect(await this.#nextReply('karşılama'), [220], 'karşılama');
    assertSafe(this.opt.user, 'kullanıcı');
    let r = await this.#command(`USER ${this.opt.user}`, 'USER');
    if (r.code === 331) {
      assertSafe(this.opt.password, 'parola');
      r = await this.#command(`PASS ${this.opt.password}`, 'PASS');
    }
    this.#expect(r, [230, 202], 'giriş');
    return this;
  }

  async #setType(t) {
    if (this.type === t) return;
    this.#expect(await this.#command(`TYPE ${t}`), [200], 'TYPE');
    this.type = t;
  }

  /** Pasif veri baglantisi: once EPSV, olmazsa PASV. Sunucunun verdigi IP yoksayilir. */
  async #openData() {
    let port = null;
    const e = await this.#command('EPSV');
    if (e.code === 229) {
      const m = /\(\|\|\|(\d+)\|\)/.exec(e.text);
      if (m) port = Number(m[1]);
    }
    if (port === null) {
      const p = await this.#command('PASV');
      this.#expect(p, [227], 'PASV');
      const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(p.text);
      if (!m) throw new FtpError(`PASV yanıtı çözülemedi: ${p.text}`, { step: 'PASV' });
      port = Number(m[5]) * 256 + Number(m[6]);
    }
    return connectSocket(this.opt.host, port, this.opt.connectTimeoutMs);
  }

  #readAll(data, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let idle = setTimeout(onIdle, this.opt.dataIdleTimeoutMs);
      function onIdle() {
        data.destroy();
        reject(new FtpError('veri aktarımı zaman aşımına uğradı', { step: 'veri' }));
      }
      data.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          clearTimeout(idle);
          data.destroy();
          reject(new FtpError(`dosya çok büyük (> ${maxBytes} bayt)`, { step: 'veri' }));
          return;
        }
        chunks.push(c);
        clearTimeout(idle);
        idle = setTimeout(onIdle, this.opt.dataIdleTimeoutMs);
      });
      data.once('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
      data.once('close', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
      data.once('error', (err) => {
        clearTimeout(idle);
        reject(new FtpError(`veri bağlantısı hatası: ${err.code ?? err.message}`, { step: 'veri' }));
      });
    });
  }

  /* ----------------------------------------------------------------------- komutlar */

  async pwd() {
    const r = this.#expect(await this.#command('PWD'), [257], 'PWD');
    return /"(.*)"/.exec(r.text)?.[1] ?? '/';
  }

  /** Alt klasore girer. Tek segment; yol ayiraci icermez. */
  async cwd(folder) {
    assertSafe(folder, 'klasör adı');
    if (/[\\/]/.test(folder) || folder === '.' || folder === '..') {
      throw new FtpError(`klasör adı geçersiz: "${folder}"`);
    }
    const r = await this.#command(`CWD ${folder}`, 'CWD');
    this.#expect(r, [250, 200], 'CWD');
    this.depth += 1;
  }

  /** Bir ust klasore cikar; kok'te hicbir sey yapmaz. */
  async cdup() {
    if (this.depth === 0) return;
    this.#expect(await this.#command('CDUP'), [250, 200], 'CDUP');
    this.depth -= 1;
  }

  /** Kok klasore doner. */
  async toRoot() {
    while (this.depth > 0) await this.cdup();
  }

  /** Bulunulan klasorun LIST ciktisi (ham metin). */
  async listRaw() {
    await this.#setType('A');
    const data = await this.#openData();
    let body;
    try {
      const r1 = await this.#command('LIST');
      this.#expect(r1, [125, 150], 'LIST');
      body = await this.#readAll(data, this.opt.maxBytes * 4);
    } catch (err) {
      data.destroy();
      throw err;
    }
    this.#expect(await this.#nextReply('LIST sonu'), [226, 250], 'LIST sonu');
    return body.toString('latin1');
  }

  /** Bulunulan klasordeki dosyayi indirir (ikili). */
  async retr(name, { maxBytes = this.opt.maxBytes } = {}) {
    assertFileName(name);
    await this.#setType('I');
    const data = await this.#openData();
    let body;
    try {
      const r1 = await this.#command(`RETR ${name}`);
      this.#expect(r1, [125, 150], 'RETR');
      body = await this.#readAll(data, maxBytes);
    } catch (err) {
      data.destroy();
      throw err;
    }
    this.#expect(await this.#nextReply('RETR sonu'), [226, 250], 'RETR sonu');
    return body;
  }

  /** Bulunulan klasore dosya yukler (ikili). */
  async stor(name, buffer) {
    assertFileName(name);
    if (!Buffer.isBuffer(buffer)) throw new FtpError('yüklenecek içerik Buffer olmalı');
    await this.#setType('I');
    const data = await this.#openData();
    try {
      const r1 = await this.#command(`STOR ${name}`);
      this.#expect(r1, [125, 150], 'STOR');
      await new Promise((resolve, reject) => {
        data.once('error', (err) => reject(new FtpError(`yükleme hatası: ${err.code ?? err.message}`, { step: 'veri' })));
        data.end(buffer, resolve);
      });
    } catch (err) {
      data.destroy();
      throw err;
    }
    this.#expect(await this.#nextReply('STOR sonu', this.opt.dataIdleTimeoutMs), [226, 250], 'STOR sonu');
  }

  async rename(from, to) {
    assertFileName(from);
    assertFileName(to);
    this.#expect(await this.#command(`RNFR ${from}`), [350], 'RNFR');
    this.#expect(await this.#command(`RNTO ${to}`), [250], 'RNTO');
  }

  async dele(name) {
    assertFileName(name);
    this.#expect(await this.#command(`DELE ${name}`), [250], 'DELE');
  }

  async quit() {
    try {
      if (this.socket && !this.closedError) {
        this.socket.write('QUIT\r\n');
        // En fazla 1 sn bekle; #nextReply zaman asiminda zaten baglantiyi kapatir.
        await this.#nextReply('QUIT', 1_000).catch(() => null);
      }
    } finally {
      this.close();
    }
  }

  close() {
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter = null; }
    if (this.socket) this.socket.destroy();
  }
}

/** Baglanir, isi yapar, her durumda kapatir. */
export async function withFtp(options, work) {
  const client = new FtpClient(options);
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.quit().catch(() => {});
  }
}
