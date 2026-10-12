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
 *   9. Yeni musteri klasoru YALNIZCA `createFolder` ile acilir: gonderme asla klasor acmaz (hedef
 *      klasor yoksa engel). Klasor acma da gonderme ile ayni kapilardan gecer (ozellik acik mi,
 *      kontrolcu modelinde yazma acik mi, tezgah kimligiyle onay, denetim kaydi). Klasor SILME
 *      (RMD) hicbir yerde yoktur; var olan klasor/dosya adiyla acilmaz.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { getDriver, resolveModel } from '../../shared/drivers.js';
import { withFtp, FtpError } from './ftp-client.js';
import { parseList } from './list-parse.js';
import {
  MAX_PROGRAM_BYTES, TEMP_PREFIX, ValidationError, sha256, isSystemEntry,
  validateCustomer, validateProgramName, validateNewFolderName, decodeText,
} from './library.js';
import { ImportPlans, publicPlan, planKey, modifiedHint, MAX_PLAN_BYTES, MAX_PLAN_MS } from './bulk-import.js';

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

/**
 * Tornadan program SILME acik mi. Silme geri donusuz oldugu icin once YAZMA kapisindan (sendPolicy) gecer, sonra
 * ayrica acilmis olmalidir: modelin `fileTransfer.deleteEnabled` degeri true (gercek tezgahta `DELE` denendikten
 * sonra config/drivers.json'da acilir) YA DA sunucu `DELETE_ENABLED=1` ile baslatilmis (yalniz dogrulama denemesi icin).
 */
export function deletePolicy(machine, flags = {}) {
  const send = sendPolicy(machine);
  if (!send.allowed) return send;
  if (flags.deleteEnabled === true) return { allowed: true, model: send.model, reason: null };
  const driver = getDriver(machine.driverId);
  const model = resolveModel(driver, machine.controllerModel);
  if (model?.fileTransfer?.deleteEnabled === true) return { allowed: true, model: send.model, reason: null };
  return {
    allowed: false,
    model: send.model,
    reason: model?.fileTransfer?.deleteReason
      ?? 'Tornadan program silme (FTP DELE) gerçek tezgahta henüz doğrulanmadı; doğrulanınca config/drivers.json\'da açılır.',
  };
}

/** "MUSTERI_B\\100200300" ya da "100200300" -> "100200300" (kucuk harf). */
const baseName = (p) => String(p ?? '').split(/[\\/]/).pop().trim().toLowerCase();

const MAX_SCAN_MS = 120_000;
const MAX_HASH_DOWNLOADS = 300;

/** Denetim kaydi icin adim kaydedici: her adimin suresi ve sonucu `steps`'e yazilir. */
function stepRecorder(steps) {
  return async (step, fn) => {
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
}

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
    /** Toplu alim planlari (bellek ici, sinirli sure): bkz. bulk-import.js */
    this.plans = new ImportPlans();
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
          'Gönderme klasör açmaz. Önce "Yeni klasör…" ile klasörü açın (ya da tezgah panelinden açın), sonra tekrar deneyin.');
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
      const timed = stepRecorder(steps);

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

  /* ------------------------------------------------------------ yeni musteri klasoru */

  /**
   * Tezgahin NcFiles kokunde YENI, bos bir musteri klasoru acar (FTP `MKD`). Mevcut hicbir sey
   * degismez; var olan klasor/dosya adiyla acilmaz; silme yoktur. Acilan klasor LIST/CWD ile dogrulanir.
   * Kayit `transfers` tablosuna kind='klasor' ile yazilir (reddedilenler dahil).
   */
  async createFolder({ machineId, name, confirm, by = null, clientIp = null }) {
    if (!this.transferEnabled) throw new DisabledError('Tezgaha yazma kapalı (TRANSFER_DISABLED=1).');
    const machine = this.#machine(machineId);
    const policy = sendPolicy(machine);
    if (!policy.allowed) throw new UnsupportedError(`${policy.model}: ${policy.reason}`);
    if (confirm !== machine.id) {
      throw new ValidationError(`Onay metni tezgah kimliğiyle aynı olmalı: ${machine.id}`);
    }
    const folder = validateNewFolderName(name);
    const ftp = this.ftpOptionsFor(machine);

    return this.#lock(machineId, 'klasör oluşturma', async () => {
      const db = this.library.db;
      const transferId = db.startTransfer({ kind: 'klasor', machineId, customer: folder, requestedBy: by, clientIp });
      const steps = [];
      const timed = stepRecorder(steps);
      let created = false;
      let actualName = folder;
      let status = 'basarisiz';
      let error = null;

      try {
        await withFtp(ftp, async (c) => {
          await timed('on-kontrol', async () => {
            const root = parseList(await c.listRaw());
            const hit = root.entries.find((e) => e.name.toLowerCase() === folder.toLowerCase());
            if (hit) {
              const e = new Error(hit.isDir
                ? `Tezgahta "${hit.name}" klasörü zaten var; yeni klasör açılmadı.`
                : `Kök dizinde "${hit.name}" adlı bir dosya var; aynı adla klasör açılamaz.`);
              e.rejected = true;
              throw e;
            }
            return `kökte "${folder}" yok (${root.entries.length} kayıt)`;
          });
          await timed('klasor-ac', async () => {
            await c.mkd(folder);
            created = true;
            return `MKD ${folder}`;
          });
          await timed('klasor-dogrula', async () => {
            const root = parseList(await c.listRaw());
            const dir = root.entries.find((e) => e.name.toLowerCase() === folder.toLowerCase());
            if (!dir || !dir.isDir) throw new Error('Klasör açıldı denildi ama kök listesinde görünmüyor');
            actualName = dir.name;
            await c.cwd(dir.name);
            const inner = parseList(await c.listRaw());
            await c.toRoot();
            if (inner.entries.length > 0) throw new Error(`Yeni klasör boş olmalıydı, ${inner.entries.length} kayıt var`);
            return `${dir.name} (içine girilebildi, boş)`;
          });
        });
        status = 'basarili';
      } catch (err) {
        error = err.message;
        if (err.rejected) status = 'reddedildi';
        else status = created ? 'dogrulanamadi' : 'basarisiz';
      }

      if (status === 'basarili') db.addFolder(machineId, actualName);
      db.finishTransfer(transferId, { status, error, steps });
      return db.getTransfer(transferId);
    });
  }

  /* ------------------------------------------- toplu iceri alma (plan + uygula) */

  /**
   * Bir tornadaki TUM programlari okuyup kutuphaneye gore siniflandiran PLANI arka planda baslatir ve plan kimligini
   * dondurur (ilerleme icin getImportPlan sorgulanir). Tornaya YALNIZ OKUMA yapilir; TRANSFER_DISABLED ve model
   * kapisi bunu engellemez (okuma). Tezgah kilidi plan boyunca tutulur: baska islem 409 alir.
   * @param {{machineId: string, folders?: string[]|null}} p `folders`: yalniz bu musteri klasorleri (kok dosyalar dahil degil)
   */
  startImportPlan({ machineId, folders = null }) {
    const machine = this.#machine(machineId);
    const ftp = this.ftpOptionsFor(machine);
    if (folders !== null && (!Array.isArray(folders) || folders.some((f) => typeof f !== 'string'))) {
      throw new ValidationError('folders bir metin listesi olmalı.');
    }
    if (this.locks.has(machineId)) {
      throw new BusyError(`${machineId} için başka bir işlem sürüyor (${this.locks.get(machineId)}). Bitmesini bekleyin.`);
    }
    const plan = this.plans.create(machineId);
    this.#lock(machineId, 'toplu okuma', () => this.#runImportPlan(plan, machine, ftp, folders))
      .catch((err) => { plan.status = 'hata'; plan.error = err.message; plan.contents.clear(); });
    return plan.id;
  }

  async #runImportPlan(plan, machine, ftp, folderFilter) {
    const startedAt = Date.now();
    const deadline = startedAt + MAX_PLAN_MS;
    const filter = folderFilter ? new Set(folderFilter.map((f) => f.toLowerCase())) : null;
    const inventory = []; // tum dosyalar: envanteri tazelemek icin
    const skipped = [];
    const warnings = [];
    const folderNames = [];
    const groups = []; // {customer, files}
    const downloaded = [];

    await withFtp(ftp, async (c) => {
      plan.progress = { phase: 'listeleme', folder: null, done: 0, total: 0 };
      const root = parseList(await c.listRaw());
      if (root.unparsed.length) warnings.push(`kök: ${root.unparsed.length} satır çözümlenemedi`);
      folderNames.push(...root.entries.filter((e) => e.isDir).map((e) => e.name));
      if (!filter) groups.push({ customer: '', files: root.entries.filter((e) => !e.isDir) });
      for (const dir of root.entries.filter((e) => e.isDir)) {
        if (filter && !filter.has(dir.name.toLowerCase())) continue;
        if (Date.now() > deadline) throw new Error('Süre sınırı aşıldı (listeleme). Klasör seçerek yeniden deneyin.');
        await sleep(this.pauseMs);
        try {
          await c.cwd(dir.name);
          const listing = parseList(await c.listRaw());
          if (listing.unparsed.length) warnings.push(`${dir.name}: ${listing.unparsed.length} satır çözümlenemedi`);
          for (const e of listing.entries.filter((x) => x.isDir)) warnings.push(`${dir.name}\\${e.name}: alt klasör alınmadı`);
          groups.push({ customer: dir.name, files: listing.entries.filter((e) => !e.isDir) });
        } catch (err) {
          if (c.closedError) throw err;
          warnings.push(`${dir.name}: listelenemedi (${err.message})`);
        } finally {
          if (!c.closedError) await c.toRoot().catch(() => {});
        }
      }

      // --- okuma: her dosya indirilir (SHA-256 + icerik plana girer) ---
      const total = groups.reduce((n, g) => n + g.files.length, 0);
      plan.progress = { phase: 'okuma', folder: null, done: 0, total };
      for (const g of groups) {
        plan.progress.folder = g.customer === '' ? '(kök)' : g.customer;
        let entered = g.customer === '';
        try {
          for (const e of g.files) {
            if (Date.now() > deadline) throw new Error('Süre sınırı aşıldı (okuma). Klasör seçerek yeniden deneyin.');
            plan.progress.done += 1;
            const note = (sha = null) => inventory.push({ customer: g.customer, name: e.name, size: e.size, modified: e.modified, sha256: sha });
            const skip = (reason) => { skipped.push({ customer: g.customer, name: e.name, reason }); note(); };

            if (isSystemEntry(g.customer, e.name)) { note(); continue; } // tezgahin kendi dosyasi: sessizce atlanir
            if (/^zz(up|rb)/i.test(e.name)) { skip('aktarım artığı (geçici dosya)'); continue; }
            try { validateCustomer(g.customer); validateProgramName(e.name); } catch (err) { skip(err.message); continue; }
            if (e.size === 0) { skip('boş dosya'); continue; }
            if (e.size != null && e.size > MAX_PROGRAM_BYTES) { skip(`çok büyük (${e.size} bayt, en fazla ${MAX_PROGRAM_BYTES})`); continue; }
            if (plan.bytes >= MAX_PLAN_BYTES) throw new Error(`Plan bellek sınırını aştı (${MAX_PLAN_BYTES} bayt). Klasör seçerek yeniden deneyin.`);

            if (!entered) {
              try { await c.cwd(g.customer); entered = true; } catch (err) {
                if (c.closedError) throw err;
                warnings.push(`${g.customer}: klasöre girilemedi (${err.message})`);
                skip('klasöre girilemedi');
                continue;
              }
            }
            let content;
            try {
              content = await c.retr(e.name, { maxBytes: MAX_PROGRAM_BYTES });
            } catch (err) {
              if (c.closedError) throw err;
              skip(`okunamadı: ${err.message}`);
              continue;
            }
            if (content.length === 0) { skip('boş dosya'); continue; }
            if (content.includes(0)) { skip('ikili dosya (NUL bayt)'); continue; }
            const sha = sha256(content);
            const key = planKey(g.customer, e.name);
            plan.contents.set(key, content);
            plan.bytes += content.length;
            downloaded.push({ key, customer: g.customer, name: e.name, size: content.length, modified: e.modified, sha256: sha });
            note(sha);
            await sleep(this.pauseMs); // uretim yapan tornanin FTP'sini yormamak icin
          }
        } finally {
          if (!c.closedError && g.customer !== '') await c.toRoot().catch(() => {});
        }
      }
    });

    // --- siniflandirma (kutuphaneye gore) ---
    plan.progress = { ...plan.progress, phase: 'siniflandirma' };
    const yeni = [];
    const ayni = [];
    const cakisma = [];
    for (const d of downloaded) {
      const cls = this.library.classifyIncoming({ customer: d.customer, name: d.name, sha256: d.sha256, content: plan.contents.get(d.key) });
      if (cls.kind === 'yeni') {
        yeni.push({ key: d.key, customer: d.customer, name: d.name, size: d.size, modified: d.modified });
      } else if (cls.kind === 'ayni') {
        ayni.push({ customer: d.customer, name: d.name, size: d.size, versionNo: cls.versionNo, latestVersion: cls.latestVersion });
      } else {
        cakisma.push({
          key: d.key, customer: d.customer, name: d.name, size: d.size, modified: d.modified, sha256: d.sha256,
          programId: cls.programId, libraryVersion: cls.latest.versionNo, librarySize: cls.latest.size,
          libraryCreatedAt: cls.latest.createdAt, eolOnlyVersion: cls.eolOnlyVersion,
          hint: modifiedHint(d.modified, cls.latest.createdAt),
        });
      }
    }

    // Gorulen torna durumunu envantere yaz (matris hemen dogru olsun). Klasor secilmisse envanter eksik olur:
    // o zaman yalniz SHA'lar islenir.
    const finishedAt = Date.now();
    if (!filter) {
      this.library.db.replaceInventory(machine.id, inventory, { startedAt, finishedAt, folders: folderNames });
    } else {
      for (const d of downloaded) this.library.db.setInventorySha(machine.id, d.customer, d.name, d.sha256);
    }

    plan.result = {
      summary: {
        listed: inventory.length, yeni: yeni.length, ayni: ayni.length, cakisma: cakisma.length,
        atlanan: skipped.length, bytes: plan.bytes, eolOnly: cakisma.filter((x) => x.eolOnlyVersion != null).length,
      },
      yeni, ayni, cakisma, atlanan: skipped, warnings, folders: folderNames, filtered: !!filter, durationMs: finishedAt - startedAt,
    };
    plan.progress = { ...plan.progress, phase: 'bitti' };
    plan.status = 'bitti';
  }

  /** Plan durumu/ilerlemesi (bitince plan listeleri de gelir). */
  getImportPlan(machineId, planId) {
    this.#machine(machineId);
    const plan = this.plans.get(planId, machineId);
    if (!plan) throw new NotFoundError('Plan bulunamadı ya da süresi doldu (30 dk). Planı yeniden oluşturun.');
    return publicPlan(plan);
  }

  /** Bir cakismanin iki tarafi (tezgahtaki ve kutuphanedeki EN SON surum): arayuz farki gosterir. */
  importPlanDiff(machineId, planId, key) {
    this.#machine(machineId);
    const plan = this.plans.get(planId, machineId);
    if (!plan || plan.status !== 'bitti') throw new NotFoundError('Plan bulunamadı ya da süresi doldu. Planı yeniden oluşturun.');
    const item = plan.result.cakisma.find((x) => x.key === key);
    const content = plan.contents.get(key);
    if (!item || !content) throw new NotFoundError('Bu çakışma planda yok.');
    const latest = this.library.db.getVersion(item.programId, item.libraryVersion);
    if (!latest) throw new NotFoundError('Kütüphanedeki sürüm bulunamadı.');
    const side = (buf) => { const d = decodeText(buf); return { text: d.text, encoding: d.encoding, lineEnding: d.lineEnding, size: buf.length }; };
    return {
      key, customer: item.customer, name: item.name,
      lathe: { ...side(content), modified: item.modified },
      library: { ...side(latest.content), versionNo: item.libraryVersion, createdAt: latest.meta.createdAt },
      eolOnlyVersion: item.eolOnlyVersion,
    };
  }

  /**
   * Plani kutuphaneye uygular. Tornaya BAGLANILMAZ (icerik plandan). Yeni programlarin hepsi alinir (`skipKeys`
   * disinda); cakismalar YALNIZ `decisions[key] === 'al'` ise (tezgahtaki hal yeni surum olur), baskasi atlanir.
   * Ayni plan ikinci kez uygulanirsa sonuc ayni kalir (icerik SHA'si ayniysa yeni surum acilmaz).
   */
  applyImport({ machineId, planId, decisions = {}, skipKeys = [], by = null }) {
    this.#machine(machineId);
    const plan = this.plans.get(planId, machineId);
    if (!plan || plan.status !== 'bitti') throw new NotFoundError('Plan bulunamadı ya da süresi doldu. Planı yeniden oluşturun.');
    if (decisions === null || typeof decisions !== 'object' || Array.isArray(decisions)) throw new ValidationError('decisions bir nesne olmalı.');
    for (const [k, v] of Object.entries(decisions)) {
      if (v !== 'al' && v !== 'atla') throw new ValidationError(`Karar geçersiz: "${k}" için "${v}" (al ya da atla).`);
    }
    const skip = new Set(Array.isArray(skipKeys) ? skipKeys : []);
    const note = `${machineId} toplu alım`;
    const out = { yeniProgram: 0, yeniSurum: 0, zatenVardi: 0, atlanan: 0, hatalar: [] };

    const take = (item) => {
      const content = plan.contents.get(item.key);
      if (!content) { out.hatalar.push({ customer: item.customer, name: item.name, error: 'içerik planda yok' }); return; }
      try {
        const r = this.library.addFromMachine({ machineId, customer: item.customer, name: item.name, content, createdBy: by, note });
        if (!r.created) out.zatenVardi += 1;
        else if (r.newProgram) out.yeniProgram += 1;
        else out.yeniSurum += 1;
        this.library.db.setInventorySha(machineId, item.customer, item.name, r.version.sha256);
      } catch (err) {
        out.hatalar.push({ customer: item.customer, name: item.name, error: err.message });
      }
    };

    for (const item of plan.result.yeni) {
      if (skip.has(item.key)) out.atlanan += 1; else take(item);
    }
    for (const item of plan.result.cakisma) {
      if (decisions[item.key] === 'al' && !skip.has(item.key)) take(item); else out.atlanan += 1;
    }
    plan.applied = true;
    return out;
  }

  /* -------------------------------------------------------------- tornadan silme */

  #assertDeleteAllowed(machine) {
    if (!this.transferEnabled) throw new DisabledError('Tornaya yazma kapalı (TRANSFER_DISABLED=1).');
    const p = deletePolicy(machine, this.flags);
    if (!p.allowed) throw new UnsupportedError(`${p.model ?? 'Bu model'}: ${p.reason}`);
  }

  /**
   * Silinecek dosyayi inceler (tornaya YALNIZ OKUMA). Sonunda istemci HEDEF KLASORDEdir. Kurallar:
   *   - calisan/secili program silinmez (canli veri yoksa onay ister)
   *   - tezgahin sistem dosyasi (MDIBlock) ve klasorler silinmez
   *   - kok dizindeki (ortak alan) dosya ek onay ister
   *   - KUTUPHANEDE ayni icerikli kopya yoksa ek onay ister ("kopyasiz sil: geri alinamaz")
   */
  async #inspectDelete(c, { machine, customer, name }) {
    const checks = [];
    const add = (id, level, title, detail = '', ack = null) => checks.push({ id, level, title, detail, ...(ack ? { ack } : {}) });
    const out = { checks, folder: null, entry: null, libraryCopy: null };

    const live = this.liveInfo(machine.id);
    if (!live || !live.connected) {
      add('calisan-program', 'warn', 'Tezgahtan canlı veri gelmiyor',
        'Çalışan/seçili programı kontrol edemiyorum (ajan çalışmıyor ya da tezgah veri vermiyor). Silinen dosya çalışan program ise tezgah durabilir.',
        'unknown-state');
    } else {
      const running = [live.program, live.mainProgram].filter(Boolean).map(baseName);
      if (running.includes(name.toLowerCase())) {
        add('calisan-program', 'block', 'Bu program şu an çalışan/seçili program',
          `Tezgahta çalışan program: ${live.program ?? '—'} · ana program: ${live.mainProgram ?? '—'}. Çalışan program silinmez.`);
        return out;
      }
      add('calisan-program', 'ok', 'Çalışan programla çakışma yok', `Çalışan program: ${live.program ?? '—'} · ana program: ${live.mainProgram ?? '—'}`);
    }

    const root = parseList(await c.listRaw());
    let listing = root;
    let folder = '';
    if (customer !== '') {
      const dir = root.entries.find((e) => e.isDir && e.name.toLowerCase() === customer.toLowerCase());
      if (!dir) { add('klasor', 'block', `Tezgahta "${customer}" klasörü yok`); return out; }
      folder = dir.name;
      await c.cwd(folder);
      listing = parseList(await c.listRaw());
    } else {
      add('klasor', 'warn', 'Kök dizindeki (ortak alan) dosya',
        'Kök dizindeki programlar tüm müşteriler için ortak olabilir (ör. ortak alt programlar). Silmeden önce hiçbir programın bunu çağırmadığından emin olun.',
        'root-target');
    }
    out.folder = folder;

    const entry = listing.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) { add('dosya', 'block', `Tezgahta "${name}" dosyası yok`, 'Bu arada silinmiş ya da adı değişmiş olabilir.'); return out; }
    if (entry.isDir) { add('dosya', 'block', `"${entry.name}" bir klasör`, 'Klasör silinmez.'); return out; }
    if (isSystemEntry(folder, entry.name)) { add('sistem', 'block', `"${entry.name}" tezgahın kendi dosyası`, 'Sistem dosyaları silinmez.'); return out; }
    out.entry = { name: entry.name, size: entry.size, modified: entry.modified, sha256: null };
    add('dosya', 'ok', `Dosya tezgahta: ${folder === '' ? '' : `${folder}\\`}${entry.name}`, `${entry.size ?? '?'} bayt · tezgah tarihi ${entry.modified ?? '—'}`);

    // Kutuphane kopyasi: silinen dosya geri getirilebilsin.
    if (entry.size != null && entry.size > MAX_PROGRAM_BYTES) {
      add('kopya', 'warn', 'Dosya çok büyük: kütüphane kopyası doğrulanamıyor', `1 MB'tan büyük (${entry.size} bayt); silinirse geri alınamaz.`, 'no-backup');
      return out;
    }
    const content = await c.retr(entry.name, { maxBytes: MAX_PROGRAM_BYTES });
    const sha = sha256(content);
    out.entry.sha256 = sha;
    const program = this.library.db.findProgram(folder, entry.name);
    const versions = program ? this.library.db.listVersions(program.id) : [];
    const hit = versions.find((v) => v.sha256 === sha);
    if (hit) {
      out.libraryCopy = { programId: program.id, versionNo: hit.versionNo, latestVersion: versions[0].versionNo };
      add('kopya', 'ok', `Kütüphanede aynı içerikli kopya var: v${hit.versionNo}`,
        hit.versionNo === versions[0].versionNo ? 'Bu, kütüphanedeki son sürüm.' : `Kütüphanedeki son sürüm v${versions[0].versionNo}.`);
    } else if (program) {
      add('kopya', 'warn', 'Kütüphanedeki hiçbir sürümle içerik tutmuyor',
        'Bu hâli silinirse kaybolur. Önce Tezgah panelinden "Kütüphaneye al" ile (çakışma çözümüyle) yeni sürüm olarak alın ya da kopyasız silmeyi onaylayın.',
        'no-backup');
    } else {
      add('kopya', 'warn', 'Kütüphanede bu programın kopyası yok',
        'Silinirse geri alınamaz. Önce "Kütüphaneye al" ile yedekleyin ya da kopyasız silmeyi onaylayın.', 'no-backup');
    }
    return out;
  }

  /** Silme ON KONTROLU: tornaya yalniz okuma. Sonuc: kontroller, onay gereken uyarilar, silinebilir mi. */
  async deletePrecheck({ machineId, customer = '', name, acks = [] }) {
    const machine = this.#machine(machineId);
    const target = validateCustomer(customer);
    const file = String(name ?? '').trim();
    if (file === '' || /[\\/\r\n\0]/.test(file) || file === '.' || file === '..') throw new ValidationError('Program adı geçersiz.');
    const base = { machineId, customer: target, name: file };
    if (!this.transferEnabled) {
      return { ...base, canDelete: false, needsAck: [], entry: null, libraryCopy: null,
        checks: [{ id: 'ozellik', level: 'block', title: 'Tornaya yazma kapalı', detail: 'Sunucu TRANSFER_DISABLED=1 ile başlatılmış.' }] };
    }
    const policy = deletePolicy(machine, this.flags);
    if (!policy.allowed) {
      return { ...base, canDelete: false, needsAck: [], entry: null, libraryCopy: null,
        checks: [{ id: 'model', level: 'block', title: `${policy.model ?? 'Bu model'}: tornadan silme kapalı`, detail: policy.reason }] };
    }
    const ftp = this.ftpOptionsFor(machine);
    const result = await this.#lock(machineId, 'silme ön kontrolü', () =>
      withFtp(ftp, (c) => this.#inspectDelete(c, { machine, customer: target, name: file })));
    const sum = this.#summarize(result.checks, acks);
    return { ...base, customer: result.folder ?? target, name: result.entry?.name ?? file, checks: result.checks,
      canDelete: sum.canSend, needsAck: sum.needsAck, entry: result.entry, libraryCopy: result.libraryCopy };
  }

  /**
   * TORNADAN SILME (FTP DELE). Geri donusuz: tum kapilar kodda zorlanir.
   *   - ozellik acik, model/silme kapisi acik (deletePolicy)
   *   - onay metni = PROGRAM ADI (yanlis dosyayi silmeyi onler)
   *   - on kontrol (calisan program, sistem dosyasi, kok, kutuphane kopyasi) gecmeli; uyarilar onaylanmali
   *   - DELE'den hemen once dosyanin hala AYNI BOYUTTA oldugu dogrulanir; sonra listeden kalktigi dogrulanir
   *   - her silme (reddedilenler dahil) `transfers` tablosuna kind='silme' ile yazilir
   * Klasor SILINMEZ; yalniz tek dosya.
   */
  async deleteProgram({ machineId, customer = '', name, confirm, by = null, clientIp = null, acks = [] }) {
    const machine = this.#machine(machineId);
    this.#assertDeleteAllowed(machine);
    const file = String(name ?? '').trim();
    if (file === '' || /[\\/\r\n\0]/.test(file) || file === '.' || file === '..') throw new ValidationError('Program adı geçersiz.');
    if (confirm !== file) throw new ValidationError(`Onay metni program adıyla aynı olmalı: ${file}`);
    const target = validateCustomer(customer);
    const ftp = this.ftpOptionsFor(machine);

    return this.#lock(machineId, 'silme', async () => {
      const db = this.library.db;
      const transferId = db.startTransfer({ kind: 'silme', machineId, customer: target, name: file, requestedBy: by, clientIp, acks });
      const steps = [];
      const timed = stepRecorder(steps);
      let folder = target;
      let entryName = file;
      let shaDeleted = null;
      let deleted = false;
      let status = 'basarisiz';
      let error = null;

      try {
        await withFtp(ftp, async (c) => {
          let ins;
          await timed('on-kontrol', async () => {
            ins = await this.#inspectDelete(c, { machine, customer: target, name: file });
            const sum = this.#summarize(ins.checks, acks);
            if (!sum.canSend) {
              const why = ins.checks.filter((k) => k.level === 'block' || (k.level === 'warn' && k.ack && !acks.includes(k.ack)));
              const e = new Error(why.map((k) => k.title).join(' · '));
              e.rejected = true;
              throw e;
            }
            return `${ins.checks.length} kontrol geçti${acks.length ? ` (onaylananlar: ${acks.join(', ')})` : ''}`;
          });
          folder = ins.folder;
          entryName = ins.entry.name;
          shaDeleted = ins.entry.sha256;

          await timed('silme', async () => {
            // Son an: operator panelden dosyayi degistirmis olabilir.
            const now = parseList(await c.listRaw()).entries.find((e) => !e.isDir && e.name.toLowerCase() === entryName.toLowerCase());
            if (!now) throw new Error('dosya bu arada tezgahtan kalkmış');
            if (now.size !== ins.entry.size) throw new Error(`dosya bu arada değişti (boyut ${ins.entry.size} → ${now.size}); silinmedi`);
            await c.dele(now.name);
            deleted = true;
            return `DELE ${now.name}`;
          });
          await timed('silme-dogrula', async () => {
            const still = parseList(await c.listRaw()).entries.find((e) => e.name.toLowerCase() === entryName.toLowerCase());
            if (still) throw new Error('Tezgah silindi dedi ama dosya listede duruyor');
            return 'listede yok';
          });
        });
        status = 'basarili';
      } catch (err) {
        error = err.message;
        if (err.rejected) status = 'reddedildi';
        else status = deleted ? 'dogrulanamadi' : 'basarisiz';
      }

      if (status === 'basarili') db.removeInventory(machineId, folder, entryName);
      db.finishTransfer(transferId, { status, shaVerified: shaDeleted, error, steps });
      return db.getTransfer(transferId);
    });
  }
}

export { FtpError };
