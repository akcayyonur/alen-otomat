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

/**
 * Tezgahta YENI acilacak musteri klasoru adi. Mevcut klasor adlari (validateCustomer) serbesttir ama
 * yeni ad dar tutulur: yalniz ASCII harf/rakam/`_`/`-`/`.`. Turkce karakterler yok: tornanin Windows CE FTP
 * sunucusuna komut metni gider ve CE'nin kod sayfasi dogrulanmadi (yanlis bayt = baska adli klasor).
 */
const NEW_FOLDER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** @returns {string} temiz klasor adi; gecersizse ValidationError */
export function validateNewFolderName(raw) {
  const name = String(raw ?? '').trim();
  if (!NEW_FOLDER_PATTERN.test(name) || name.endsWith('.')) {
    throw new ValidationError(
      `Klasör adı geçersiz: "${name}". Yalnızca İngilizce harf, rakam, "_", "-" ve "." kullanılabilir ` +
      '(en fazla 40 karakter, harf/rakam/"_" ile başlamalı, "." ile bitemez). Türkçe karakter kullanmayın (ör. Ş yerine S).',
    );
  }
  if (WINDOWS_RESERVED.test(name)) {
    throw new ValidationError(`"${name}" Windows'un ayrılmış bir adıdır; başka bir ad seçin.`);
  }
  const upper = name.toUpperCase();
  if (upper.startsWith(TEMP_PREFIX) || upper.startsWith('ZZRB')) {
    throw new ValidationError(`"${TEMP_PREFIX}" ve "ZZRB" ile başlayan adlar aktarım için ayrılmıştır.`);
  }
  return name;
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

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Satir sonlarini LF'e indirger (karsilastirma icin). */
export const eolFlatten = (text) => text.replace(/\r\n?/g, '\n');

/**
 * Dosya baytlarini metne cevirir. UTF-8 degilse latin1 (bayt = karakter: bilgi kaybi YOK).
 * UTF-8 BOM'u metne GIRMEZ ama `bom` olarak dondurulur; editor kaydederken geri koyar, yoksa
 * kullanicinin dokunmadigi dosyanin ilk baytlari degisirdi.
 * @returns {{text: string, encoding: 'utf-8'|'latin1', bom: boolean, lineEnding: string}}
 */
export function decodeText(buf) {
  const bom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM);
  let text;
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    text = buf.toString('latin1');
    encoding = 'latin1';
  }
  return { text, encoding, bom: encoding === 'utf-8' && bom, lineEnding: lineEnding(text) };
}

/**
 * Editorden gelen metni dosya baytlarina cevirir. Satir sonlari TEK bicime cevrilir (editor metni
 * zaten LF'e indirger); kodlama latin1 secilip karakter 255'i asarsa SESSIZCE bozulmaz, reddedilir.
 * Icerik yorumlanmaz: yalnizca satir sonu, kodlama ve BOM.
 */
export function encodeText(text, { lineEnding: ending = 'CRLF', encoding = 'utf-8', bom = false } = {}) {
  if (typeof text !== 'string') throw new ValidationError('Program metni yok.');
  if (ending !== 'CRLF' && ending !== 'LF') throw new ValidationError(`Satır sonu geçersiz: "${ending}" (CRLF ya da LF).`);
  if (encoding !== 'utf-8' && encoding !== 'latin1') throw new ValidationError(`Kodlama geçersiz: "${encoding}" (utf-8 ya da latin1).`);
  const lf = text.replace(/\r\n?/g, '\n');
  const unified = ending === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf;
  if (encoding === 'latin1') {
    const bad = /[^\u0000-ÿ]/.exec(lf);
    if (bad) {
      const line = lf.slice(0, bad.index).split('\n').length;
      throw new ValidationError(
        `Satır ${line}: "${bad[0]}" karakteri Latin-1 kodlamasında yok. Karakteri değiştirin ya da kodlamayı UTF-8 seçin.`,
      );
    }
    return Buffer.from(unified, 'latin1');
  }
  const body = Buffer.from(unified, 'utf8');
  return bom ? Buffer.concat([BOM, body]) : body;
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

  /** Tezgahtan iceri alma (taramada gorulen ve kutuphanede olmayan program; toplu alimda `note` yazilir). */
  addFromMachine({ machineId, customer, name, content, createdBy = null, note = null }) {
    return this.#add({ customer, name, content, note, createdBy, originalName: null, source: 'tezgah-tarama', sourceMachine: machineId });
  }

  /**
   * Tezgahtan okunan bir dosya kutuphaneye gore ne durumda? (toplu iceri alma plani)
   *   yeni      kutuphanede (musteri, ad) yok
   *   ayni      icerigi (SHA-256) bir surumle ayni: alinacak bir sey yok
   *   cakisma   AYNI AD, hicbir surumle tutmayan icerik. `eolOnlyVersion`: icerik yalniz satir sonu (CRLF/LF)
   *             farkiyla o surume esitse onun numarasi (cogu "cakisma" boyle cikar).
   */
  classifyIncoming({ customer, name, sha256: sha, content }) {
    const program = this.db.findProgram(customer, name);
    if (!program) return { kind: 'yeni' };
    const versions = this.db.listVersions(program.id); // yeniden eskiye
    const latest = versions[0];
    const hit = versions.find((v) => v.sha256 === sha);
    if (hit) return { kind: 'ayni', programId: program.id, versionNo: hit.versionNo, latestVersion: latest.versionNo };
    const incoming = eolFlatten(decodeText(content).text);
    let eolOnlyVersion = null;
    for (const v of versions) {
      const stored = this.db.getVersion(program.id, v.versionNo);
      if (stored && eolFlatten(decodeText(stored.content).text) === incoming) { eolOnlyVersion = v.versionNo; break; }
    }
    return {
      kind: 'cakisma',
      programId: program.id,
      latest: { versionNo: latest.versionNo, size: latest.size, createdAt: latest.createdAt, sha256: latest.sha256 },
      eolOnlyVersion,
    };
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

  /**
   * Editorde yazilan metni kutuphaneye kaydeder.
   *   - programId verilirse: o programin YENI SURUMU (musteri/ad degismez). `baseVersionNo`, editorun
   *     actigi surumdur; bu arada daha yeni surum olustuysa 409 (`acceptNewer` ile asilir).
   *   - verilmezse: YENI program. (musteri, ad) kutuphanede zaten varsa 409: yanlislikla baska
   *     programin surumu olmasin.
   * Ayni icerik en son surumle ayniysa yeni surum acilmaz (created: false).
   */
  saveText({
    programId = null, baseVersionNo = null, customer = '', name, text, lineEnding: ending = 'CRLF',
    encoding = 'utf-8', bom = false, note = null, createdBy = null, acceptNewer = false,
  }) {
    let target;
    if (programId != null) {
      const program = this.db.getProgram(Number(programId));
      if (!program) throw new ValidationError('Program kütüphanede bulunamadı.', 404);
      const latest = this.db.latestVersion(program.id);
      if (baseVersionNo == null || !this.db.getVersion(program.id, Number(baseVersionNo))) {
        throw new ValidationError(`Düzenlenen sürüm bulunamadı: v${baseVersionNo}.`, 404);
      }
      if (latest.versionNo !== Number(baseVersionNo) && !acceptNewer) {
        const err = new ValidationError(
          `Bu program siz düzenlerken değişmiş: son sürüm v${latest.versionNo}, siz v${baseVersionNo} üzerinde çalışıyorsunuz. ` +
          `Yine de kaydederseniz v${latest.versionNo + 1} olarak eklenir; v${latest.versionNo}'deki değişiklikler bu sürüme taşınmaz.`,
          409,
        );
        err.code = 'newer-version';
        throw err;
      }
      target = { customer: program.customer, name: program.name };
    } else {
      target = { customer: validateCustomer(customer), name: validateProgramName(name) };
      const exists = this.db.findProgram(target.customer, target.name);
      if (exists) {
        const err = new ValidationError(
          `"${target.customer === '' ? '' : `${target.customer}\\`}${target.name}" kütüphanede zaten var. ` +
          'Var olan programı değiştirmek için programı açıp "Düzenle"yi kullanın; yeni program için başka bir ad seçin.',
          409,
        );
        err.code = 'exists';
        throw err;
      }
    }
    const content = encodeText(text, { lineEnding: ending, encoding, bom });
    const result = this.#add({
      ...target, content, note, createdBy, originalName: null, source: 'editor',
    });
    return result;
  }

  /**
   * Onizleme: ilk `maxChars` karakter (editor `Infinity` ile TAM metni ister: kesik metinle
   * kaydetmek icerigi sessizce kisaltirdi). Kodlamayi DEGISTIRMEZ (yalniz gosterim).
   */
  preview(programId, versionNo, maxChars = 20_000) {
    const v = this.db.getVersion(programId, versionNo);
    if (!v) return null;
    const { text, encoding, bom, lineEnding: ending } = decodeText(v.content);
    const truncated = text.length > maxChars;
    // roundTrip: editor bu metni (tek tip satir sonuyla) kaydederse dosya BAYT BAYT ayni cikar mi?
    // Karisik/tekil CR satir sonlarinda hayir: editor onlari tek tipe cevirir, kullanici bilmeli.
    let roundTrip = false;
    if (!truncated) {
      try {
        roundTrip = encodeText(text, { lineEnding: ending === 'LF' ? 'LF' : 'CRLF', encoding, bom }).equals(v.content);
      } catch { /* kodlanamadi: ayni cikmaz */ }
    }
    return {
      meta: v.meta,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      encoding: encoding === 'utf-8' ? 'utf-8' : 'latin1 (UTF-8 değil)',
      encodingId: encoding,
      bom,
      lineEnding: ending,
      roundTrip,
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
