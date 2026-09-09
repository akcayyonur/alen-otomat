import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseTelemetry } from '../shared/schema.js';
import { TelemetryStore } from './store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
/** Dashboard'a yayin sikligi - ingest hizindan bagimsiz (Bolum 07: < 2-5 sn). */
const BROADCAST_MS = 1000;
const MAX_BODY_BYTES = 1_000_000;

const store = new TelemetryStore();
/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

/** Path traversal'a kapali olmasi icin acik liste. */
const STATIC_FILES = {
  '/': ['../dashboard/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['../dashboard/app.js', 'text/javascript; charset=utf-8'],
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
      if (errors.length < 10) errors.push({ machineId: raw?.machineId ?? null, errors: parsed.errors });
    }
  }

  // Kismi kabul: gecerli mesajlar yazilir, gecersizler raporlanir.
  sendJson(res, errors.length > 0 ? 207 : 202, { accepted, rejected: batch.length - accepted, errors });
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
  if (clients.size === 0) return;
  const frame = `event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
  for (const res of clients) {
    // Yavas istemci baglantiyi tikamasin diye yazma hatasi sessizce dusurulur.
    res.write(frame, (err) => {
      if (err) clients.delete(res);
    });
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
    if (req.method === 'GET' && pathname === '/api/machines') return sendJson(res, 200, store.snapshot());
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, clients: clients.size, messages: store.messageCount });
    }

    const historyMatch = pathname.match(/^\/api\/machines\/([^/]+)\/history$/);
    if (req.method === 'GET' && historyMatch) {
      const result = store.history(decodeURIComponent(historyMatch[1]));
      return result
        ? sendJson(res, 200, result)
        : sendJson(res, 404, { error: 'tezgah bulunamadi' });
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
});
