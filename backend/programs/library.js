/**
 * Program kutuphanesi: dogrulama kurallari, karsilastirma mantigi ve onizleme.
 *
 * ICERIGI YORUMLAMAYIZ. NC programi programci tarafindan hazirlanir, surukle-birak
 * ile yuklenir ve tezgaha AYNEN tasinir (Syntec'e ozgu sozdizimi: $1/$2 kanallari,
 * G4.1 senkron noktalari, `//` yorumlari, alt program cagrilari... hicbirine
 * dokunulmaz). Kimlik (musteri, ad) ve icerik SHA-256'dir.
 *
 * Karsilastirma durumlari (planin Bolum 05 tablosu):
 *   guncel           tezgahtaki dosya kutuphanedeki EN SON surumle ayni
 *   eski             kutuphanede var ama daha eski bir surum (surum no verilir)
 *   farkli           ayni (musteri, ad), kutuphanedeki HICBIR surumle tutmuyor  <- en tehlikelisi
 *   kutuphanede-yok  tezgahta var, kutuphanede hic yok -> iceri alinabilir
 *   tezgahta-yok     kutuphanede var, bu tezgahta yok (matriste)
 *   belirsiz         ad ve boyut tutuyor ama SHA henuz hesaplanmadi
 */
import { createHash } from 'node:crypto';
import { LibraryDb } from './library-db.js';

export const MAX_PROGRAM_BYTES = 1_000_000;
/** Aktarim sirasinda kullanilan gecici ad oneki; kullanici bu adla program yukleyemez. */
export const TEMP_PREFIX = 'ZZUP';
/** Kok dizinde program olmayan sistem dosyalari: envanterden ve karsilastirmadan haric. */
const SYSTEM_ROOT_FILES = new Set(['mdiblock']);

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const FORBIDDEN_FOLDER_CHARS = /[\\/:*?"<>|\0-\x1f]/;

/** @returns {string} temiz ad; gecersizse ValidationError */
export function validateProgramName(raw) {
  const name = String(raw ?? '').trim();
  if (!NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw new ValidationError(
      `Program adı geçersiz: "${name}". Harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).`,
    );
  }
  if (name.toUpperCase().startsWith(TEMP_PREFIX) || name.toUpperCase().startsWith('ZZRB')) {
    throw new ValidationError(`"${TEMP_PREFIX}" ve "ZZRB" ile başlayan adlar aktarım için ayrılmıştır.`);
  }
  return name;
}

/** Musteri klasoru: '' = kok (musterisiz). Yol ayiraci ve kontrol karakteri yok. */
export function validateCustomer(raw) {
  const customer = String(raw ?? '');
  if (customer === '') return '';
  if (
    customer !== customer.trim() ||
    customer.length > 64 ||
    customer === '.' ||
    customer === '..' ||
    FORBIDDEN_FOLDER_CHARS.test(customer)
  ) {
    throw new ValidationError(`Müşteri klasörü adı geçersiz: "${customer}".`);
  }
  return customer;
}

/** NC programi metin dosyasidir: bos, buyuk ya da ikili (NUL iceren) dosya reddedilir. */
export function validateContent(content) {
  if (!Buffer.isBuffer(content) || content.length === 0) throw new ValidationError('Dosya boş.');
  if (content.length > MAX_PROGRAM_BYTES) {
    throw new ValidationError(
      `Dosya çok büyük (${content.length} bayt). En fazla ${MAX_PROGRAM_BYTES} bayt kabul edilir.`,
      413,
    );
  }
  if (content.includes(0)) {
    throw new ValidationError('Dosya ikili görünüyor (NUL bayt içeriyor); NC programı metin dosyası olmalı.');
  }
}

export const isSystemEntry = (customer, name) => customer === '' && SYSTEM_ROOT_FILES.has(name.toLowerCase());
const keyOf = (customer, name) => `${customer.toLowerCase()}\u0000${name.toLowerCase()}`;

/** Satir sonu bilgisi: tezgaha gidecek icerigin nasil oldugunu gostermek icin. */
function lineEnding(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return 'yok';
  if (crlf > 0 && lf === 0) return 'CRLF';
  if (lf > 0 && crlf === 0) return 'LF';
  return 'karışık';
}

/**
 * Tezgahtaki bir dosyanin kutuphane karsiligina gore durumu.
 * @param {{size:number|null, sha256:string|null}} entry
 * @param {{versionNo:number, sha256:string, size:number}[]} versions
 */
export function compareEntry(entry, versions) {
  if (!versions || versions.length === 0) return { status: 'kutuphanede-yok' };
  const latest = Math.max(...versions.map((v) => v.versionNo));
  if (entry.sha256) {
    const hit = versions.find((v) => v.sha256 === entry.sha256);
    if (!hit) return { status: 'farkli', latestVersion: latest };
    return hit.versionNo === latest
      ? { status: 'guncel', versionNo: latest, latestVersion: latest }
      : { status: 'eski', versionNo: hit.versionNo, latestVersion: latest };
  }
  // SHA yok: boyut hicbir surumle tutmuyorsa ICERIK KESIN farklidir (indirmeye gerek yok).
  if (!versions.some((v) => v.size === entry.size)) return { status: 'farkli', latestVersion: latest };
  return { status: 'belirsiz', latestVersion: latest };
}

export class Library {
  /** @param {string} dbFile */
  constructor(dbFile) {
    this.db = new LibraryDb(dbFile);
  }

  /** Surukle-birak yuklemesi. Ayni icerik zaten en son surumse yeni surum acilmaz. */
  addUpload({ customer, name, content, note = null, createdBy = null, originalName = null }) {
    return this.#add({ customer, name, content, note, createdBy, originalName, source: 'yukleme' });
  }

  /** Tezgahtan iceri alma (taramada gorulen ve kutuphanede olmayan program). */
  addFromMachine({ machineId, customer, name, content, createdBy = null }) {
    return this.#add({ customer, name, content, note: null, createdBy, originalName: null, source: 'tezgah-tarama', sourceMachine: machineId });
  }

  #add({ customer, name, content, note, createdBy, originalName, source, sourceMachine = null }) {
    const cleanCustomer = validateCustomer(customer);
    const cleanName = validateProgramName(name);
    validateContent(content);
    return this.db.addVersion({
      customer: cleanCustomer,
      name: cleanName,
      content,
      sha256: sha256(content),
      source,
      sourceMachine,
      originalName,
      note: note ? String(note).slice(0, 200) : null,
      createdBy: createdBy ? String(createdBy).slice(0, 40) : null,
    });
  }

  /** Onizleme: ilk `maxChars` karakter. Kodlamayi DEGISTIRMEZ (yalniz gosterim). */
  preview(programId, versionNo, maxChars = 20_000) {
    const v = this.db.getVersion(programId, versionNo);
    if (!v) return null;
    let text;
    let encoding = 'utf-8';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(v.content);
    } catch {
      text = v.content.toString('latin1');
      encoding = 'latin1 (UTF-8 değil)';
    }
    const truncated = text.length > maxChars;
    return {
      meta: v.meta,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      encoding,
      lineEnding: lineEnding(text),
      lines: text.split('\n').length,
    };
  }

  /** (musteri, ad) -> surumler dizini; karsilastirma icin. */
  #versionIndex() {
    const idx = new Map();
    for (const r of this.db.allVersionsIndex()) {
      const k = keyOf(r.customer, r.name);
      if (!idx.has(k)) idx.set(k, { programId: r.program_id, versions: [] });
      idx.get(k).versions.push({ versionNo: r.version_no, sha256: r.sha256, size: r.size });
    }
    return idx;
  }

  /**
   * Taramada indirilip SHA'si hesaplanmasi gereken dosyalar: kutuphanede ayni
   * (musteri, ad) var ve boyut en az bir surumle tutuyor. Boyutu hicbir surumle
   * tutmayan dosya zaten kesin "farkli"; kutuphanede olmayan indirilmez.
   */
  hashCandidates(entries) {
    const idx = this.#versionIndex();
    return entries.filter((e) => {
      if (e.sha256 || e.size == null || isSystemEntry(e.customer, e.name)) return false;
      const hit = idx.get(keyOf(e.customer, e.name));
      return !!hit && hit.versions.some((v) => v.size === e.size);
    });
  }

  /** Bir tezgahin envanteri + her dosyanin kutuphaneye gore durumu. */
  compareMachine(machineId) {
    const idx = this.#versionIndex();
    const scan = this.db.getScan(machineId);
    const inventory = this.db.getInventory(machineId);
    const onMachine = new Set();
    const entries = inventory.map((e) => {
      onMachine.add(keyOf(e.customer, e.name));
      const system = isSystemEntry(e.customer, e.name);
      const hit = idx.get(keyOf(e.customer, e.name));
      return {
        ...e,
        system,
        programId: hit?.programId ?? null,
        ...(system ? { status: 'sistem' } : compareEntry(e, hit?.versions)),
      };
    });
    const missing = this.db.listPrograms()
      .filter((p) => !onMachine.has(keyOf(p.customer, p.name)))
      .map((p) => ({ programId: p.id, customer: p.customer, name: p.name, latestVersion: p.latest.versionNo, size: p.latest.size }));
    const counts = {};
    for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    return { machineId, scan, folders: this.db.getFolders(machineId), entries, missing, counts };
  }

  /** Program x tezgah dagilim matrisi (son taramalara gore). */
  matrix(machines) {
    const idx = this.#versionIndex();
    const scans = new Map(this.db.allScans().map((s) => [s.machineId, s]));
    const inv = new Map(machines.map((m) => [m.id, new Map(this.db.getInventory(m.id).map((e) => [keyOf(e.customer, e.name), e]))]));
    const rows = this.db.listPrograms().map((p) => {
      const versions = idx.get(keyOf(p.customer, p.name))?.versions ?? [];
      const cells = {};
      for (const m of machines) {
        if (!scans.has(m.id) || scans.get(m.id).entries == null) { cells[m.id] = { status: 'taranmadi' }; continue; }
        const entry = inv.get(m.id).get(keyOf(p.customer, p.name));
        cells[m.id] = entry ? compareEntry(entry, versions) : { status: 'tezgahta-yok' };
      }
      return { programId: p.id, customer: p.customer, name: p.name, latestVersion: p.latest.versionNo, cells };
    });
    return {
      machines: machines.map((m) => ({ id: m.id, name: m.name, scannedAt: scans.get(m.id)?.finishedAt ?? null, scanStatus: scans.get(m.id)?.status ?? null })),
      rows,
    };
  }

  /** Yukleme ekranindaki musteri secenekleri: kutuphanede ve tezgahlarda gorulenlerin birlesimi. */
  customers() {
    const all = new Set([...this.db.customers(), ...this.db.inventoryCustomers()]);
    return [...all].filter((c) => c !== '').sort((a, b) => a.localeCompare(b, 'tr'));
  }

  close() {
    this.db.close();
  }
}
