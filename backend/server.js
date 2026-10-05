// ILK import olmali: store.js -> db.js -> node:sqlite zinciri baslamadan
// Node surumunu kontrol edip okunur bir hata verir.
import './preflight.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseTelemetry } from '../shared/schema.js';
import { loadDrivers } from '../shared/drivers.js';
import { loadConfig, validateMachines, saveMachines } from '../shared/inventory.js';
import { TelemetryStore, SHIFT_WINDOW_MS } from './store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_FILE = process.env.DB_FILE ?? 'data/telemetry.db';
/**
 * Ayarlar ekranindan yapilandirma yazimi. Kimlik dogrulama HENUZ YOK - ofis
 * agindaki herkes tezgah tanimlarini degistirebilir. Dashboard ofis LAN'i
 * disina acilacaksa bunu 1 yapip yazimi kapatin (Bolum 08).
 */
const CONFIG_READONLY = process.env.CONFIG_READONLY === '1';
/** Dashboard'a yayin sikligi - ingest hizindan bagimsiz (Bolum 07: < 2-5 sn). */
const BROADCAST_MS = 1000;
const MAX_BODY_BYTES = 1_000_000;

const store = new TelemetryStore(DB_FILE);
/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

/** Path traversal'a kapali olmasi icin acik liste. */
const STATIC_FILES = {
  '/': ['../dashboard/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['../dashboard/app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['../dashboard/charts.js', 'text/javascript; charset=utf-8'],
  '/config-view.js': ['../dashboard/config-view.js', 'text/javascript; charset=utf-8'],
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: `govde okunamadi: ${err.message}` });
  }

  const batch = Array.isArray(payload) ? payload : [payload];
  const errors = [];
  let accepted = 0;

  for (const raw of batch) {
    const parsed = parseTelemetry(raw);
    if (parsed.ok) {
      store.ingest(parsed.value);
      accepted += 1;
    } else {
      store.rejectedCount += 1;
      if (errors.length < 10) {
        errors.push({ machineId: raw?.machineId ?? null, errors: parsed.errors });
      }
    }
  }

  // Kismi kabul: gecerli mesajlar yazilir, gecersizler raporlanir.
  sendJson(res, errors.length > 0 ? 207 : 202, {
    accepted,
    rejected: batch.length - accepted,
    errors,
  });
}

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function broadcast() {
  if (clients.size === 0) {
    // Istemci yoksa da sessizlige dusen tezgahlar NO_DATA olarak isaretlenmeli.
    store.sweep();
    return;
  }
  const frame = `event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
  for (const res of clients) {
    // Yavas istemci baglantiyi tikamasin diye yazma hatasi sessizce dusurulur.
    res.write(frame, (err) => {
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

function csvCell(value) {
  if (value === null || value === undefined) return '';
  // Ondalik ayirici virgul - Turkce Excel sayiyi boyle tanir.
  const text = typeof value === 'number' ? String(value).replace('.', ',') : String(value);
  return /[";\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function handleExport(res, machineId, fromMs, toMs) {
  const { rows } = store.db.samples(machineId, fromMs, toMs, 100_000);
  const lines = ['sep=;', CSV_COLUMNS.map(([name]) => name).join(';')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(';'));
  }

  const stamp = new Date(fromMs).toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${machineId}-${stamp}.csv"`,
    'cache-control': 'no-store',
  });
  // BOM: Excel dosyayi UTF-8 olarak acsin, Turkce karakterler bozulmasin.
  res.end('﻿' + lines.join('\r\n') + '\r\n');
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

function handleMachineRoute(url, res, idRaw, action) {
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
      return sendJson(res, 200, {
        machine,
        live: store.liveHistory(machineId).samples,
        summary: store.db.summary(machineId, fromMs, toMs),
        spans: store.db.spans(machineId, fromMs, toMs),
        downtimes: store.db.downtimes(machineId, fromMs, toMs),
      });
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
      return handleExport(res, machineId, fromMs, toMs);
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

  try {
    if (req.method === 'POST' && pathname === '/api/ingest') return await handleIngest(req, res);
    if (req.method === 'GET' && pathname === '/api/stream') return handleStream(req, res);
    if (req.method === 'GET' && pathname === '/api/machines') {
      return sendJson(res, 200, store.snapshot());
    }
    if (req.method === 'GET' && pathname === '/api/drivers') {
      return sendJson(res, 200, { drivers: loadDrivers() });
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

    const machineMatch = pathname.match(MACHINE_ROUTE);
    if (req.method === 'GET' && machineMatch) {
      return handleMachineRoute(url, res, machineMatch[1], machineMatch[2]);
    }

    if (req.method === 'GET' && (await serveStatic(pathname, res))) return;

    sendJson(res, 404, { error: 'bulunamadi' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

setInterval(broadcast, BROADCAST_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`[backend] dashboard  -> http://localhost:${PORT}`);
  console.log(`[backend] ingest     -> POST http://localhost:${PORT}/api/ingest`);
  console.log(`[backend] canli akis -> GET  http://localhost:${PORT}/api/stream`);
  console.log(`[backend] veritabani -> ${DB_FILE}`);
});

/** Kapanirken acik araliklari kapat ve tamponu bosalt - veri kaybolmasin. */
function shutdown() {
  server.close();
  for (const res of clients) res.end();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
