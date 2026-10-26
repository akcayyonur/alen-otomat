/**
 * Tezgahtaki program dosyalari: tarama, iceri alma, on kontrol ve GONDERME.
 *
 * Tasima yolu FTP'dir (bkz. ftp-client.js ve CLAUDE.md "NC program aktarimi").
 * FTP, kontrolcunun kendi korumalarini (calisan programi koruma) ATLAR; o yuzden
 * butun guvenlik denetimi BURADADIR. Degismez kurallar:
 *
 *   1. Dosya gonderilir, ASLA calistirilir/secilmez. (Burada program secme ya da
 *      baslatma diye bir cagri yoktur; FTP'nin zaten boyle bir komutu da yok.)
 *   2. Hedefte ayni ad varsa UZERINE YAZILMAZ (buyuk/kucuk harf duyarsiz: CE oyle). TEK ISTISNA: TOPLU GONDERME
 *      (startPushApply): kullanicinin planda onayladigi programlarin uzerine, tornadaki eski hal ONCE KUTUPHANEYE
 *      YEDEKLENEREK ve yan adla (ZZRB) saklanarak yazilir; "ezme" semantigine (RNTO hedefte ayni ad) GUVENILMEZ.
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
  MAX_PROGRAM_BYTES, TEMP_PREFIX, ROLLBACK_PREFIX, ValidationError, sha256, isSystemEntry,
  validateCustomer, validateProgramName, validateNewFolderName, decodeText, compareEntry,
} from './library.js';
import { ImportPlans, publicPlan, publicPushPlan, planKey, modifiedHint, MAX_PLAN_BYTES, MAX_PLAN_MS } from './bulk-import.js';

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
 * ayrica acilmis olmalidir: modelin `fileTransfer.deleteEnabled` degeri true (config/drivers.json; 11TB icin
 * 2026-10-13'te fabrika sahibi karariyla acildi) YA DA sunucu `DELETE_ENABLED=1` ile baslatilmis (yalniz dogrulama).
 * `DELETE_DISABLED=1` (flags.deleteDisabled) her durumda silmeyi KAPATAN acil anahtardir (yapilandirmayi degistirmeden).
 */
export function deletePolicy(machine, flags = {}) {
  const send = sendPolicy(machine);
  if (!send.allowed) return send;
  if (flags.deleteDisabled === true) {
    return { allowed: false, model: send.model, reason: 'Tornadan silme kapatıldı (DELETE_DISABLED=1).' };
  }
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
/** Toplu gonderme sonuc listesi ve "tornada ozel" listesi sinirlari (yanit boyutu). */
const MAX_PUSH_RESULTS = 5000;
const MAX_PUSH_LIST = 1500;

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
   *   flags?: {transferDisabled?: boolean, deleteEnabled?: boolean, deleteDisabled?: boolean},
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
    /** Toplu gonderme planlari (bellek ici; uygulama surerken atilmaz): bkz. startPushPlan */
    this.pushPlans = new ImportPlans();
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

  /* ------------------------------------------------------------ TOPLU GONDERME (ezme dahil) */

  /**
   * Kutuphanedeki programlarin SON surumlerini bir tornaya topluca yazmak icin PLAN cikarir (tornaya YALNIZ OKUMA; arka planda).
   * Her kutuphane programi icin: tornada yok -> `yeni`; tornada ayni icerik -> `ayni`; tornada farkli icerik -> `ezilecek`
   * (`needsBackup`: tornadaki hal kutuphanedeki hicbir surumle tutmuyorsa true: uygulamada yedeklenir); musteri klasoru tornada
   * yoksa / program su an calisiyorsa -> `atlanan`. Tornada olup kutuphanede olmayanlara DOKUNULMAZ (`tornadaOzel`: yalniz listelenir).
   * Kok dizindeki (ortak alan) programlar toplu gonderime GIRMEZ. Plan, model kapisi kapali olsa da cikarilabilir (okuma);
   * uygulama kapali modelde reddedilir.
   * @param {{machineId: string, folders?: string[]|null}} p `folders`: yalniz bu musteri klasorleri
   */
  startPushPlan({ machineId, folders = null }) {
    const machine = this.#machine(machineId);
    const ftp = this.ftpOptionsFor(machine);
    if (folders !== null && (!Array.isArray(folders) || folders.some((f) => typeof f !== 'string'))) {
      throw new ValidationError('folders bir metin listesi olmalı.');
    }
    if (this.locks.has(machineId)) {
      throw new BusyError(`${machineId} için başka bir işlem sürüyor (${this.locks.get(machineId)}). Bitmesini bekleyin.`);
    }
    const plan = this.pushPlans.create(machineId);
    this.#lock(machineId, 'toplu gönderme planı', () => this.#runPushPlan(plan, machine, ftp, folders))
      .catch((err) => { plan.status = 'hata'; plan.error = err.message; });
    return plan.id;
  }

  async #runPushPlan(plan, machine, ftp, folderFilter) {
    const startedAt = Date.now();
    const deadline = startedAt + MAX_PLAN_MS;
    const filter = folderFilter ? new Set(folderFilter.map((f) => f.toLowerCase())) : null;
    const live = this.liveInfo(machine.id);
    const unknownState = !live || !live.connected;
    const running = unknownState ? [] : [live.program, live.mainProgram].filter(Boolean).map(baseName);

    const all = this.library.db.listPrograms();
    const programs = all.filter((p) => p.customer !== '' && (!filter || filter.has(p.customer.toLowerCase())));
    const kokProgramSayisi = all.filter((p) => p.customer === '').length;

    const warnings = [];
    const folderNames = [];
    /** @type {Map<string, {name: string, files: Map<string, object>, dirs: Set<string>}>} */
    const lathe = new Map();
    let rootFiles = 0;

    await withFtp(ftp, async (c) => {
      plan.progress = { phase: 'listeleme', folder: null, done: 0, total: 0 };
      const root = parseList(await c.listRaw());
      if (root.unparsed.length) warnings.push(`kök: ${root.unparsed.length} satır çözümlenemedi`);
      rootFiles = root.entries.filter((e) => !e.isDir).length;
      folderNames.push(...root.entries.filter((e) => e.isDir).map((e) => e.name));
      for (const dir of root.entries.filter((e) => e.isDir)) {
        if (filter && !filter.has(dir.name.toLowerCase())) continue;
        if (Date.now() > deadline) throw new Error('Süre sınırı aşıldı (listeleme). Klasör seçerek yeniden deneyin.');
        await sleep(this.pauseMs);
        try {
          await c.cwd(dir.name);
          const listing = parseList(await c.listRaw());
          if (listing.unparsed.length) warnings.push(`${dir.name}: ${listing.unparsed.length} satır çözümlenemedi`);
          const files = new Map();
          const dirs = new Set();
          for (const e of listing.entries) {
            if (e.isDir) dirs.add(e.name.toLowerCase());
            else files.set(e.name.toLowerCase(), { customer: dir.name, name: e.name, size: e.size, modified: e.modified, sha256: null });
          }
          lathe.set(dir.name.toLowerCase(), { name: dir.name, files, dirs });
        } catch (err) {
          if (c.closedError) throw err;
          warnings.push(`${dir.name}: listelenemedi (${err.message})`);
        } finally {
          if (!c.closedError) await c.toRoot().catch(() => {});
        }
      }

      // Icerik karsilastirmasi: kutuphanede ayni (musteri, ad) olan ve boyutu bir surumle tutan dosyalar indirilip SHA'lanir.
      // Boyutu hicbir surumle tutmayan dosya zaten KESIN farklidir (indirmeye gerek yok).
      const entries = [...lathe.values()].flatMap((f) => [...f.files.values()]);
      const candidates = this.library.hashCandidates(entries);
      plan.progress = { phase: 'okuma', folder: null, done: 0, total: candidates.length };
      const byFolder = new Map();
      for (const e of candidates) {
        if (!byFolder.has(e.customer)) byFolder.set(e.customer, []);
        byFolder.get(e.customer).push(e);
      }
      for (const [folder, list] of byFolder) {
        plan.progress.folder = folder;
        try {
          await c.cwd(folder);
          for (const e of list) {
            if (Date.now() > deadline) throw new Error('Süre sınırı aşıldı (okuma). Klasör seçerek yeniden deneyin.');
            plan.progress.done += 1;
            try {
              e.sha256 = sha256(await c.retr(e.name, { maxBytes: MAX_PROGRAM_BYTES }));
            } catch (err) {
              if (c.closedError) throw err;
              warnings.push(`${folder}\\${e.name}: okunamadı (${err.message})`);
            }
            await sleep(this.pauseMs); // uretim yapan tornanin FTP'sini yormamak icin
          }
        } finally {
          if (!c.closedError) await c.toRoot().catch(() => {});
        }
      }
    });

    plan.progress = { ...plan.progress, phase: 'siniflandirma' };
    const yeni = [];
    const ezilecek = [];
    const ayni = [];
    const atlanan = [];
    const inLibrary = new Set();
    for (const p of programs) {
      const base = { key: planKey(p.customer, p.name), programId: p.id, customer: p.customer, name: p.name };
      const head = { versionNo: p.latest.versionNo, size: p.latest.size, sha256: p.latest.sha256 };
      const lf = lathe.get(p.customer.toLowerCase());
      if (!lf) { atlanan.push({ ...base, reason: `tornada "${p.customer}" klasörü yok (toplu gönderme klasör açmaz)` }); continue; }
      inLibrary.add(`${p.customer.toLowerCase()}\u0000${p.name.toLowerCase()}`);
      if (lf.dirs.has(p.name.toLowerCase())) { atlanan.push({ ...base, reason: 'tornada aynı adlı bir klasör var' }); continue; }
      const hit = lf.files.get(p.name.toLowerCase());
      if (!hit) { yeni.push({ ...base, ...head }); continue; }
      if (running.includes(p.name.toLowerCase())) { atlanan.push({ ...base, reason: 'torna şu an bu programı çalıştırıyor/seçili (üzerine yazılmaz)' }); continue; }
      const versions = this.library.db.listVersions(p.id).map((v) => ({ versionNo: v.versionNo, sha256: v.sha256, size: v.size }));
      const cmp = compareEntry(hit, versions);
      if (cmp.status === 'guncel') { ayni.push({ ...base, versionNo: head.versionNo }); continue; }
      ezilecek.push({
        ...base, ...head, latheSize: hit.size, latheSha256: hit.sha256, modified: hit.modified,
        latheStatus: cmp.status, // eski (kutuphanede bir surumle ayni) | farkli (hicbir surumle tutmuyor) | belirsiz
        latheVersionNo: cmp.status === 'eski' ? cmp.versionNo : null,
        needsBackup: cmp.status === 'eski' ? false : true, // belirsiz: indirilemedi, uygulamada okunur ve yedeklenir
      });
    }

    // Tornada olup kutuphanede olmayanlar: DOKUNULMAZ, yalniz listelenir. ZZUP/ZZRB artiklari ayrica uyari.
    const tornadaOzel = [];
    let tornadaOzelSayisi = 0;
    const artik = [];
    for (const lf of lathe.values()) {
      for (const e of lf.files.values()) {
        if (/^zz(up|rb)\d{6}$/i.test(e.name)) { artik.push(`${lf.name}\\${e.name}`); continue; }
        if (inLibrary.has(`${lf.name.toLowerCase()}\u0000${e.name.toLowerCase()}`)) continue;
        tornadaOzelSayisi += 1;
        if (tornadaOzel.length < MAX_PUSH_LIST) tornadaOzel.push({ customer: lf.name, name: e.name, size: e.size });
      }
    }
    if (artik.length) warnings.push(`${artik.length} aktarım artığı dosya tornada duruyor (${artik.slice(0, 3).join(', ')}${artik.length > 3 ? ' …' : ''}); otomatik silinmez`);

    const policy = sendPolicy(machine);
    plan.result = {
      summary: {
        kutuphane: programs.length, yeni: yeni.length, ezilecek: ezilecek.length, yedeklenecek: ezilecek.filter((x) => x.needsBackup).length,
        ayni: ayni.length, atlanan: atlanan.length, tornadaOzel: tornadaOzelSayisi, kokKutuphane: kokProgramSayisi, tornaKokDosya: rootFiles,
      },
      yeni, ezilecek, ayni, atlanan, tornadaOzel, warnings, folders: folderNames, filtered: !!filter,
      unknownState, running,
      gate: { transferEnabled: this.transferEnabled, allowed: policy.allowed, reason: policy.reason, model: policy.model },
      durationMs: Date.now() - startedAt,
    };
    plan.progress = { ...plan.progress, phase: 'bitti' };
    plan.status = 'bitti';
  }

  /** Toplu gonderme plani + (varsa) uygulama durumu/ilerlemesi. */
  getPushPlan(machineId, planId) {
    this.#machine(machineId);
    const plan = this.pushPlans.get(planId, machineId);
    if (!plan) throw new NotFoundError('Plan bulunamadı ya da süresi doldu (30 dk). Planı yeniden oluşturun.');
    return publicPushPlan(plan);
  }

  /**
   * Plani UYGULAR: `yeni` programlar yazilir, `ezilecek` olanlarin uzerine YEDEKLEYEREK yazilir. Arka planda calisir (yuzlerce program).
   * Kapilar (hepsi kodda): ozellik acik, model kapisi acik, onay metni = tezgah kimligi, plan hazir ve daha once uygulanmamis,
   * canli veri yoksa 'unknown-state' onayi. Program basina kurallar icin bkz. #pushOne.
   * @returns {{started: true, total: number}}
   */
  startPushApply({ machineId, planId, confirm, by = null, clientIp = null, acks = [], skipKeys = [] }) {
    if (!this.transferEnabled) throw new DisabledError('Tornaya yazma kapalı (TRANSFER_DISABLED=1).');
    const machine = this.#machine(machineId);
    const policy = sendPolicy(machine);
    if (!policy.allowed) throw new UnsupportedError(`${policy.model}: ${policy.reason}`);
    if (confirm !== machine.id) throw new ValidationError(`Onay metni tezgah kimliğiyle aynı olmalı: ${machine.id}`);
    const plan = this.pushPlans.get(planId, machineId);
    if (!plan || plan.status !== 'bitti') throw new NotFoundError('Plan bulunamadı ya da süresi doldu. Planı yeniden oluşturun.');
    if (plan.apply) throw new ValidationError('Bu plan zaten uygulanmaya başladı. Yeni bir plan çıkarın (aynı olanlar atlanır, kaldığı yerden sürer).', 409);
    if (plan.result.unknownState && !acks.includes('unknown-state')) {
      const err = new ValidationError('Tezgahtan canlı veri gelmiyor: çalışan program bilinemez. Devam etmek için bunu onaylamanız gerekir.');
      err.code = 'unknown-state';
      throw err;
    }
    if (!Array.isArray(skipKeys)) throw new ValidationError('skipKeys bir liste olmalı.');
    const skip = new Set(skipKeys);
    const items = [...plan.result.yeni, ...plan.result.ezilecek].filter((it) => !skip.has(it.key));
    if (items.length === 0) throw new ValidationError('Gönderilecek program yok (hepsi zaten aynı, atlandı ya da seçilmedi).');
    if (this.locks.has(machineId)) {
      throw new BusyError(`${machineId} için başka bir işlem sürüyor (${this.locks.get(machineId)}). Bitmesini bekleyin.`);
    }
    plan.apply = {
      status: 'calisiyor', startedAt: Date.now(), finishedAt: null, total: items.length, done: 0, current: null, stopRequested: false, error: null, by,
      counts: { yeni: 0, ezilen: 0, ayni: 0, atlanan: 0, hata: 0, yedeklendi: 0, yedekKutuphanedeVardi: 0, yanAdliKaldi: 0 },
      results: [],
    };
    plan.applied = true;
    this.#lock(machineId, 'toplu gönderme', () => this.#runPushApply(plan, machine, items, { by, clientIp, acks }))
      .catch((err) => { plan.apply.status = 'hata'; plan.apply.error = err.message; plan.apply.finishedAt = Date.now(); });
    return { started: true, total: items.length };
  }

  /** Calisan toplu gondermeyi DURDURUR (o anki program bitirilir; kalanlara dokunulmaz). Sonra yeni plan kaldigi yerden surdurur. */
  stopPushApply({ machineId, planId }) {
    this.#machine(machineId);
    const plan = this.pushPlans.get(planId, machineId);
    if (!plan?.apply || plan.apply.status !== 'calisiyor') throw new NotFoundError('Çalışan bir toplu gönderme yok.');
    plan.apply.stopRequested = true;
    return { stopping: true };
  }

  async #runPushApply(plan, machine, items, { by, clientIp, acks }) {
    const a = plan.apply;
    const ftp = this.ftpOptionsFor(machine);
    const groups = new Map();
    for (const it of items) {
      const k = it.customer.toLowerCase();
      if (!groups.has(k)) groups.set(k, { customer: it.customer, items: [] });
      groups.get(k).items.push(it);
    }
    const record = (it, r) => {
      a.done += 1;
      const c = a.counts;
      if (r.outcome === 'yeni') c.yeni += 1;
      else if (r.outcome === 'ezildi') {
        c.ezilen += 1;
        if (r.backup?.kind === 'yedek' && r.backup.created) c.yedeklendi += 1;
        else if (r.backup?.kind === 'surum') c.yedekKutuphanedeVardi += 1;
      } else if (r.outcome === 'ayni') c.ayni += 1;
      else if (r.outcome === 'atlandi') c.atlanan += 1;
      else c.hata += 1;
      if (r.warning) c.yanAdliKaldi += 1;
      if (a.results.length < MAX_PUSH_RESULTS) {
        a.results.push({ customer: it.customer, name: it.name, outcome: r.outcome, status: r.status, detail: r.detail ?? null, backup: r.backup ?? null, warning: r.warning ?? null, transferId: r.transferId ?? null });
      }
    };

    for (const g of [...groups.values()].sort((x, y) => x.customer.localeCompare(y.customer, 'tr'))) {
      const queue = [...g.items];
      let reconnects = 0;
      while (queue.length > 0 && !a.stopRequested) {
        let lost = false;
        try {
          await withFtp(ftp, async (c) => {
            const root = parseList(await c.listRaw());
            const dir = root.entries.find((e) => e.isDir && e.name.toLowerCase() === g.customer.toLowerCase());
            if (!dir) {
              for (const it of queue.splice(0)) {
                record(it, this.#pushSkipRecord(machine, it, 'tornada müşteri klasörü yok (klasör açılmaz)', { by, clientIp, acks }));
              }
              return;
            }
            await c.cwd(dir.name);
            while (queue.length > 0 && !a.stopRequested) {
              const it = queue[0];
              a.current = `${it.customer}\\${it.name}`;
              const r = await this.#pushOne(c, ftp, { machine, folder: dir.name, item: it, by, clientIp, acks });
              queue.shift();
              record(it, r);
              if (r.connectionLost) { lost = true; return; }
              await sleep(this.pauseMs);
            }
          });
        } catch (err) {
          // Oturum acilamadi / liste alinamadi: kalanlar icin tekrar denenir, olmazsa hata yazilir.
          reconnects += 1;
          if (reconnects > 3) {
            for (const it of queue.splice(0)) record(it, this.#pushSkipRecord(machine, it, `tornaya bağlanılamadı: ${err.message}`, { by, clientIp, acks }, 'hata'));
          } else if (this.pauseMs > 0) await sleep(1000);
        }
        if (lost) { reconnects += 1; if (reconnects > 3) { for (const it of queue.splice(0)) record(it, this.#pushSkipRecord(machine, it, 'bağlantı tekrar tekrar koptu', { by, clientIp, acks }, 'hata')); } }
      }
      if (a.stopRequested) break;
    }
    a.current = null;
    a.finishedAt = Date.now();
    a.status = a.stopRequested ? 'durduruldu' : 'bitti';
  }

  /** Yazmadan atlanan/hataya dusen program icin denetim kaydi + sonuc (tornaya dokunulmadi). */
  #pushSkipRecord(machine, item, reason, { by, clientIp, acks }, outcome = 'atlandi') {
    const db = this.library.db;
    const transferId = db.startTransfer({
      kind: 'toplu', machineId: machine.id, programId: item.programId, customer: item.customer, name: item.name,
      size: item.size, shaSent: item.sha256, requestedBy: by, clientIp, acks,
    });
    db.finishTransfer(transferId, { status: outcome === 'hata' ? 'basarisiz' : 'reddedildi', error: reason, steps: [] });
    return { outcome, status: outcome === 'hata' ? 'basarisiz' : 'reddedildi', detail: reason, transferId };
  }

  /**
   * TEK programi tornaya yazar (bir musteri klasorunde; istemci o klasorde). Degismez kurallar (testle zorlanir):
   *   - calisan/secili programin uzerine yazilmaz; kutuphanede plandan sonra yeni surum olustuysa yazilmaz (planin gosterdigi surum gider)
   *   - once GECICI adla (ZZUP) yuklenir, boyut + geri okunan SHA-256 dogrulanir: bozuk iletim tornadaki dosyaya hic dokunmaz
   *   - hedefte dosya varsa: ESKISI yan ada (ZZRB) alinir (RNFR/RNTO, hedef bos oldugu icin "ezme" semantigine GUVENILMEZ), yan adli dosya okunup
   *     kutuphaneye YEDEKLENIR (kutuphanedeki bir surumle ayniysa ayrica yedek gerekmez); yedek alinamazsa eski hal geri konur ve yazilmaz
   *   - yeni dosya nihai ada cevrilir, geri okunup dogrulanir; tutmazsa yeni dosya silinir ve eski hal geri konur
   *   - dogrulama tamam olunca yan adli dosya silinir (silinemezse kalir ve raporlanir)
   *   - silme yalniz kendi uretigimiz ZZUP/ZZRB adli dosyalar ve (dogrulanamayan) kendi yeni dosyamiz icindir
   */
  async #pushOne(c, ftp, { machine, folder, item, by, clientIp, acks }) {
    const db = this.library.db;
    const program = db.getProgram(item.programId);
    const head = program ? db.latestVersion(program.id) : null;
    if (!program || !head) return this.#pushSkipRecord(machine, item, 'program kütüphanede bulunamadı', { by, clientIp, acks });
    if (head.versionNo !== item.versionNo) {
      return this.#pushSkipRecord(machine, item, `plan çıkarıldıktan sonra kütüphanede yeni sürüm oluştu (v${item.versionNo} → v${head.versionNo}); planı yenileyin`, { by, clientIp, acks });
    }
    const version = db.getVersion(program.id, head.versionNo);
    const content = version.content;
    const sha = head.sha256;
    const lname = program.name.toLowerCase();

    const transferId = db.startTransfer({
      kind: 'toplu', machineId: machine.id, programId: program.id, versionId: head.id, customer: item.customer, name: program.name,
      size: content.length, shaSent: sha, requestedBy: by, clientIp, acks,
    });
    const steps = [];
    const timed = stepRecorder(steps);
    const st = {
      temp: `${TEMP_PREFIX}${Math.floor(100000 + Math.random() * 900000)}`, rb: `${ROLLBACK_PREFIX}${Math.floor(100000 + Math.random() * 900000)}`,
      tempCreated: false, rbCreated: false, finalPlaced: false, orig: null, final: null, backup: null, warning: null,
    };
    let status = 'basarisiz';
    let outcome = 'hata';
    let error = null;
    let shaVerified = null;
    let connectionLost = false;

    let hit = null;
    try {
      await timed('on-kontrol', async () => {
        const live = this.liveInfo(machine.id);
        if (live?.connected) {
          const runningNow = [live.program, live.mainProgram].filter(Boolean).map(baseName);
          if (runningNow.includes(lname)) {
            const e = new Error('torna şu an bu programı çalıştırıyor/seçili (üzerine yazılmaz)');
            e.rejected = true;
            throw e;
          }
        }
        const entries = parseList(await c.listRaw()).entries;
        const found = entries.find((e) => e.name.toLowerCase() === lname);
        if (found?.isDir) { const e = new Error(`hedefte "${found.name}" adlı bir klasör var`); e.rejected = true; throw e; }
        if (entries.some((e) => e.name.toLowerCase() === st.temp.toLowerCase() || e.name.toLowerCase() === st.rb.toLowerCase())) {
          throw new Error('geçici ad hedefte zaten var');
        }
        hit = found ?? null;
        return found ? `hedefte aynı adlı dosya var (${found.size} bayt)` : 'hedefte aynı adlı dosya yok';
      });

      if (hit && hit.size === content.length) {
        let same = false;
        await timed('ayni-mi', async () => {
          same = sha256(await c.retr(hit.name, { maxBytes: MAX_PROGRAM_BYTES })) === sha;
          return same ? 'içerik aynı' : 'içerik farklı';
        });
        if (same) {
          outcome = 'ayni';
          status = 'basarili';
          shaVerified = sha;
          db.upsertInventory(machine.id, { customer: folder, name: hit.name, size: content.length, sha256: sha });
          steps.push({ step: 'sonuc', ok: true, ms: 0, detail: 'tornada zaten aynı içerik; yazılmadı' });
        }
      }

      if (outcome !== 'ayni') {
        await timed('yukle', async () => { st.tempCreated = true; await c.stor(st.temp, content); return `${st.temp} (${content.length} bayt, ikili)`; });
        await timed('boyut-dogrula', async () => {
          const l = parseList(await c.listRaw()).entries.find((e) => e.name.toLowerCase() === st.temp.toLowerCase());
          if (!l) throw new Error('yüklenen geçici dosya listede görünmüyor');
          if (l.size !== content.length) throw new Error(`boyut tutmuyor: tezgahta ${l.size}, gönderilen ${content.length}`);
          return `${l.size} bayt`;
        });
        await timed('geri-oku-sha', async () => {
          if (sha256(await c.retr(st.temp, { maxBytes: MAX_PROGRAM_BYTES })) !== sha) throw new Error('SHA-256 tutmuyor (iletimde içerik bozuldu)');
          return sha;
        });

        let finalName = program.name;
        if (hit) {
          // ESKI HALI YAN ADA AL: bundan sonra asil ad bos; eski dosya bizim elimizde (yarisa karsi atomik "al").
          finalName = hit.name;
          st.orig = hit.name;
          await timed('yedek', async () => {
            st.rbCreated = true; // rename'den ONCE: yanit kaybolsa bile geri alma yan adi arar
            await c.rename(hit.name, st.rb);
            const old = await c.retr(st.rb, { maxBytes: MAX_PROGRAM_BYTES });
            const oldSha = sha256(old);
            const versions = db.listVersions(program.id);
            const inLib = versions.find((v) => v.sha256 === oldSha);
            if (inLib) {
              st.backup = { kind: 'surum', versionNo: inLib.versionNo };
              return `tornadaki hal kütüphanede v${inLib.versionNo} olarak var; ayrıca yedek gerekmedi`;
            }
            const b = db.addBackup({ customer: item.customer, name: program.name, machineId: machine.id, content: old, sha256: oldSha, createdBy: by, transferId });
            st.backup = { kind: 'yedek', id: b.id, created: b.created, size: old.length };
            return `yedek #${b.id} (${old.length} bayt)${b.created ? '' : ' (aynı içerik daha önce yedeklenmişti)'}`;
          });
        }
        await timed('nihai-ada-cevir', async () => {
          const now = parseList(await c.listRaw()).entries;
          if (now.some((e) => e.name.toLowerCase() === finalName.toLowerCase())) throw new Error('bu arada hedefte aynı adlı bir dosya oluştu; ezilmedi');
          st.final = finalName;
          await c.rename(st.temp, finalName);
          st.finalPlaced = true;
          st.tempCreated = false;
          return `${st.temp} → ${finalName}`;
        });
        shaVerified = await timed('son-dogrulama', async () => {
          const l = parseList(await c.listRaw()).entries;
          const fin = l.find((e) => e.name.toLowerCase() === finalName.toLowerCase());
          if (!fin) throw new Error('nihai dosya listede görünmüyor');
          if (l.some((e) => e.name.toLowerCase() === st.temp.toLowerCase())) throw new Error('geçici dosya hâlâ duruyor');
          if (sha256(await c.retr(fin.name, { maxBytes: MAX_PROGRAM_BYTES })) !== sha) throw new Error('nihai dosyanın SHA-256 değeri tutmuyor');
          return sha;
        });
        if (hit) {
          // Dogrulama tamam: yan adli eski dosya artik gereksiz (yedegi kutuphanede). Silinemezse KALIR ve raporlanir.
          const t0 = Date.now();
          try {
            if (!/^ZZRB\d{6}$/.test(st.rb)) throw new Error('beklenmeyen yan ad');
            await c.dele(st.rb);
            if (parseList(await c.listRaw()).entries.some((e) => e.name.toLowerCase() === st.rb.toLowerCase())) throw new Error('silindi denildi ama dosya duruyor');
            st.rbCreated = false;
            steps.push({ step: 'yedek-temizle', ok: true, ms: Date.now() - t0, detail: `${st.rb} silindi` });
          } catch (err) {
            st.warning = `yan adlı eski dosya silinemedi: ${st.rb} (${err.message}); içeriği kütüphanede yedekli, elle silinebilir`;
            steps.push({ step: 'yedek-temizle', ok: false, ms: Date.now() - t0, detail: st.warning });
          }
        }
        outcome = hit ? 'ezildi' : 'yeni';
        status = 'basarili';
        db.upsertInventory(machine.id, { customer: folder, name: finalName, size: content.length, sha256: sha });
      }
    } catch (err) {
      error = err.message;
      connectionLost = !!c.closedError;
      if (err.rejected) { status = 'reddedildi'; outcome = 'atlandi'; }
      else { status = 'basarisiz'; outcome = 'hata'; }
      // Geri al: yeni oturumla (baglanti kopmus olabilir): gecici dosyayi sil, yan adli eski hali asil adina koy.
      if (st.tempCreated || st.rbCreated || st.finalPlaced) {
        const t0 = Date.now();
        try {
          const detail = await this.#rollbackPush(ftp, folder, st);
          steps.push({ step: 'geri-al', ok: true, ms: Date.now() - t0, detail });
        } catch (rbErr) {
          steps.push({ step: 'geri-al', ok: false, ms: Date.now() - t0, detail: rbErr.message });
          status = 'dogrulanamadi';
          error = `${error} — GERİ ALMA BAŞARISIZ: ${rbErr.message}${st.rbCreated ? ` · eski hâl tornada ${folder}\\${st.rb} adıyla durmalı (içeriği kütüphanede yedekli)` : ''}`;
        }
      }
    }

    db.finishTransfer(transferId, { status, shaVerified, error, steps });
    return {
      outcome, status, transferId, connectionLost,
      detail: error ?? (outcome === 'ayni' ? 'tornada zaten aynı içerik' : null),
      backup: st.backup, warning: st.warning,
    };
  }

  /** Basarisiz yazmayi geri alir (yeni FTP oturumuyla): gecici dosyayi siler, yan adli eski hali asil adina koyar. */
  async #rollbackPush(ftp, folder, st) {
    return withFtp(ftp, async (c) => {
      if (folder) await c.cwd(folder);
      const list = async () => parseList(await c.listRaw()).entries;
      const find = (entries, n) => entries.find((e) => e.name.toLowerCase() === String(n).toLowerCase());
      const notes = [];
      let entries = await list();
      if (st.finalPlaced && !st.rbCreated && st.final && find(entries, st.final)) {
        // Yeni program (tornada eskisi yoktu): bizim yazdigimiz ama dogrulanamayan dosya
        await c.dele(st.final);
        notes.push('yeni (doğrulanamayan) dosya silindi');
        entries = await list();
      }
      if (st.tempCreated && find(entries, st.temp)) {
        if (!/^ZZUP\d{6}$/.test(st.temp)) throw new Error('beklenmeyen geçici ad');
        await c.dele(st.temp);
        notes.push('geçici dosya silindi');
      }
      if (st.rbCreated && find(entries, st.rb)) {
        entries = await list();
        if (find(entries, st.orig)) {
          // Asil adda bizim yerlestirdigimiz (dogrulanamayan) yeni dosya var: sil, sonra eskiyi geri koy.
          if (!st.finalPlaced) throw new Error(`"${st.orig}" adı beklenmedik şekilde dolu; eski hal ${st.rb} adıyla duruyor (elle kontrol edin)`);
          await c.dele(st.orig);
          notes.push('yeni (doğrulanamayan) dosya silindi');
        }
        await c.rename(st.rb, st.orig);
        entries = await list();
        if (!find(entries, st.orig)) throw new Error(`eski hal geri konulamadı; ${st.rb} adıyla duruyor (elle kontrol edin)`);
        notes.push(`eski hal geri konuldu (${st.rb} → ${st.orig})`);
      } else if (st.rbCreated) {
        notes.push(`yan adlı dosya (${st.rb}) listede yok; ${find(entries, st.orig) ? 'asıl ad yerinde' : 'ASIL AD DE YOK: elle kontrol edin'}`);
        if (!find(entries, st.orig)) throw new Error(`"${st.orig}" ve ${st.rb} tornada görünmüyor; elle kontrol edin`);
      }
      return notes.join('; ') || 'geri alınacak bir şey yoktu';
    });
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
