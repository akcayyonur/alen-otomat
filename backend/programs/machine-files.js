/**
 * Tezgahtaki program dosyalari: tarama, iceri alma, on kontrol ve GONDERME.
 *
 * Tasima yolu FTP'dir (bkz. ftp-client.js ve CLAUDE.md "NC program aktarimi").
 * FTP, kontrolcunun kendi korumalarini (calisan programi koruma) ATLAR; o yuzden
 * butun guvenlik denetimi BURADADIR. Degismez kurallar:
 *
 *   1. Dosya gonderilir, ASLA calistirilir/secilmez. (Burada program secme ya da
 *      baslatma diye bir cagri yoktur; FTP'nin zaten boyle bir komutu da yok.)
 *   2. Hedefte ayni ad varsa UZERINE YAZILMAZ (buyuk/kucuk harf duyarsiz: CE oyle).
 *   3. Tezgahta calisan/secili programin adiyla gonderilmez. Canli veri yoksa
 *      (hangi program calisiyor bilinmiyor) kullanici acikca onaylamadan gonderilmez.
 *   4. Once GECICI adla yuklenir (ZZUP + rakam), yerinde SHA-256 ile dogrulanir,
 *      sonra nihai ada cevrilir (RNFR/RNTO) ve yine dogrulanir. Yarim dosya hicbir
 *      zaman nihai adla gorunmez.
 *   5. Dogrulama tutmazsa kendi olusturdugumuz dosya silinir; baskasina ait dosyaya
 *      ASLA dokunulmaz (silme yalnizca ZZUP... adli kendi gecici dosyamiz ve, SHA
 *      tutmayan kendi nihai dosyamiz icin).
 *   6. Onay metni tezgahin kimligidir (ornegin CNC-08): yanlis tezgaha kazara gonderme.
 *   7. Her gonderme (reddedilenler dahil) `transfers` tablosuna yazilir.
 *   8. Bir tezgaha ayni anda tek islem (tarama/gonderme/iceri alma): ikincisi 409.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { getDriver, resolveModel } from '../../shared/drivers.js';
import { withFtp, FtpError } from './ftp-client.js';
import { parseList } from './list-parse.js';
import {
  MAX_PROGRAM_BYTES, TEMP_PREFIX, ValidationError, sha256, isSystemEntry,
  validateCustomer, validateProgramName,
} from './library.js';

export class BusyError extends Error {
  constructor(message) { super(message); this.name = 'BusyError'; this.status = 409; }
}
export class UnsupportedError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedError'; this.status = 422; }
}
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = 'NotFoundError'; this.status = 404; }
}
export class DisabledError extends Error {
  constructor(message) { super(message); this.name = 'DisabledError'; this.status = 403; }
}

/** Suruculerden FTP ayarini okur (config/drivers.json -> fileTransfer). */
export function driverFtpOptions(machine) {
  const driver = getDriver(machine.driverId);
  const ft = driver?.fileTransfer;
  if (!ft || ft.protocol !== 'ftp') {
    throw new UnsupportedError(
      `Bu tezgahın sürücüsü (${driver?.label ?? machine.driverId}) dosya aktarımını desteklemiyor.`,
    );
  }
  if (!machine.ip) throw new UnsupportedError('Bu tezgahın IP adresi tanımlı değil (Ayarlar ekranı).');
  return {
    host: machine.ip,
    port: machine.ftpPort ?? ft.port ?? 21,
    user: ft.user ?? 'anonymous',
    password: ft.password ?? 'cnc-telemetri@local',
  };
}

/**
 * Tezgahin kontrolcu modeli icin GONDERME acik mi (config/drivers.json -> models[].fileTransfer).
 * Dogrulanmamis bir modelde (ornegin gercek tezgahta hic denenmemis 22TB) gonderme kapali
 * tutulur; okuma/tarama etkilenmez. Modeli olmayan surucuyle ve modelde `sendEnabled`
 * yazilmamissa acik: yalniz acikca `false` yazilan kapanir.
 */
export function sendPolicy(machine) {
  const driver = getDriver(machine.driverId);
  const model = resolveModel(driver, machine.controllerModel);
  const ft = model?.fileTransfer;
  if (ft && ft.sendEnabled === false) {
    return {
      allowed: false,
      model: model.label ?? model.id,
      reason: ft.reason ?? `${model.label ?? model.id} için program gönderme henüz doğrulanmadı.`,
    };
  }
  return { allowed: true, model: model?.label ?? null, reason: null };
}

/** "MUSTERI_B\\100200300" ya da "100200300" -> "100200300" (kucuk harf). */
const baseName = (p) => String(p ?? '').split(/[\\/]/).pop().trim().toLowerCase();

const MAX_SCAN_MS = 120_000;
const MAX_HASH_DOWNLOADS = 300;

export class MachineFiles {
  /**
   * @param {{library: import('./library.js').Library,
   *   getMachine: (id: string) => object|null,
   *   liveInfo?: (id: string) => ({connected:boolean, state?:string, program?:string|null, mainProgram?:string|null}|null),
   *   ftpOptionsFor?: (machine: object) => object,
   *   flags?: {transferDisabled?: boolean},
   *   pauseMs?: number}} deps
   */
  constructor({ library, getMachine, liveInfo = () => null, ftpOptionsFor = driverFtpOptions, flags = {}, pauseMs = 150 }) {
    this.library = library;
    this.getMachine = getMachine;
    this.liveInfo = liveInfo;
    this.ftpOptionsFor = ftpOptionsFor;
    this.flags = flags;
    this.pauseMs = pauseMs;
    /** @type {Map<string, string>} tezgah -> calisan islemin adi */
    this.locks = new Map();
  }

  #machine(id) {
    const m = this.getMachine(id);
    if (!m) throw new NotFoundError(`Tezgah bulunamadı: ${id}`);
    return m;
  }

  async #lock(machineId, label, fn) {
    if (this.locks.has(machineId)) {
      throw new BusyError(`${machineId} için başka bir işlem sürüyor (${this.locks.get(machineId)}). Bitmesini bekleyin.`);
    }
    this.locks.set(machineId, label);
    try {
      return await fn();
    } finally {
      this.locks.delete(machineId);
    }
  }

  /** Ozellik acik mi: kapaliysa gonderme reddedilir (okuma islemleri etkilenmez). */
  get transferEnabled() {
    return !this.flags.transferDisabled;
  }

  /* ----------------------------------------------------------------------- tarama */

  /**
   * Tezgahin tum musteri klasorlerini listeler ve envanteri yeniler. Kutuphanede
   * karsiligi olan dosyalarin (boyutu tutanlarin) SHA'si icin indirilir.
   */
  async scan(machineId) {
    const machine = this.#machine(machineId);
    const ftp = this.ftpOptionsFor(machine);
    return this.#lock(machineId, 'tarama', async () => {
      const startedAt = Date.now();
      const entries = [];
      const warnings = [];
      const folderNames = [];
      let folders = 0;
      let hashed = 0;
      try {
        await withFtp(ftp, async (c) => {
          const root = parseList(await c.listRaw());
          if (root.unparsed.length) warnings.push(`kök: ${root.unparsed.length} satır çözümlenemedi`);
          for (const e of root.entries) {
            if (!e.isDir) entries.push({ customer: '', name: e.name, size: e.size, modified: e.modified });
          }
          folderNames.push(...root.entries.filter((e) => e.isDir).map((e) => e.name));
          for (const dir of root.entries.filter((e) => e.isDir)) {
            if (Date.now() - startedAt > MAX_SCAN_MS) throw new Error('tarama süre sınırını aştı');
            await sleep(this.pauseMs);
            try {
              await c.cwd(dir.name);
              const listing = parseList(await c.listRaw());
              folders += 1;
              if (listing.unparsed.length) warnings.push(`${dir.name}: ${listing.unparsed.length} satır çözümlenemedi`);
              for (const e of listing.entries) {
                if (e.isDir) warnings.push(`${dir.name}\\${e.name}: alt klasör taranmadı`);
                else entries.push({ customer: dir.name, name: e.name, size: e.size, modified: e.modified });
              }
            } catch (err) {
              if (c.closedError) throw err; // baglanti koptu: tum tarama basarisiz
              warnings.push(`${dir.name}: listelenemedi (${err.message})`);
            } finally {
              if (!c.closedError) await c.toRoot().catch(() => {});
            }
          }

          // Kutuphanede karsiligi olan dosyalarin SHA'si
          const candidates = this.library.hashCandidates(entries).slice(0, MAX_HASH_DOWNLOADS);
          const byFolder = new Map();
          for (const e of candidates) {
            if (!byFolder.has(e.customer)) byFolder.set(e.customer, []);
            byFolder.get(e.customer).push(e);
          }
          for (const [folder, list] of byFolder) {
            if (Date.now() - startedAt > MAX_SCAN_MS) { warnings.push('SHA hesabı süre sınırı nedeniyle yarım kaldı'); break; }
            try {
              if (folder !== '') await c.cwd(folder);
              for (const e of list) {
                try {
                  const data = await c.retr(e.name, { maxBytes: MAX_PROGRAM_BYTES });
                  e.sha256 = sha256(data);
                  hashed += 1;
                } catch (err) {
                  if (c.closedError) throw err;
                  warnings.push(`${folder ? `${folder}\\` : ''}${e.name}: okunamadı (${err.message})`);
                }
              }
            } finally {
              if (!c.closedError) await c.toRoot().catch(() => {});
            }
          }
        });
        const finishedAt = Date.now();
        this.library.db.replaceInventory(machineId, entries, { startedAt, finishedAt, folders: folderNames });
        return { machineId, folders, entries: entries.length, hashed, warnings, durationMs: finishedAt - startedAt };
      } catch (err) {
        this.library.db.recordScanFailure(machineId, { startedAt, finishedAt: Date.now(), error: String(err.message).slice(0, 300) });
        throw err;
      }
    });
  }

  /* ------------------------------------------------------------------- iceri alma */

  /** Tezgahtaki bir programi kutuphaneye alir (kaynak: 'tezgah-tarama'). */
  async importFromMachine({ machineId, customer, name, by = null }) {
    const machine = this.#machine(machineId);
    const cleanCustomer = validateCustomer(customer);
    const ftp = this.ftpOptionsFor(machine);
    return this.#lock(machineId, 'içeri alma', async () => {
      const found = await withFtp(ftp, async (c) => {
        let folder = cleanCustomer;
        if (cleanCustomer !== '') {
          const root = parseList(await c.listRaw());
          const dir = root.entries.find((e) => e.isDir && e.name.toLowerCase() === cleanCustomer.toLowerCase());
          if (!dir) throw new NotFoundError(`Tezgahta "${cleanCustomer}" klasörü yok.`);
          folder = dir.name;
          await c.cwd(folder);
        }
        const listing = parseList(await c.listRaw());
        const file = listing.entries.find((e) => !e.isDir && e.name.toLowerCase() === String(name).toLowerCase());
        if (!file) throw new NotFoundError(`Tezgahta "${name}" dosyası yok.`);
        if (file.size != null && file.size > MAX_PROGRAM_BYTES) {
          throw new ValidationError(`Dosya çok büyük (${file.size} bayt); en fazla ${MAX_PROGRAM_BYTES}.`, 413);
        }
        const content = await c.retr(file.name, { maxBytes: MAX_PROGRAM_BYTES });
        return { folder, fileName: file.name, content };
      });
      const result = this.library.addFromMachine({
        machineId, customer: found.folder, name: found.fileName, content: found.content, createdBy: by,
      });
      this.library.db.setInventorySha(machineId, found.folder, found.fileName, result.version.sha256);
      return result;
    });
  }

  /* ----------------------------------------------------------- on kontrol + gonderme */

  #resolveVersion(programId, versionNo) {
    const program = this.library.db.getProgram(Number(programId));
    if (!program) throw new NotFoundError('Program kütüphanede bulunamadı.');
    const no = versionNo == null || versionNo === '' ? this.library.db.latestVersion(program.id).versionNo : Number(versionNo);
    const version = this.library.db.getVersion(program.id, no);
    if (!version) throw new NotFoundError(`Sürüm bulunamadı: v${no}`);
    return { program, version };
  }

  /**
   * Bagli bir FTP oturumunda hedefi inceler. Sonunda istemci HEDEF KLASORDEdir
   * (musteri '' ise kokte). Tum kurallar burada; hem on kontrol hem gonderme kullanir.
   */
  async #inspect(c, { machine, customer, name, version }) {
    const checks = [];
    const add = (id, level, title, detail = '', ack = null) => checks.push({ id, level, title, detail, ...(ack ? { ack } : {}) });
    const out = { checks, folder: null, folderNames: [] };

    // --- calisan / secili program (canli veri) ---
    const live = this.liveInfo(machine.id);
    if (!live || !live.connected) {
      add('calisan-program', 'warn', 'Tezgahtan canlı veri gelmiyor',
        'Çalışan/seçili programı kontrol edemiyorum (ajan çalışmıyor ya da tezgah veri vermiyor). ' +
        'Çalışan programın üzerine yazılmayacak (hedefte aynı ad varsa zaten reddedilir) ama bunu onaylamanız gerekir.',
        'unknown-state');
    } else {
      const running = [live.program, live.mainProgram].filter(Boolean).map(baseName);
      if (running.includes(name.toLowerCase())) {
        add('calisan-program', 'block', 'Bu ad şu an çalışan/seçili program',
          `Tezgahta çalışan program: ${live.program ?? '—'} · ana program: ${live.mainProgram ?? '—'}. Çalışan programın adıyla gönderilmez.`);
      } else {
        add('calisan-program', 'ok', 'Çalışan programla çakışma yok',
          `Çalışan program: ${live.program ?? '—'} · ana program: ${live.mainProgram ?? '—'}${live.state === 'RUNNING' ? ' · tezgah üretimde' : ''}`);
      }
    }

    // --- hedef klasor ---
    const root = parseList(await c.listRaw());
    out.folderNames = root.entries.filter((e) => e.isDir).map((e) => e.name);
    let listing;
    if (customer === '') {
      add('klasor', 'warn', 'Hedef: kök dizin (ortak alan, müşterisiz)',
        'Kök dizindeki programlar tüm müşteriler için ortaktır (ör. ortak alt programlar). Emin misiniz?', 'root-target');
      listing = root;
      out.folder = '';
    } else {
      const dir = root.entries.find((e) => e.isDir && e.name.toLowerCase() === customer.toLowerCase());
      if (!dir) {
        add('klasor', 'block', `Tezgahta "${customer}" klasörü yok`,
          'Yeni müşteri klasörü bu sürümde otomatik açılmaz: klasörü tezgah panelinden açın, sonra tekrar deneyin.');
        return out;
      }
      out.folder = dir.name;
      add('klasor', 'ok', `Hedef klasör var: ${dir.name}`);
      await c.cwd(dir.name);
      listing = parseList(await c.listRaw());
    }

    // --- ad cakismasi: UZERINE YAZMA YOK ---
    const hit = listing.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (hit) {
      if (hit.isDir) {
        add('cakisma', 'block', `Hedefte "${hit.name}" adlı bir klasör var`);
      } else {
        let same = false;
        if (hit.size === version.meta.size) {
          try { same = sha256(await c.retr(hit.name, { maxBytes: MAX_PROGRAM_BYTES })) === version.meta.sha256; } catch { /* okunamadi: farkli say */ }
        }
        add('cakisma', 'block',
          same ? 'Bu program tezgahta zaten var ve içeriği aynı' : `Hedefte aynı adlı program var (${hit.size} bayt) — üzerine yazılmaz`,
          same
            ? `${hit.name} zaten güncel; gönderilecek bir şey yok.`
            : 'Farklı içerikli bir dosya. Üzerine yazma bu sürümde kapalı: yeni sürümü farklı adla gönderin ya da mevcut dosyayı önce tezgah panelinden kaldırın.');
      }
    } else {
      add('cakisma', 'ok', 'Hedefte aynı adlı dosya yok');
    }

    // --- onceki yarim aktarimdan kalan gecici dosyalar (bilgi) ---
    const leftovers = listing.entries.filter((e) => e.name.toUpperCase().startsWith(TEMP_PREFIX));
    if (leftovers.length > 0) {
      add('gecici-kalinti', 'info', `Klasörde geçici dosya var: ${leftovers.map((e) => e.name).join(', ')}`,
        'Önceki yarım kalmış bir aktarımdan kalmış olabilir; otomatik silinmez.');
    }
    out.listing = listing;
    return out;
  }

  #summarize(checks, acks) {
    const blocks = checks.filter((k) => k.level === 'block');
    const needsAck = checks.filter((k) => k.level === 'warn' && k.ack).map((k) => k.ack);
    const missingAck = needsAck.filter((a) => !acks.includes(a));
    return { canSend: blocks.length === 0 && missingAck.length === 0, needsAck, blocked: blocks.length > 0 };
  }

  /** On kontrol: hicbir sey yazmaz. */
  async precheck({ machineId, programId, versionNo, customer, acks = [] }) {
    const machine = this.#machine(machineId);
    const { program, version } = this.#resolveVersion(programId, versionNo);
    const target = validateCustomer(customer ?? program.customer);
    const checks = [];
    if (!this.transferEnabled) {
      checks.push({ id: 'ozellik', level: 'block', title: 'Dosya gönderme kapalı', detail: 'Sunucu TRANSFER_DISABLED=1 ile başlatılmış.' });
      return { machineId, programId: program.id, versionNo: version.meta.versionNo, customer: target, name: program.name, size: version.meta.size, sha256: version.meta.sha256, checks, canSend: false, needsAck: [], folderNames: [] };
    }
    const policy = sendPolicy(machine);
    if (!policy.allowed) {
      checks.push({ id: 'model', level: 'block', title: `${policy.model}: program gönderme kapalı`, detail: policy.reason });
      return { machineId, programId: program.id, versionNo: version.meta.versionNo, customer: target, name: program.name, size: version.meta.size, sha256: version.meta.sha256, checks, canSend: false, needsAck: [], folderNames: [] };
    }
    const ftp = this.ftpOptionsFor(machine);
    const result = await this.#lock(machineId, 'ön kontrol', () =>
      withFtp(ftp, (c) => this.#inspect(c, { machine, customer: target, name: program.name, version })));
    checks.push(...result.checks);
    return {
      machineId, programId: program.id, versionNo: version.meta.versionNo, customer: target,
      folder: result.folder, name: program.name, size: version.meta.size, sha256: version.meta.sha256,
      checks, ...this.#summarize(checks, acks), folderNames: result.folderNames,
    };
  }

  /** GONDERME. Bkz. dosya basindaki kurallar. */
  async send({ machineId, programId, versionNo, customer, confirm, by = null, clientIp = null, acks = [] }) {
    if (!this.transferEnabled) throw new DisabledError('Dosya gönderme kapalı (TRANSFER_DISABLED=1).');
    const machine = this.#machine(machineId);
    const policy = sendPolicy(machine);
    if (!policy.allowed) throw new UnsupportedError(`${policy.model}: ${policy.reason}`);
    if (confirm !== machine.id) {
      throw new ValidationError(`Onay metni tezgah kimliğiyle aynı olmalı: ${machine.id}`);
    }
    const { program, version } = this.#resolveVersion(programId, versionNo);
    const target = validateCustomer(customer ?? program.customer);
    validateProgramName(program.name);
    const ftp = this.ftpOptionsFor(machine);
    const content = version.content;

    return this.#lock(machineId, 'gönderme', async () => {
      const db = this.library.db;
      const transferId = db.startTransfer({
        machineId, programId: program.id, versionId: version.meta.id, customer: target, name: program.name,
        size: content.length, shaSent: version.meta.sha256, requestedBy: by, clientIp, acks,
      });
      const steps = [];
      const timed = async (step, fn) => {
        const t0 = Date.now();
        try {
          const detail = await fn();
          steps.push({ step, ok: true, ms: Date.now() - t0, detail: detail ?? null });
          return detail;
        } catch (err) {
          steps.push({ step, ok: false, ms: Date.now() - t0, detail: err.message });
          throw err;
        }
      };

      const tempName = `${TEMP_PREFIX}${Math.floor(100000 + Math.random() * 900000)}`;
      let folder = target;
      let tempCreated = false;
      let renamed = false;
      let finalDeleted = false;
      let status = 'basarisiz';
      let error = null;
      let shaVerified = null;

      try {
        await withFtp(ftp, async (c) => {
          let inspected;
          await timed('on-kontrol', async () => {
            const r = await this.#inspect(c, { machine, customer: target, name: program.name, version });
            const sum = this.#summarize(r.checks, acks);
            if (!sum.canSend) {
              const why = r.checks.filter((k) => k.level === 'block' || (k.level === 'warn' && k.ack && !acks.includes(k.ack)));
              const e = new Error(why.map((k) => k.title).join(' · '));
              e.rejected = true;
              throw e;
            }
            inspected = r;
            // Adim ayrintisi kisa metin olmali (denetim kaydina yazilir): listeyi degil.
            return `${r.checks.length} kontrol geçti${acks.length ? ` (onaylananlar: ${acks.join(', ')})` : ''}`;
          });
          folder = inspected.folder;
          const listing = inspected.listing;
          if (listing.entries.some((e) => e.name.toLowerCase() === tempName.toLowerCase())) {
            throw new Error(`geçici ad hedefte zaten var: ${tempName}`);
          }

          await timed('yukle', async () => {
            tempCreated = true;
            await c.stor(tempName, content);
            return `${tempName} (${content.length} bayt, ikili)`;
          });
          await timed('boyut-dogrula', async () => {
            const l = parseList(await c.listRaw()).entries.find((e) => e.name.toLowerCase() === tempName.toLowerCase());
            if (!l) throw new Error('yüklenen geçici dosya listede görünmüyor');
            if (l.size !== content.length) throw new Error(`boyut tutmuyor: tezgahta ${l.size}, gönderilen ${content.length}`);
            return `${l.size} bayt`;
          });
          await timed('geri-oku-sha', async () => {
            const back = await c.retr(tempName, { maxBytes: MAX_PROGRAM_BYTES });
            const sha = sha256(back);
            if (sha !== version.meta.sha256) throw new Error('SHA-256 tutmuyor (iletimde içerik bozuldu)');
            return sha;
          });
          await timed('nihai-ada-cevir', async () => {
            // Yarismaya karsi son kez: bu arada ayni ad olustuysa ezme.
            const now = parseList(await c.listRaw()).entries;
            if (now.some((e) => e.name.toLowerCase() === program.name.toLowerCase())) {
              throw new Error('bu arada hedefte aynı adlı bir dosya oluştu; ezilmedi');
            }
            await c.rename(tempName, program.name);
            renamed = true;
            tempCreated = false;
            return `${tempName} → ${program.name}`;
          });
          shaVerified = await timed('son-dogrulama', async () => {
            const l = parseList(await c.listRaw()).entries;
            const fin = l.find((e) => e.name.toLowerCase() === program.name.toLowerCase());
            if (!fin) throw new Error('nihai dosya listede görünmüyor');
            if (l.some((e) => e.name.toLowerCase() === tempName.toLowerCase())) throw new Error('geçici dosya hâlâ duruyor');
            const back = await c.retr(fin.name, { maxBytes: MAX_PROGRAM_BYTES });
            const sha = sha256(back);
            if (sha !== version.meta.sha256) {
              // Kendi olusturdugumuz, bozuk dosya: sil.
              await c.dele(fin.name);
              finalDeleted = true;
              throw new Error('nihai dosyanın SHA-256 değeri tutmuyor; dosya silindi');
            }
            return sha;
          });
        });
        status = 'basarili';
      } catch (err) {
        error = err.message;
        if (err.rejected) status = 'reddedildi';
        else if (renamed && !finalDeleted) status = 'dogrulanamadi';
        else status = 'basarisiz';
      }

      // Yarim kalan gecici dosyayi temizle (yalniz kendi gecici adimiz).
      if (tempCreated && status !== 'reddedildi') {
        const t0 = Date.now();
        try {
          const ok = await withFtp(ftp, async (c) => {
            if (folder) await c.cwd(folder);
            const l = parseList(await c.listRaw()).entries.find((e) => e.name.toLowerCase() === tempName.toLowerCase());
            if (!l) return 'geçici dosya yok';
            await c.dele(tempName);
            return 'geçici dosya silindi';
          });
          steps.push({ step: 'temizlik', ok: true, ms: Date.now() - t0, detail: ok });
        } catch (cleanupErr) {
          steps.push({ step: 'temizlik', ok: false, ms: Date.now() - t0, detail: `${cleanupErr.message} — ${tempName} elle kontrol edilmeli` });
          error = `${error} (geçici dosya ${tempName} silinemedi, elle kontrol edin)`;
        }
      }

      if (status === 'basarili') {
        db.upsertInventory(machineId, { customer: folder ?? target, name: program.name, size: content.length, sha256: version.meta.sha256 });
      }
      db.finishTransfer(transferId, { status, shaVerified, error, steps });
      return db.getTransfer(transferId);
    });
  }
}

export { FtpError };
