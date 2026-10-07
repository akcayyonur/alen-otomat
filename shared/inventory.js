import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDrivers, getDriver, resolveModel, FALLBACK_DRIVER } from './drivers.js';

/**
 * Makine envanteri (CNC-TLM-001 Bolum 03A). Saha bilgisi netlestikce
 * guncellenecek TEK yer burasi - simulator de backend de bunu okur.
 *
 * Filo tek tip oldugu icin ortak alanlar `defaults` altinda tutulur; her tezgah
 * yalnizca kendi kimligini (id, ad, seri no, IP) tasir ve gerekirse defaults'u ezer.
 *
 * Hangi alanlarin okunabildigi SURUCUDEN gelir (bkz. shared/drivers.js), tezgah
 * tanimindan degil: ayni protokol ayni alanlari verir. Bir tezgah istisnaysa
 * kendi `reports` listesini yazarak ezebilir.
 */
const CONFIG_URL = new URL('../config/machines.json', import.meta.url);
/**
 * `MACHINES_FILE` ortam degiskeni baska bir envanter dosyasi gosterir (demo ve
 * testler icin: gercek config/machines.json'a dokunmadan). Ayarlar ekrani da
 * ayni dosyaya yazar.
 */
const CONFIG_PATH = process.env.MACHINES_FILE
  ? resolve(process.env.MACHINES_FILE)
  : fileURLToPath(CONFIG_URL);

/** `_` ile baslayan alanlar dosya ici aciklamalar - koda tasinmaz. */
function stripNotes(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !key.startsWith('_')));
}

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function loadInventory() {
  const { defaults = {}, machines } = readConfig();
  const shared = stripNotes(defaults);

  return machines.map((machine) => {
    const own = stripNotes(machine);
    const driver = getDriver(own.driverId ?? shared.driverId) ?? FALLBACK_DRIVER;

    // Kontrolcu modeli (11TB / 22TB): tezgah ya da defaults secmisse o, yoksa surucunun
    // varsayilani. Model YALNIZ acikca secildiyse kimlik alanlarini (kontrolcu adi,
    // panel, yazilim) doldurur; secilmediyse defaults aynen gecerli kalir.
    const chosen = own.controllerModel ?? shared.controllerModel ?? null;
    const model = resolveModel(driver, chosen);
    const fromModel = {};
    if (chosen && model?.id === chosen) {
      for (const key of ['controller', 'controllerPanel', 'softwareVersion']) {
        if (model[key] != null) fromModel[key] = model[key];
      }
    }

    const merged = { ...shared, ...fromModel, ...own };

    return {
      ...merged,
      driverId: driver.id,
      driverLabel: driver.label,
      driverStatus: driver.status,
      /** Cozumlenmis kontrolcu modeli ("11TB" / "22TB"); modeli olmayan surucuda null. */
      controllerModel: model?.id ?? null,
      controllerModelLabel: model?.label ?? null,
      /** Telemetri mesajlarindaki `source` - surucu kimligiyle ayni. */
      source: driver.id,
      /** Tezgah ozel bir liste yazmadiysa surucunun okuyabildigi alanlar. */
      reports: [...(merged.reports ?? driver.reads)],
    };
  });
}

/**
 * Edge Agent'in okuyacagi tezgahlar: IP'si tanimli olanlar, istenirse surucuye ve
 * kontrolcu modeline gore suzulmus.
 *
 * Model suzgecinin sebebi: her kontrolcu ailesi (11TB / 22TB) kendi Syntec istemci
 * paketini ister ve iki paket ayni surecte yuklenemez; bu yuzden her model icin ayri
 * bir ajan calisir ve yalniz KENDI modelindeki tezgahlari gormelidir. `model` verilmezse
 * (eski ajanlar) suzulmez.
 */
export function agentMachines(inventory, { driver = null, model = null } = {}) {
  return inventory.filter(
    (m) =>
      m.ip &&
      (driver == null || m.driverId === driver) &&
      (model == null || model === '' || m.controllerModel === model),
  );
}

/** Ayarlar ekrani icin ham yapi - cozumlenmemis haliyle. */
export function loadConfig() {
  const cfg = readConfig();
  return {
    defaults: stripNotes(cfg.defaults ?? {}),
    machines: cfg.machines.map((m) => stripNotes(m)),
  };
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Ayarlar ekranindan gelen tezgah listesini dogrular.
 * @returns {{ok: true, machines: object[]} | {ok: false, errors: string[]}}
 */
export function validateMachines(input) {
  const errors = [];
  if (!Array.isArray(input)) return { ok: false, errors: ['machines bir dizi olmali'] };
  if (input.length === 0) return { ok: false, errors: ['en az bir tezgah tanimli olmali'] };

  const selectable = new Set(loadDrivers().filter((d) => d.selectable).map((d) => d.id));
  const defaultDriverId = readConfig().defaults?.driverId ?? null;
  const seen = new Set();
  const machines = [];

  input.forEach((raw, i) => {
    const where = `tezgah ${i + 1}`;
    if (raw === null || typeof raw !== 'object') {
      errors.push(`${where}: nesne olmali`);
      return;
    }

    const id = String(raw.id ?? '').trim();
    if (!ID_PATTERN.test(id)) {
      errors.push(`${where}: id gecersiz "${id}" (harf, rakam, - ve _ ; en fazla 32 karakter)`);
    } else if (seen.has(id)) {
      errors.push(`${where}: id tekrar ediyor "${id}"`);
    }
    seen.add(id);

    const name = String(raw.name ?? '').trim();
    if (name === '') errors.push(`${where}: ad bos olamaz`);

    // driverId bos birakilirsa defaults devreye girer; yazildiysa gecerli olmali.
    const driverId = raw.driverId == null || raw.driverId === '' ? null : String(raw.driverId);
    if (driverId !== null && !selectable.has(driverId)) {
      const driver = getDriver(driverId);
      errors.push(
        driver
          ? `${where}: "${driver.label}" sürücüsü henüz seçilemez (durum: ${driver.status} — ajanı yazılmadı)`
          : `${where}: bilinmeyen sürücü "${driverId}"`,
      );
    }

    // Kontrolcu modeli (ornegin 11TB / 22TB): yalniz modeli olan surucuyle anlamli; bos =
    // surucunun varsayilan modeli. Gecersiz model sessizce yok sayilmaz: yanlis istemci
    // paketiyle konusan ajan o tezgahi hic okuyamazdi.
    const controllerModel =
      raw.controllerModel == null || raw.controllerModel === '' ? null : String(raw.controllerModel).trim();
    if (controllerModel !== null) {
      const effective = getDriver(driverId ?? defaultDriverId);
      const known = (effective?.models ?? []).map((m) => m.id);
      if (known.length === 0) {
        errors.push(`${where}: "${effective?.label ?? driverId ?? defaultDriverId}" sürücüsünde kontrolcü modeli seçimi yok`);
      } else if (!known.includes(controllerModel)) {
        errors.push(`${where}: kontrolcü modeli geçersiz "${controllerModel}" (olabilir: ${known.join(', ')})`);
      }
    }

    const ip = raw.ip == null || raw.ip === '' ? null : String(raw.ip).trim();
    if (ip !== null) {
      const octetsOk =
        IPV4_PATTERN.test(ip) && ip.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
      if (!octetsOk) errors.push(`${where}: IP gecersiz "${ip}"`);
    }

    let port = null;
    if (raw.port != null && raw.port !== '') {
      port = Number(raw.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`${where}: port gecersiz "${raw.port}"`);
      }
    }

    // Dosya aktarimi (FTP) portu: bos = surucunun varsayilani (21). Ileri duzey ayar.
    let ftpPort = null;
    if (raw.ftpPort != null && raw.ftpPort !== '') {
      ftpPort = Number(raw.ftpPort);
      if (!Number.isInteger(ftpPort) || ftpPort < 1 || ftpPort > 65535) {
        errors.push(`${where}: FTP portu gecersiz "${raw.ftpPort}"`);
      }
    }

    machines.push({
      id,
      name,
      ...(driverId === null ? {} : { driverId }),
      ...(controllerModel === null ? {} : { controllerModel }),
      ip,
      ...(port === null ? {} : { port }),
      ...(ftpPort === null ? {} : { ftpPort }),
      identified: raw.identified === true,
      ...(raw.cncSerial ? { cncSerial: String(raw.cncSerial) } : {}),
      ...(raw.machineSerial ? { machineSerial: String(raw.machineSerial) } : {}),
      ...(raw.year ? { year: Number(raw.year) } : {}),
      ...(raw.note ? { note: String(raw.note) } : {}),
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, machines };
}

/**
 * Tezgah listesini dosyaya yazar. Aciklama (`_`) alanlari ve `defaults`
 * korunur - ayarlar ekrani yalnizca tezgah listesini degistirir.
 *
 * Yazim atomik: once gecici dosyaya yazilip sonra yerine tasinir, boylece
 * yazarken kesilirse yapilandirma bozulmaz.
 */
export function saveMachines(machines) {
  const cfg = readConfig();
  cfg.machines = machines;
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, CONFIG_PATH);
}
