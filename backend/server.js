// ILK import olmali: store.js -> db.js -> node:sqlite zinciri baslamadan
// Node surumunu kontrol edip okunur bir hata verir.
import './preflight.js';
// `--log <dosya>` varsa console ciktisini dosyaya da yazar (servis olarak).
import './logger.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseTelemetry } from '../shared/schema.js';
import { loadDrivers } from '../shared/drivers.js';
import { loadDowntimeCodes } from '../shared/downtime-codes.js';
import { loadFeatures } from '../shared/features.js';
import { loadInventory, loadConfig, validateMachines, saveMachines, agentMachines } from '../shared/inventory.js';
import { TelemetryStore, SHIFT_WINDOW_MS } from './store.js';
import { Library } from './programs/library.js';
import { MachineFiles } from './programs/machine-files.js';
import { Planning } from './planning/planning.js';
import { createPlanningRoutes } from './planning/routes.js';
import { createProgramRoutes } from './programs/routes.js';
import { AuthDb } from './auth/auth-db.js';
import { Auth } from './auth/auth.js';
import { createGate, createAuthRoutes } from './auth/http.js';
import { redactSnapshot, redactDetail } from './auth/policy.js';
import { csvDocument } from './csv.js';
import { buildReport, buildRuns, reportCsv, runsCsv, compactMachineCsv, resolveRange } from './production-report.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_FILE = process.env.DB_FILE ?? 'data/telemetry.db';
/** Program kutuphanesi: telemetri veritabanindan AYRI dosya (budanmaz, ayri yedeklenir). */
const LIBRARY_DB_FILE = process.env.LIBRARY_DB_FILE ?? 'data/library.db';
/** Planlama (urun kartlari, siparisler, is emirleri): telemetri ve kutuphaneden AYRI dosya, ayri yedeklenir. */
const PLANNING_DB_FILE = process.env.PLANNING_DB_FILE ?? 'data/planlama.db';
/**
 * Tezgaha program GONDERMEYI tamamen kapatir (kutuphane, tarama ve on kontrol
 * calisir). Kimlik dogrulama henuz yok; ozelligi kullanmayacaksaniz 1 yapin.
 */
const TRANSFER_DISABLED = process.env.TRANSFER_DISABLED === '1';
/**
 * Tornadan program SILMEYI (FTP DELE) zorla acar. Normalde silme, modelin `fileTransfer.deleteEnabled` degeri
 * (config/drivers.json) gercek tezgahta dogrulaninca acilir. Bu bayrak YALNIZ o dogrulamayi yapmak icindir
 * (ornegin kendi gonderdigimiz bir test dosyasini silmek); gundelik kullanimda verilmez.
 */
const DELETE_ENABLED = process.env.DELETE_ENABLED === '1';
/** Tornadan silmeyi her durumda KAPATAN acil anahtar (yapilandirma dosyasi acik olsa bile). Silme geri donusuzdur. */
const DELETE_DISABLED = process.env.DELETE_DISABLED === '1';
/**
 * Ayarlar ekranindan yapilandirma yazimi. Kimlik dogrulama HENUZ YOK - ofis
 * agindaki herkes tezgah tanimlarini degistirebilir. Dashboard ofis LAN'i
 * disina acilacaksa bunu 1 yapip yazimi kapatin (Bolum 08).
 */
const CONFIG_READONLY = process.env.CONFIG_READONLY === '1';
/**
 * Kimlik dogrulama (admin / viewer): data/auth.db. AUTH_DISABLED=1 HER SEYI ACIK BIRAKIR (yalniz gelistirme/demo:
 * scripts/dev.js, demo*.js bunu kendisi verir); gercek kurulumda ASLA verilmez.
 */
const AUTH_DB_FILE = process.env.AUTH_DB_FILE ?? 'data/auth.db';
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
/** Acik SSE akislarinda oturumun hala gecerli oldugu bu kadar karede bir (1 sn x N) denetlenir. */
const SESSION_RECHECK_TICKS = 30;
/** Dashboard'a yayin sikligi - ingest hizindan bagimsiz (Bolum 07: < 2-5 sn). */
const BROADCAST_MS = 1000;
const MAX_BODY_BYTES = 1_000_000;
/**
 * /api/ingest icin AYRI, buyuk sinir: backend kapaliyken ajan mesajlari tamponlar (en fazla 20.000 mesaj, ~400-1000 bayt)
 * ve geri gelince HEPSINI tek istekte yollar. 1 MB sinir ~2.500 mesajda (birkac dakikalik kesinti) bu paketi reddeder,
 * ajan ayni paketi sonsuza dek yeniden dener ve veri kalici kaybolurdu. Ingest yalniz sunucu bilgisayarindan acilir (policy 'local').
 */
const MAX_INGEST_BYTES = 40_000_000;

const store = new TelemetryStore(DB_FILE);

// Program kutuphanesi ve tezgaha aktarim: telemetri yolundan AYRI (backend/programs/).
// Telemetri kodu bu modulleri kullanmaz; yazma yolu yalnizca /api/library, /api/transfers
// ve /api/machines/:id/programs altindadir.
const library = new Library(LIBRARY_DB_FILE);
const machineFiles = new MachineFiles({
  library,
  getMachine: (id) => loadInventory().find((m) => m.id === id) ?? null,
  liveInfo: (id) => store.liveInfo(id),
  flags: { transferDisabled: TRANSFER_DISABLED, deleteEnabled: DELETE_ENABLED, deleteDisabled: DELETE_DISABLED },
});
const programRoutes = createProgramRoutes({
  library, files: machineFiles, listMachines: () => loadInventory(), authRequired: !AUTH_DISABLED,
});

// Planlama modulu (urun karti, siparis, program eslemesi): telemetriyi import etmez; tornalarda gorulen program adlarini disaridan alir.
const planning = new Planning({
  dbFile: PLANNING_DB_FILE,
  listSeenPrograms: () => store.db.productionPrograms(),
  listMachines: () => loadInventory(), // is emrine atanabilecek tezgahlar
  productionEvents: (machineId, fromMs, toMs) => store.db.productionEvents(machineId, fromMs, toMs), // is emrinin gerceklesen adedi
  liveMachine: (machineId) => store.liveInfo(machineId), // canli durum/program/sayac (is emri baslat-bitir)
  spans: (machineId, fromMs, toMs) => store.db.spans(machineId, fromMs, toMs), // olculmus duruslar
  programRuns: (machineId, fromMs, toMs, now) => store.db.programRuns(machineId, fromMs, toMs, now), // tezgahin program araliklari (Tezgah basi: calisan program ne zamandir, kac parca)
  downtimeConfig: loadDowntimeCodes(), // duruş nedeni kodlari (config/downtime-codes.json)
  sourcesDir: process.env.SOURCES_DIR ?? join(dirname(resolve(PLANNING_DB_FILE)), 'kaynak'), // Mikro/GKK Excel dosyalarinin varsayilan klasoru (data/kaynak)
  drawingsDir: process.env.DRAWINGS_DIR ?? join(dirname(resolve(PLANNING_DB_FILE)), 'teknik-resim'), // teknik resim PDF'lerinin varsayilan klasoru (data/teknik-resim)
  stickersDir: process.env.STICKERS_DIR ?? join(dirname(resolve(PLANNING_DB_FILE)), 'etiket'), // kutu etiketi Word dosyalarinin varsayilan klasoru (data/etiket)
});
// Kurulumda kapali bolumler (config/features.json; FEATURES_FILE ile degistirilir): hatali dosya sunucuyu baslatmaz.
const features = loadFeatures(process.env.FEATURES_FILE);
const planningRoutes = createPlanningRoutes({ planning, closedSections: features.closedSections });

// Kimlik dogrulama: her istek once kapidan (gate) gecer; izin tablosu backend/auth/policy.js'te.
const authDb = new AuthDb(AUTH_DB_FILE);
const auth = new Auth({ db: authDb });
const gate = createGate({ auth, disabled: AUTH_DISABLED });
const authRoutes = createAuthRoutes({ auth, disabled: AUTH_DISABLED, sessionExtra: { closedSections: features.closedSections } });

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

/** Path traversal'a kapali olmasi icin acik liste. */
const STATIC_FILES = {
  '/': ['../dashboard/index.html', 'text/html; charset=utf-8'],
  // PWA: tablette "Ana ekrana ekle" ile adres cubugu olmadan acilsin diye (bkz. CLAUDE.md "Tablet dagitimi").
  '/manifest.json': ['../dashboard/manifest.json', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['../dashboard/icon-192.png', 'image/png'],
  '/icon-512.png': ['../dashboard/icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['../dashboard/icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['../dashboard/apple-touch-icon.png', 'image/png'],
  '/app.js': ['../dashboard/app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['../dashboard/charts.js', 'text/javascript; charset=utf-8'],
  '/config-view.js': ['../dashboard/config-view.js', 'text/javascript; charset=utf-8'],
  '/library-view.js': ['../dashboard/library-view.js', 'text/javascript; charset=utf-8'],
  '/lib-common.js': ['../dashboard/lib-common.js', 'text/javascript; charset=utf-8'],
  '/editor-view.js': ['../dashboard/editor-view.js', 'text/javascript; charset=utf-8'],
  '/folder-view.js': ['../dashboard/folder-view.js', 'text/javascript; charset=utf-8'],
  '/diff.js': ['../dashboard/diff.js', 'text/javascript; charset=utf-8'],
  '/bulk-import-view.js': ['../dashboard/bulk-import-view.js', 'text/javascript; charset=utf-8'],
  '/bulk-push-view.js': ['../dashboard/bulk-push-view.js', 'text/javascript; charset=utf-8'],
  '/delete-view.js': ['../dashboard/delete-view.js', 'text/javascript; charset=utf-8'],
  '/library-delete-view.js': ['../dashboard/library-delete-view.js', 'text/javascript; charset=utf-8'],
  '/library-rename-view.js': ['../dashboard/library-rename-view.js', 'text/javascript; charset=utf-8'],
  '/diff-render.js': ['../dashboard/diff-render.js', 'text/javascript; charset=utf-8'],
  '/auth-view.js': ['../dashboard/auth-view.js', 'text/javascript; charset=utf-8'],
  '/users-view.js': ['../dashboard/users-view.js', 'text/javascript; charset=utf-8'],
  '/production-view.js': ['../dashboard/production-view.js', 'text/javascript; charset=utf-8'],
  '/apps.js': ['../dashboard/apps.js', 'text/javascript; charset=utf-8'],
  '/planning-view.js': ['../dashboard/planning-view.js', 'text/javascript; charset=utf-8'],
  '/planning-common.js': ['../dashboard/planning-common.js', 'text/javascript; charset=utf-8'],
  '/planning-products.js': ['../dashboard/planning-products.js', 'text/javascript; charset=utf-8'],
  '/planning-orders.js': ['../dashboard/planning-orders.js', 'text/javascript; charset=utf-8'],
  '/planning-programs.js': ['../dashboard/planning-programs.js', 'text/javascript; charset=utf-8'],
  '/planning-workorders.js': ['../dashboard/planning-workorders.js', 'text/javascript; charset=utf-8'],
  '/planning-wo-form.js': ['../dashboard/planning-wo-form.js', 'text/javascript; charset=utf-8'],
  '/planning-production.js': ['../dashboard/planning-production.js', 'text/javascript; charset=utf-8'],
  '/planning-shop.js': ['../dashboard/planning-shop.js', 'text/javascript; charset=utf-8'],
  '/planning-card.js': ['../dashboard/planning-card.js', 'text/javascript; charset=utf-8'],
  '/planning-material.js': ['../dashboard/planning-material.js', 'text/javascript; charset=utf-8'],
  '/planning-efficiency.js': ['../dashboard/planning-efficiency.js', 'text/javascript; charset=utf-8'],
  '/planning-measure.js': ['../dashboard/planning-measure.js', 'text/javascript; charset=utf-8'],
  '/planning-packing.js': ['../dashboard/planning-packing.js', 'text/javascript; charset=utf-8'],
  '/planning-packing-form.js': ['../dashboard/planning-packing-form.js', 'text/javascript; charset=utf-8'],
  '/planning-docs.js': ['../dashboard/planning-docs.js', 'text/javascript; charset=utf-8'],
  '/planning-sources.js': ['../dashboard/planning-sources.js', 'text/javascript; charset=utf-8'],
  '/planning-gkk.js': ['../dashboard/planning-gkk.js', 'text/javascript; charset=utf-8'],
  '/planning-approvals.js': ['../dashboard/planning-approvals.js', 'text/javascript; charset=utf-8'],
  '/planning-drawings.js': ['../dashboard/planning-drawings.js', 'text/javascript; charset=utf-8'],
  '/planning-reports.js': ['../dashboard/planning-reports.js', 'text/javascript; charset=utf-8'],
  '/planning-tabs.js': ['../dashboard/planning-tabs.js', 'text/javascript; charset=utf-8'],
  '/format.js': ['../dashboard/format.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['../dashboard/styles.css', 'text/css; charset=utf-8'],
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('istek govdesi cok buyuk'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const WINDOW_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `?from=&to=` ya da `?window=8h` cozumler. Varsayilan: son bir vardiya.
 * from/to epoch ms ya da ISO tarih olabilir.
 */
function parseRange(url) {
  const now = Date.now();
  const asTime = (raw) => {
    if (raw == null || raw === '') return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  };

  const windowRaw = url.searchParams.get('window');
  if (windowRaw) {
    const m = /^(\d+)([mhd])$/.exec(windowRaw.trim());
    if (!m) return { error: `window gecersiz: ${windowRaw} (ornek: 30m, 8h, 7d)` };
    return { fromMs: now - Number(m[1]) * WINDOW_UNITS[m[2]], toMs: now };
  }

  const toMs = asTime(url.searchParams.get('to')) ?? now;
  const fromMs = asTime(url.searchParams.get('from')) ?? toMs - SHIFT_WINDOW_MS;
  if (fromMs >= toMs) return { error: 'from, to degerinden kucuk olmali' };
  return { fromMs, toMs };
}

async function handleIngest(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_INGEST_BYTES));
  } catch (err) {
    return sendJson(res, 400, { error: `govde okunamadi: ${err.message}` });
  }

  const batch = Array.isArray(payload) ? payload : [payload];
  const errors = [];
  let accepted = 0;
  let failed = 0;

  for (const raw of batch) {
    const parsed = parseTelemetry(raw);
    if (parsed.ok) {
      // Tek mesajin yazilamamasi (hata) paketin geri kalanini oldurmesin: ajan 500 alinca AYNI paketi sonsuza dek
      // yeniden gonderirdi ("zehirli mesaj"). Hatali mesaj reddedilir ve gunluge yazilir.
      try {
        store.ingest(parsed.value);
        accepted += 1;
      } catch (err) {
        failed += 1;
        store.rejectedCount += 1;
        console.error(`[backend] mesaj yazilamadi (${parsed.value?.machineId}):`, err);
        if (errors.length < 10) errors.push({ machineId: parsed.value?.machineId ?? null, errors: ['ic hata: mesaj yazilamadi'] });
      }
    } else {
      store.rejectedCount += 1;
      if (errors.length < 10) {
        errors.push({ machineId: raw?.machineId ?? null, errors: parsed.errors });
      }
    }
  }

  // Hicbir mesaj yazilamadiysa (veritabani sorunu) 500: ajan tamponunu SILMEZ, sonra yeniden dener.
  if (failed > 0 && accepted === 0) return sendJson(res, 500, { error: 'mesajlar yazilamadi', accepted, rejected: batch.length, errors });

  // Kismi kabul: gecerli mesajlar yazilir, gecersizler raporlanir.
  sendJson(res, errors.length > 0 ? 207 : 202, {
    accepted,
    rejected: batch.length - accepted,
    errors,
  });
}

function handleStream(req, res) {
  // Akisin sahibi: kare icerigi role gore suzulur (viewer tezgah IP'lerini gormez), oturum duzenli denetlenir.
  res.cncRole = req.user?.role ?? 'viewer';
  res.cncToken = req.session?.tokenHash ?? null;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotFor(res.cncRole))}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
}

/** Rolune gore anlik goruntu: admin her seyi, viewer IP/port gibi ic ag ayrintilari OLMADAN gorur. */
function snapshotFor(role, snapshot = store.snapshot()) {
  return role === 'admin' ? snapshot : redactSnapshot(snapshot);
}

let tick = 0;
function broadcast() {
  if (clients.size === 0) {
    // Istemci yoksa da sessizlige dusen tezgahlar NO_DATA olarak isaretlenmeli.
    store.sweep();
    return;
  }
  tick += 1;
  const snapshot = store.snapshot();
  const frames = new Map();
  const frameFor = (role) => {
    if (!frames.has(role)) frames.set(role, `event: snapshot\ndata: ${JSON.stringify(snapshotFor(role, snapshot))}\n\n`);
    return frames.get(role);
  };
  const recheck = !AUTH_DISABLED && tick % SESSION_RECHECK_TICKS === 0;
  for (const res of clients) {
    // Suresi dolan ya da kapatilan oturumun acik akisi kesilir (tarayici girise doner).
    if (recheck && res.cncToken && !auth.isValid(res.cncToken)) {
      clients.delete(res);
      res.end();
      continue;
    }
    // Yavas istemci baglantiyi tikamasin diye yazma hatasi sessizce dusurulur.
    res.write(frameFor(res.cncRole), (err) => {
      if (err) clients.delete(res);
    });
  }
}

/** Turkce Excel uyumlu CSV: UTF-8 BOM + sep=; + noktali virgul + ondalik virgul. */
const CSV_COLUMNS = Object.freeze([
  ['zaman', (r) => new Date(Number(r.ts)).toLocaleString('tr-TR')],
  ['durum', (r) => r.status],
  ['mod', (r) => r.mode],
  ['program', (r) => r.program],
  ['ana_program', (r) => r.main_program],
  ['satir_no', (r) => r.block_no],
  ['nc_satiri', (r) => r.block],
  ['mil_devri_rpm', (r) => r.spindle_rpm],
  ['ilerleme_mm_dk', (r) => r.feed_rate],
  ['mil_override_yuzde', (r) => r.spindle_ov],
  ['ilerleme_override_yuzde', (r) => r.feed_ov],
  ['parca', (r) => r.part_count],
  ['hedef_parca', (r) => r.part_target],
  ['toplam_parca', (r) => r.part_total],
  ['cevrim_sn', (r) => r.cycle_time],
  ['kesme_toplam_sn', (r) => r.cutting_time],
  ['guc_acik_sn', (r) => r.power_on_time],
  ['calisma_sn', (r) => r.work_time],
  ['durus_nedeni', (r) => r.downtime_reason],
  ['alarmlar', (r) => r.alarms],
  ['ham_degerler', (r) => r.controller],
]);

function sendCsv(res, filename, text) {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Tezgah dokumu. `format=ham`: kaydedilen HER ornek (eski bicim). Varsayilan `ozet`: arada gecen ayni-durum
 * satirlari atilir; yalniz uretilen parcalar ve durum/program/alarm degisimleri kalir (production-report.js).
 */
function handleExport(res, machineId, fromMs, toMs, format = 'ozet') {
  const stamp = new Date(fromMs).toISOString().slice(0, 10);
  if (format === 'ham') {
    const { rows } = store.db.samples(machineId, fromMs, toMs, 100_000);
    return sendCsv(res, `${machineId}-ham-${stamp}.csv`, csvDocument(
      CSV_COLUMNS.map(([name]) => name),
      rows.map((row) => CSV_COLUMNS.map(([, read]) => read(row))),
    ));
  }
  return sendCsv(res, `${machineId}-ozet-${stamp}.csv`, compactMachineCsv(store.db, machineId, fromMs, toMs));
}

/** GET /api/production[/export.csv]: vardiya x tezgah x program uretim adetleri (izleme verisi: viewer de gorur). */
function handleProduction(url, res, csv) {
  const range = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'));
  if (range.error) return sendJson(res, 400, { error: range.error });
  const machineId = url.searchParams.get('machine') || null;
  if (machineId && !store.has(machineId)) return sendJson(res, 404, { error: `tezgah bulunamadi: ${machineId}` });

  const report = buildReport({
    db: store.db,
    machines: store.listMachines(),
    machineId,
    ...range,
  });
  if (!csv) return sendJson(res, 200, report);

  const view = url.searchParams.get('view') ?? 'makine';
  if (!['makine', 'urun', 'gunluk'].includes(view)) return sendJson(res, 400, { error: `view gecersiz: ${view}` });
  const span = range.from === range.to ? range.from : `${range.from}_${range.to}`;
  return sendCsv(res, `uretim-${view}${machineId ? `-${machineId}` : ''}-${span}.csv`, reportCsv(report, view));
}

/** GET /api/production/runs[.csv]: program calisma araliklari (hangi program hangi saatte devreye girdi, ne zaman bitti). */
function handleProductionRuns(url, res, csv) {
  const range = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'));
  if (range.error) return sendJson(res, 400, { error: range.error });
  const machineId = url.searchParams.get('machine') || null;
  if (machineId && !store.has(machineId)) return sendJson(res, 404, { error: `tezgah bulunamadi: ${machineId}` });
  const report = buildRuns({ db: store.db, machineId, ...range });
  if (!csv) return sendJson(res, 200, report);
  const span = range.from === range.to ? range.from : `${range.from}_${range.to}`;
  return sendCsv(res, `program-gecisleri${machineId ? `-${machineId}` : ''}-${span}.csv`, runsCsv(report));
}

/**
 * Ayarlar ekranindan gelen tezgah listesini dogrular, yazar ve depoyu
 * yeniden yukler - sunucuyu yeniden baslatmaya gerek kalmaz.
 */
async function handleConfigWrite(req, res) {
  if (CONFIG_READONLY) {
    return sendJson(res, 403, {
      error: 'yapilandirma yazimi kapali (CONFIG_READONLY=1)',
    });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: `govde okunamadi: ${err.message}` });
  }

  const result = validateMachines(payload?.machines);
  if (!result.ok) return sendJson(res, 400, { errors: result.errors });

  saveMachines(result.machines);
  const count = store.reloadInventory();
  return sendJson(res, 200, { saved: result.machines.length, active: count });
}

const MACHINE_ROUTE = /^\/api\/machines\/([^/]+)(?:\/([a-z.]+))?$/;

function handleMachineRoute(url, res, idRaw, action, role = 'viewer') {
  const machineId = decodeURIComponent(idRaw);
  if (!store.has(machineId)) {
    return sendJson(res, 404, { error: `tezgah bulunamadi: ${machineId}` });
  }

  const range = parseRange(url);
  if (range.error) return sendJson(res, 400, { error: range.error });
  const { fromMs, toMs } = range;

  switch (action) {
    case undefined: {
      // Detay: anlik gorunum + bellek ici canli pencere + vardiya raporu.
      const snapshot = store.snapshot();
      const machine = snapshot.machines.find((m) => m.machineId === machineId);
      const detail = {
        machine,
        live: store.liveHistory(machineId).samples,
        summary: store.db.summary(machineId, fromMs, toMs),
        spans: store.db.spans(machineId, fromMs, toMs),
        downtimes: store.db.downtimes(machineId, fromMs, toMs),
      };
      return sendJson(res, 200, role === 'admin' ? detail : redactDetail(detail));
    }
    case 'history': {
      const maxPoints = Math.min(
        5000,
        Math.max(50, Number(url.searchParams.get('maxPoints')) || 1500),
      );
      const { total, step, rows } = store.db.samples(machineId, fromMs, toMs, maxPoints);
      return sendJson(res, 200, { machineId, fromMs, toMs, total, step, samples: rows });
    }
    case 'spans':
      return sendJson(res, 200, {
        machineId,
        fromMs,
        toMs,
        spans: store.db.spans(machineId, fromMs, toMs),
      });
    case 'summary':
      return sendJson(res, 200, store.db.summary(machineId, fromMs, toMs));
    case 'downtimes':
      return sendJson(res, 200, {
        machineId,
        fromMs,
        toMs,
        downtimes: store.db.downtimes(machineId, fromMs, toMs),
      });
    case 'export.csv':
      return handleExport(res, machineId, fromMs, toMs, url.searchParams.get('format') === 'ham' ? 'ham' : 'ozet');
    default:
      return sendJson(res, 404, { error: `bilinmeyen islem: ${action}` });
  }
}

async function serveStatic(pathname, res) {
  const hit = STATIC_FILES[pathname];
  if (!hit) return false;
  const [relative, type] = hit;
  const body = await readFile(fileURLToPath(new URL(relative, import.meta.url)));
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  // Tarayici korumasi: icerik turu tahmini, cerceveleme (clickjacking) ve Referer sizmasi kapali.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');

  try {
    // Kapi: oturum, rol, yerel-yalniz uclar, CSRF (policy.js). Reddedilirse yanit verilmistir.
    if (!(await gate(req, res, url))) return;
    // Giris / cikis / kullanici yonetimi.
    if (await authRoutes(req, res, url)) return;
    // Program kutuphanesi / aktarim uclari (kendi hata yanitlarini verir).
    if (await programRoutes(req, res, url)) return;
    // Planlama uclari (/api/planning/*): yalniz yonetici (izin tablosunda varsayilan reddet).
    if (await planningRoutes(req, res, url)) return;

    if (req.method === 'POST' && pathname === '/api/ingest') return await handleIngest(req, res);
    if (req.method === 'GET' && pathname === '/api/stream') return handleStream(req, res);
    if (req.method === 'GET' && pathname === '/api/machines') {
      return sendJson(res, 200, snapshotFor(req.user?.role));
    }
    if (req.method === 'GET' && pathname === '/api/drivers') {
      return sendJson(res, 200, { drivers: loadDrivers() });
    }
    // Edge Agent'in okuyacagi tezgah listesi. Ajan kendi dosyasini tutmaz;
    // tek gercek kaynak ayarlar ekraninin yazdigi config/machines.json.
    // `model` (11TB / 22TB): her kontrolcu ailesinin kendi ajan sureci vardir ve yalniz
    // kendi modelindeki tezgahlari alir. Verilmezse suzulmez (eski ajanlar).
    if (req.method === 'GET' && pathname === '/api/agent/machines') {
      const machines = agentMachines(loadInventory(), {
        driver: url.searchParams.get('driver'),
        model: url.searchParams.get('model'),
      }).map((m) => ({
        id: m.id,
        ip: m.ip,
        port: m.port ?? null,
        driverId: m.driverId,
        controllerModel: m.controllerModel ?? null,
      }));
      return sendJson(res, 200, { machines });
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      const cfg = loadConfig();
      return sendJson(res, 200, {
        ...cfg,
        drivers: loadDrivers(),
        readOnly: CONFIG_READONLY,
      });
    }
    if (req.method === 'PUT' && pathname === '/api/config/machines') {
      return await handleConfigWrite(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      // Giris yapmamis (ve yonetici olmayan) istemci yalniz "ayakta" bilgisini gorur.
      if (req.user?.role !== 'admin') return sendJson(res, 200, { ok: true });
      return sendJson(res, 200, {
        ok: true,
        clients: clients.size,
        messages: store.messageCount,
        rejected: store.rejectedCount,
        db: store.db.stats(),
        // Durum eslemesini ofisten dogrulamak icin: hangi ham deger hangi
        // duruma eslendi (RUNNING metni gercek tezgahta henuz bilinmiyor).
        statusMapping: [...store.unknownRawStatus],
      });
    }

    if (req.method === 'GET' && pathname === '/api/production') return handleProduction(url, res, false);
    if (req.method === 'GET' && pathname === '/api/production/export.csv') return handleProduction(url, res, true);
    if (req.method === 'GET' && pathname === '/api/production/runs') return handleProductionRuns(url, res, false);
    if (req.method === 'GET' && pathname === '/api/production/runs.csv') return handleProductionRuns(url, res, true);

    const machineMatch = pathname.match(MACHINE_ROUTE);
    if (req.method === 'GET' && machineMatch) {
      return handleMachineRoute(url, res, machineMatch[1], machineMatch[2], req.user?.role);
    }

    if (req.method === 'GET' && (await serveStatic(pathname, res))) return;

    sendJson(res, 404, { error: 'bulunamadi' });
  } catch (err) {
    // Bozuk yüzde kodlaması (/api/machines/%) istemci hatasıdır. Beklenmeyen hata günlüğe yazılır (servis olarak konsol yok).
    if (err instanceof URIError) {
      if (!res.headersSent) sendJson(res, 400, { error: 'adres gecersiz (bozuk yuzde kodlamasi)' });
      return;
    }
    console.error(`[backend] istek hatasi: ${req.method} ${pathname}`, err);
    if (res.headersSent) { res.end(); return; } // yanit baslamissa ikinci yanit yazilamaz (catch icinde atma -> surec cokerdi)
    sendJson(res, 500, { error: err.message });
  }
});

setInterval(broadcast, BROADCAST_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`[backend] dashboard  -> http://localhost:${PORT}`);
  console.log(`[backend] ingest     -> POST http://localhost:${PORT}/api/ingest`);
  console.log(`[backend] canli akis -> GET  http://localhost:${PORT}/api/stream`);
  console.log(`[backend] veritabani -> ${DB_FILE}`);
  console.log(`[backend] planlama   -> ${PLANNING_DB_FILE}`);
  if (features.closedSections.length > 0) console.log(`[backend] KAPALI bölümler (config/features.json): ${features.closedSections.join(', ')}`);
  console.log(
    `[backend] kutuphane  -> ${LIBRARY_DB_FILE}` +
      (TRANSFER_DISABLED ? '  (tezgaha GONDERME KAPALI: TRANSFER_DISABLED=1)' : ''),
  );
  if (AUTH_DISABLED) {
    console.log('[backend] !!! GIRIS SISTEMI KAPALI (AUTH_DISABLED=1): herkes yonetici. Yalniz gelistirme/demo icin.');
  } else {
    console.log(`[backend] giris      -> ${AUTH_DB_FILE}` + (auth.setupRequired ? '  (HESAP YOK: ilk yonetici hesabi localhost uzerinden olusturulmali)' : ''));
  }
});

// Suresi dolan oturumlari periyodik temizle (acilista da bir kez).
if (!AUTH_DISABLED) {
  auth.purge();
  setInterval(() => auth.purge(), 3_600_000).unref();
}

/** Kapanirken acik araliklari kapat ve tamponu bosalt - veri kaybolmasin. */
function shutdown() {
  server.close();
  for (const res of clients) res.end();
  store.close();
  library.close();
  planning.close();
  authDb.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
