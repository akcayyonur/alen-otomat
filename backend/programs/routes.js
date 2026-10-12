/**
 * Program kutuphanesi ve aktarim HTTP uclari.
 *
 * Telemetri yolundan (ingest/stream/machines) tamamen AYRI: /api/library/*,
 * /api/transfers/* ve /api/machines/:id/programs*. Telemetri kodu bu modulu
 * import etmez; yazma yolu yalnizca burada.
 *
 * KIMLIK DOGRULAMA HENUZ YOK (karar: simdilik ofis agindaki herkes kutuphaneyi
 * kullanabilir; ikinci onay = tezgah adini yazmak). Gonderen `by` alani ve istemci
 * IP'si denetim kaydina yazilir. Ozelligi tamamen kapatmak: TRANSFER_DISABLED=1.
 */
import { MAX_PROGRAM_BYTES, TEMP_PREFIX, ValidationError } from './library.js';
import { FtpError } from './ftp-client.js';
import { driverFtpOptions, sendPolicy, deletePolicy } from './machine-files.js';

/**
 * Islemi yapan kisi (denetim kaydina yazilir): giris yapmis kullanicinin adi. Sunucu belirler, istemcinin yazdigi
 * "adiniz" alanina GUVENILMEZ. Giris sistemi kapaliysa (gelistirme/demo/test) istemcinin yazdigi ad kullanilir.
 */
function who(req, fallback) {
  if (req.user && !req.user.authDisabled) return req.user.username;
  return fallback ?? null;
}

const MAX_JSON_BYTES = 100_000;
/** Editorden gelen metin JSON icinde tasinir (satir sonlari, tirnaklar kacirilir): dosya sinirinin uzerinde pay. */
const MAX_TEXT_JSON_BYTES = MAX_PROGRAM_BYTES * 3 + 4096;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBuffer(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return; // kalan govde bosa akitilir: istemci yaniti okuyabilsin
      size += c.length;
      if (size > max) {
        rejected = true;
        chunks.length = 0;
        reject(new ValidationError(`İstek gövdesi çok büyük (en fazla ${max} bayt).`, 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

async function readJson(req, max = MAX_JSON_BYTES) {
  const buf = await readBuffer(req, max);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new ValidationError(`Gövde JSON olarak okunamadı: ${err.message}`);
  }
}

/** Hata -> HTTP yaniti. FTP hatalari 502 (tezgah tarafi), dogrulama 400... */
function sendError(res, err) {
  const status = err.status ?? (err instanceof FtpError ? 502 : 500);
  const prefix = err instanceof FtpError ? 'Tezgahla FTP konuşulamadı: ' : '';
  if (status >= 500 && !(err instanceof FtpError)) console.error('[programlar]', err);
  sendJson(res, status, {
    error: `${prefix}${err.message}`,
    ...(err.step ? { step: err.step } : {}),
    // Makine-okunur neden (ör. 'newer-version', 'exists'): arayuz buna gore secenek sunar. FtpError.code sayidir, atlanir.
    ...(typeof err.code === 'string' ? { code: err.code } : {}),
  });
}

const ID = '([^/]+)';
const route = (re) => (path) => re.exec(path);
const R = {
  programs: route(/^\/api\/library\/programs$/),
  programText: route(/^\/api\/library\/programs\/text$/),
  program: route(new RegExp(`^/api/library/programs/(\\d+)$`)),
  version: route(new RegExp(`^/api/library/programs/(\\d+)/versions/(\\d+)$`)),
  machinePrograms: route(new RegExp(`^/api/machines/${ID}/programs$`)),
  machineScan: route(new RegExp(`^/api/machines/${ID}/programs/scan$`)),
  machineImport: route(new RegExp(`^/api/machines/${ID}/programs/import$`)),
  machineFolders: route(new RegExp(`^/api/machines/${ID}/folders$`)),
  importPlan: route(new RegExp(`^/api/machines/${ID}/programs/import-plan$`)),
  importPlanGet: route(new RegExp(`^/api/machines/${ID}/programs/import-plan/([A-Za-z0-9_-]+)$`)),
  importPlanDiff: route(new RegExp(`^/api/machines/${ID}/programs/import-plan/([A-Za-z0-9_-]+)/diff$`)),
  importApply: route(new RegExp(`^/api/machines/${ID}/programs/import-apply$`)),
  deletePrecheck: route(new RegExp(`^/api/machines/${ID}/programs/delete-precheck$`)),
  deleteProgram: route(new RegExp(`^/api/machines/${ID}/programs/delete$`)),
};

/**
 * @param {{library: import('./library.js').Library, files: import('./machine-files.js').MachineFiles,
 *   listMachines: () => object[]}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<boolean>}
 */
export function createProgramRoutes({ library, files, listMachines, authRequired = false }) {
  // Tarama/kutuphane icin uygun mu (FTP ayari var mi) + kontrolcu modelinde GONDERME acik mi.
  const eligibility = (m) => {
    const policy = sendPolicy(m);
    const del = deletePolicy(m, files.flags);
    const model = {
      controllerModel: m.controllerModel ?? null, sendAllowed: policy.allowed, sendBlockedReason: policy.reason,
      deleteAllowed: del.allowed, deleteBlockedReason: del.reason,
    };
    try { driverFtpOptions(m); return { capable: true, reason: null, ...model }; } catch (err) { return { capable: false, reason: err.message, ...model }; }
  };

  return async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    let m;

    try {
      /* ---- ayarlar / yardimcilar ---- */
      if (method === 'GET' && path === '/api/library/config') {
        return sendJson(res, 200, {
          transferEnabled: files.transferEnabled,
          authRequired,
          maxProgramBytes: MAX_PROGRAM_BYTES,
          tempPrefix: TEMP_PREFIX,
          overwriteEnabled: false,
          stats: library.db.stats(),
          machines: listMachines().map((x) => ({ id: x.id, name: x.name, ip: x.ip ?? null, ...eligibility(x) })),
        }), true;
      }
      if (method === 'GET' && path === '/api/library/customers') {
        return sendJson(res, 200, { customers: library.customers() }), true;
      }
      if (method === 'GET' && path === '/api/library/matrix') {
        return sendJson(res, 200, library.matrix(listMachines().filter((x) => eligibility(x).capable))), true;
      }

      /* ---- kutuphane ---- */
      if (method === 'GET' && R.programs(path)) {
        const customer = url.searchParams.has('customer') ? url.searchParams.get('customer') : null;
        return sendJson(res, 200, { programs: library.db.listPrograms({ customer, q: url.searchParams.get('q') ?? '' }) }), true;
      }

      if (method === 'POST' && R.programs(path)) {
        const content = await readBuffer(req, MAX_PROGRAM_BYTES + 1024);
        const result = library.addUpload({
          customer: url.searchParams.get('customer') ?? '',
          name: url.searchParams.get('name'),
          note: url.searchParams.get('note'),
          createdBy: who(req, url.searchParams.get('by')),
          originalName: url.searchParams.get('originalName'),
          content,
        });
        return sendJson(res, result.created ? 201 : 200, result), true;
      }

      // Program editoru: metin JSON ile gelir; satir sonu/kodlama sunucuda uygulanir (bkz. library.saveText).
      if (method === 'POST' && R.programText(path)) {
        const b = await readJson(req, MAX_TEXT_JSON_BYTES);
        const result = library.saveText({
          programId: b.programId ?? null, baseVersionNo: b.baseVersionNo ?? null,
          customer: b.customer ?? '', name: b.name, text: b.text,
          lineEnding: b.lineEnding ?? 'CRLF', encoding: b.encoding ?? 'utf-8', bom: b.bom === true,
          note: b.note ?? null, createdBy: who(req, b.by), acceptNewer: b.acceptNewer === true,
        });
        return sendJson(res, result.created ? 201 : 200, result), true;
      }

      if (method === 'GET' && (m = R.program(path))) {
        const program = library.db.getProgram(Number(m[1]));
        if (!program) return sendJson(res, 404, { error: 'Program bulunamadı.' }), true;
        return sendJson(res, 200, { program, versions: library.db.listVersions(program.id) }), true;
      }

      if (method === 'GET' && (m = R.version(path))) {
        const programId = Number(m[1]);
        const versionNo = Number(m[2]);
        if (url.searchParams.get('download') === '1') {
          const v = library.db.getVersion(programId, versionNo);
          const program = library.db.getProgram(programId);
          if (!v || !program) return sendJson(res, 404, { error: 'Sürüm bulunamadı.' }), true;
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${program.name}"`,
            'content-length': v.content.length,
            'cache-control': 'no-store',
          });
          res.end(v.content);
          return true;
        }
        // ?full=1: editor tam metni ister (kesik metinle kaydetmek icerigi sessizce kisaltirdi).
        const p = library.preview(programId, versionNo, url.searchParams.get('full') === '1' ? Infinity : undefined);
        if (!p) return sendJson(res, 404, { error: 'Sürüm bulunamadı.' }), true;
        return sendJson(res, 200, p), true;
      }

      /* ---- tezgah envanteri ---- */
      if (method === 'GET' && (m = R.machinePrograms(path))) {
        const id = decodeURIComponent(m[1]);
        if (!listMachines().some((x) => x.id === id)) return sendJson(res, 404, { error: `Tezgah bulunamadı: ${id}` }), true;
        return sendJson(res, 200, library.compareMachine(id)), true;
      }
      if (method === 'POST' && (m = R.machineScan(path))) {
        return sendJson(res, 200, await files.scan(decodeURIComponent(m[1]))), true;
      }
      if (method === 'POST' && (m = R.machineImport(path))) {
        const body = await readJson(req);
        const result = await files.importFromMachine({
          machineId: decodeURIComponent(m[1]), customer: body.customer ?? '', name: body.name, by: who(req, body.by),
        });
        return sendJson(res, result.created ? 201 : 200, result), true;
      }

      if (method === 'POST' && (m = R.machineFolders(path))) {
        const b = await readJson(req);
        const rec = await files.createFolder({
          machineId: decodeURIComponent(m[1]), name: b.name, confirm: b.confirm, by: who(req, b.by),
          clientIp: req.clientIp ?? req.socket.remoteAddress ?? null,
        });
        return sendJson(res, 200, rec), true;
      }

      /* ---- toplu iceri alma (plan + uygula; tornaya yalniz OKUMA) ---- */
      if (method === 'POST' && (m = R.importPlan(path))) {
        const b = await readJson(req);
        const planId = files.startImportPlan({ machineId: decodeURIComponent(m[1]), folders: b.folders ?? null });
        return sendJson(res, 202, { planId }), true;
      }
      if (method === 'GET' && (m = R.importPlanGet(path))) {
        return sendJson(res, 200, files.getImportPlan(decodeURIComponent(m[1]), m[2])), true;
      }
      if (method === 'GET' && (m = R.importPlanDiff(path))) {
        return sendJson(res, 200, files.importPlanDiff(decodeURIComponent(m[1]), m[2], url.searchParams.get('key') ?? '')), true;
      }
      if (method === 'POST' && (m = R.importApply(path))) {
        const b = await readJson(req, 1_000_000);
        const out = files.applyImport({
          machineId: decodeURIComponent(m[1]), planId: b.planId, decisions: b.decisions ?? {}, skipKeys: b.skipKeys ?? [], by: who(req, b.by),
        });
        return sendJson(res, 200, out), true;
      }

      /* ---- tornadan silme (FTP DELE; silme kapisi + onay) ---- */
      if (method === 'POST' && (m = R.deletePrecheck(path))) {
        const b = await readJson(req);
        return sendJson(res, 200, await files.deletePrecheck({
          machineId: decodeURIComponent(m[1]), customer: b.customer ?? '', name: b.name, acks: b.acks ?? [],
        })), true;
      }
      if (method === 'POST' && (m = R.deleteProgram(path))) {
        const b = await readJson(req);
        const rec = await files.deleteProgram({
          machineId: decodeURIComponent(m[1]), customer: b.customer ?? '', name: b.name, confirm: b.confirm,
          by: who(req, b.by), acks: b.acks ?? [], clientIp: req.clientIp ?? req.socket.remoteAddress ?? null,
        });
        return sendJson(res, 200, rec), true;
      }

      /* ---- aktarim ---- */
      if (method === 'POST' && path === '/api/transfers/precheck') {
        const b = await readJson(req);
        return sendJson(res, 200, await files.precheck({
          machineId: b.machineId, programId: b.programId, versionNo: b.versionNo, customer: b.customer, acks: b.acks ?? [],
        })), true;
      }
      if (method === 'POST' && path === '/api/transfers') {
        const b = await readJson(req);
        const transfer = await files.send({
          machineId: b.machineId, programId: b.programId, versionNo: b.versionNo, customer: b.customer,
          confirm: b.confirm, by: who(req, b.by), acks: b.acks ?? [], clientIp: req.clientIp ?? req.socket.remoteAddress ?? null,
        });
        return sendJson(res, 200, transfer), true;
      }
      if (method === 'GET' && path === '/api/transfers') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        return sendJson(res, 200, { transfers: library.db.listTransfers({ machineId: url.searchParams.get('machineId'), limit }) }), true;
      }
    } catch (err) {
      sendError(res, err);
      return true;
    }
    return false;
  };
}
