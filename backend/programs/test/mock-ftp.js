/**
 * SAHTE FTP SUNUCUSU - yalnizca testler ve kablosuz gelistirme icin.
 *
 * Syntec tornasinin Windows CE 7.0 FTP sunucusunu, 2026-10-07'de torna 8'de
 * yakalanan gercek protokol diyaloguna gore taklit eder:
 *   220 Service ready for new user.
 *   USER anonymous -> 331 ... ; PASS -> 230 User logged in, proceed.
 *   PWD -> 257 "/". ; EPSV -> 229 ... (|||port|). ; TYPE -> 200 Command okay.
 *   LIST -> 125 Data connection already open; transfer starting. ... 226 Closing data connection.
 *   RNFR -> 350 ... ; RNTO/DELE/CWD/CDUP -> 250 ... ; FEAT/SIZE/MDTM -> 500 (yok)
 *   LIST biciminde DOS tipi satirlar:  MM-DD-YY  HH:MM       <DIR>          ad
 * CE dosya sistemi buyuk/kucuk harfe DUYARSIZ: ayni adli dosya baska harfle de bulunur.
 *
 * Gercekte DENENMEDIGI icin varsayilanlar: RNTO hedefte ayni ad varsa 550 verir
 * (MoveFile davranisi); `renameOverwrites: true` ile ezme simule edilir.
 *
 * Hata enjeksiyonu secenekleri: readOnly, corruptStor, failRnto, dropOnStor,
 * delayMs, listCap.
 */
import net from 'node:net';

const pad = (n) => String(n).padStart(2, '0');

function dosDate(d) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getFullYear() % 100)}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function newDir(name) {
  return { name, dirs: new Map(), files: new Map(), mtime: new Date() };
}

export class MockFtpServer {
  /** @param {{readOnly?: boolean, corruptStor?: boolean, failRnto?: boolean, dropOnStor?: boolean,
   *   delayMs?: number, renameOverwrites?: boolean, listCap?: number}} [opts] */
  constructor(opts = {}) {
    this.opts = { readOnly: false, corruptStor: false, failRnto: false, dropOnStor: false, delayMs: 0, renameOverwrites: false, listCap: 0, ...opts };
    this.root = newDir('');
    /** Tum oturumlarda gelen komutlar (testler dogrulama icin okur). */
    this.commands = [];
    this.sessions = 0;
    this.activeSessions = 0;
    this.server = null;
    this.port = null;
  }

  /* ------------------------------------------------------- sahte dosya sistemi */

  #walk(segments, create = false) {
    let dir = this.root;
    for (const seg of segments) {
      let next = dir.dirs.get(seg.toLowerCase());
      if (!next) {
        if (!create) return null;
        next = newDir(seg);
        dir.dirs.set(seg.toLowerCase(), next);
      }
      dir = next;
    }
    return dir;
  }

  /** Test kurulumu: klasor olustur. */
  mkdir(path) {
    return this.#walk(path.split('/').filter(Boolean), true);
  }

  /** Test kurulumu: dosya koy. `modified` verilmezse simdi. */
  put(path, data, modified = new Date()) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const dir = this.#walk(parts, true);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    dir.files.set(name.toLowerCase(), { name, data: buf, mtime: modified });
  }

  /** Dosya icerigi ya da null. */
  read(path) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const dir = this.#walk(parts);
    return dir?.files.get(name.toLowerCase())?.data ?? null;
  }

  exists(path) {
    const parts = path.split('/').filter(Boolean);
    const dir = this.#walk(parts);
    if (dir) return true;
    return this.read(path) !== null;
  }

  /** Klasordeki dosya adlari (kucuk harfe cevrilmemis). */
  names(path = '') {
    const dir = this.#walk(path.split('/').filter(Boolean));
    if (!dir) return null;
    return [...[...dir.dirs.values()].map((d) => d.name), ...[...dir.files.values()].map((f) => f.name)];
  }

  /* ------------------------------------------------------------------ sunucu */

  /** @param {number} [port] 0 = bos bir port sec */
  start(port = 0) {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => this.#session(socket));
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const s of this.openSockets ?? []) s.destroy();
      this.server?.close(() => resolve());
      if (!this.server) resolve();
    });
  }

  #session(control) {
    this.openSockets ??= new Set();
    this.openSockets.add(control);
    const st = { cwd: [], user: null, auth: false, renameFrom: null, type: 'A', dataServer: null, dataSocket: null, dataWaiter: null };
    const closeData = () => { st.dataServer?.close(); st.dataServer = null; st.dataSocket = null; };
    control.on('close', () => { this.openSockets.delete(control); this.activeSessions -= 1; closeData(); });
    this.sessions += 1;
    this.activeSessions += 1;
    const reply = (line) => control.write(`${line}\r\n`);
    const cwdDir = () => this.#walk(st.cwd);

    reply('220 Service ready for new user.');

    const openPassive = () => new Promise((resolve) => {
      st.dataServer?.close();
      st.dataSocket = null;
      st.dataServer = net.createServer((sock) => {
        this.openSockets.add(sock);
        sock.on('close', () => this.openSockets.delete(sock));
        st.dataSocket = sock;
        if (st.dataWaiter) { st.dataWaiter(sock); st.dataWaiter = null; }
      });
      st.dataServer.listen(0, '127.0.0.1', () => resolve(st.dataServer.address().port));
    });
    const takeData = () => new Promise((resolve, reject) => {
      if (st.dataSocket) return resolve(st.dataSocket);
      const timer = setTimeout(() => reject(new Error('veri baglantisi gelmedi')), 5_000);
      st.dataWaiter = (sock) => { clearTimeout(timer); resolve(sock); };
    });

    const handlers = {
      USER: (arg) => { st.user = arg; reply('331 Anonymous access allowed, send identity (e-mail name) as password.'); },
      PASS: () => { st.auth = true; reply('230 User logged in, proceed.'); },
      SYST: () => reply('215 Windows_CE version 7.0.'),
      NOOP: () => reply('200 Command okay.'),
      PWD: () => reply(`257 "/${st.cwd.join('/')}".`),
      TYPE: (arg) => { st.type = arg.toUpperCase().startsWith('I') ? 'I' : 'A'; reply('200 Command okay.'); },
      CWD: (arg) => {
        if (this.opts.failCwd?.some((f) => f.toLowerCase() === arg.toLowerCase())) {
          return reply('550 Requested action not taken. Access denied.');
        }
        const d = this.#walk([...st.cwd, arg]);
        if (!d) return reply('550 Requested action not taken. File/directory not found.');
        st.cwd.push(d.name);
        reply('250 Requested file action okay, completed.');
      },
      CDUP: () => { st.cwd.pop(); reply('250 Requested file action okay, completed.'); },
      EPSV: async () => { const port = await openPassive(); reply(`229 Entering extended passive mode (|||${port}|).`); },
      PASV: async () => {
        const port = await openPassive();
        reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255}).`);
      },
      LIST: async () => {
        const dir = cwdDir();
        let sock;
        try { sock = await takeData(); } catch { return reply('425 Cannot open data connection.'); }
        reply('125 Data connection already open; transfer starting.');
        const rows = [];
        for (const d of dir.dirs.values()) rows.push(`${dosDate(d.mtime)}       <DIR>          ${d.name}`);
        for (const f of dir.files.values()) rows.push(`${dosDate(f.mtime)}${String(f.data.length).padStart(21)} ${f.name}`);
        const shown = this.opts.listCap > 0 ? rows.slice(0, this.opts.listCap) : rows;
        sock.end(shown.map((r) => `${r}\r\n`).join(''));
        sock.on('close', () => { closeData(); reply('226 Closing data connection. '); });
      },
      RETR: async (arg) => {
        const f = cwdDir().files.get(arg.toLowerCase());
        if (!f) { st.dataServer?.close(); return reply('550 Requested action not taken. File not found.'); }
        let sock;
        try { sock = await takeData(); } catch { return reply('425 Cannot open data connection.'); }
        reply('125 Data connection already open; transfer starting.');
        sock.end(f.data);
        sock.on('close', () => { closeData(); reply('226 Closing data connection. '); });
      },
      STOR: async (arg) => {
        if (this.opts.readOnly) { st.dataServer?.close(); return reply('550 Access is denied.'); }
        let sock;
        try { sock = await takeData(); } catch { return reply('425 Cannot open data connection.'); }
        reply('125 Data connection already open; transfer starting.');
        const chunks = [];
        sock.on('data', (c) => chunks.push(c));
        sock.on('end', () => {
          if (this.opts.dropOnStor) { control.destroy(); return; }
          let data = Buffer.concat(chunks);
          if (this.opts.corruptStor && data.length > 0) { data = Buffer.from(data); data[0] ^= 0xff; }
          cwdDir().files.set(arg.toLowerCase(), { name: arg, data, mtime: new Date() });
          closeData();
          reply('226 Closing data connection. ');
        });
      },
      RNFR: (arg) => {
        // Test kancasi: RNFR'den hemen once baska bir istemci/operator dosya olusturmus gibi.
        this.opts.beforeRnfr?.(this, st.cwd.join('/'));
        const f = cwdDir().files.get(arg.toLowerCase());
        if (!f) return reply('550 Requested action not taken. File not found.');
        st.renameFrom = f.name;
        reply('350 Requested file action pending further information.');
      },
      RNTO: (arg) => {
        const dir = cwdDir();
        if (this.opts.readOnly || this.opts.failRnto || !st.renameFrom) { st.renameFrom = null; return reply('550 Requested action not taken.'); }
        const exists = dir.files.has(arg.toLowerCase()) && arg.toLowerCase() !== st.renameFrom.toLowerCase();
        if (exists && !this.opts.renameOverwrites) { st.renameFrom = null; return reply('550 Requested action not taken. File exists.'); }
        const f = dir.files.get(st.renameFrom.toLowerCase());
        dir.files.delete(st.renameFrom.toLowerCase());
        dir.files.set(arg.toLowerCase(), { ...f, name: arg });
        st.renameFrom = null;
        reply('250 Requested file action okay, completed.');
      },
      DELE: (arg) => {
        const dir = cwdDir();
        if (this.opts.readOnly) return reply('550 Access is denied.');
        if (!dir.files.delete(arg.toLowerCase())) return reply('550 Requested action not taken. File not found.');
        reply('250 Requested file action okay, completed.');
      },
      MKD: (arg) => {
        if (this.opts.readOnly) return reply('550 Access is denied.');
        this.#walk([...st.cwd, arg], true);
        reply(`257 "${arg}" directory created.`);
      },
      HELP: () => reply('214-The following commands are implemented.\r\nUSER  PASS  QUIT  PORT  PASV\r\nTYPE  RETR  STOR  RNFR  RNTO\r\nDELE  CWD  XCWD  LIST  NLST\r\nSYST  HELP  NOOP  MKD  XMKD\r\nRMD  XRMD  PWD  XPWD  CDUP\r\nXCUP  MODE  STRU\r\n214 HELP command successful.'),
      QUIT: () => { reply('221 Service closing control connection.'); control.end(); },
    };
    handlers.XPWD = handlers.PWD; handlers.XCWD = handlers.CWD; handlers.XCUP = handlers.CDUP; handlers.XMKD = handlers.MKD;

    let buf = '';
    control.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : line.slice(sp + 1);
        this.commands.push(cmd === 'PASS' ? 'PASS ****' : line);
        const handler = handlers[cmd];
        const run = () => {
          if (!handler) return reply('500 Syntax error, command unrecognized.');
          if (!st.auth && !['USER', 'PASS', 'QUIT', 'SYST'].includes(cmd)) return reply('530 Not logged in.');
          return handler(arg);
        };
        if (this.opts.delayMs > 0) setTimeout(run, this.opts.delayMs); else run();
      }
    });
    control.on('error', () => {});
  }
}
