/**
 * Planlama HTTP uclari: /api/planning/*  (YALNIZ yonetici: izin tablosunda listede olmayan her /api yolu admin'dir).
 *
 *   GET  /api/planning/summary                          sayilar + son iceri almalar
 *   GET  /api/planning/products?q=&limit=&offset=       urun karti listesi / arama
 *   POST /api/planning/products                         yeni urun karti (JSON)
 *   GET  /api/planning/products/:kod                    urun + bagli programlar
 *   PUT  /api/planning/products/:kod                    urun karti duzenleme (JSON; duzenlenen kart iceri almada ezilmez)
 *   GET  /api/planning/packing/sheet?day=&shift=       PAKETLEME FORMU (EYS.FR.007) vardiya sayfasi;  PUT .../packing/sheet/air {day, shift, airBar}  hava basinci
 *   POST /api/planning/packing/rows {stockCode, operator, woNo?, boxes, boxQty, halfQty?, visualCheck?, scrapQty?, note?}  satir ekle (standart koli ici adet ogrenilir);
 *        PUT|DELETE .../packing/rows/:id  duzelt / iptal (?reason=);  GET .../packing/suggest?stockCode=  koli ici adet onerisi, is emirleri, etiket dosyalari  (operator + yonetici)
 *   GET  /api/planning/(drawing|sticker)-folder         TEKNIK RESIM / ETIKET klasoru durumu;  PUT .../dir {dir}  klasoru ayarla;  POST .../match {update?}  dosyalari urun koduna gore urun kartlarina esle (yonetici)
 *   GET  /api/planning/product-files/:id                urun kartindaki dosyayi indir/ac (operator + yonetici);  DELETE ... kaldir (yonetici)
 *   POST /api/planning/import?filename=&keepOld=1       Excel'den CSV ya da .xlsx (govde = ham dosya; tur icerikten anlasilir, .xlsx'te tum sayfalar taranir)
 *   GET  /api/planning/sources                          KAYNAK KLASORU durumu: klasor, dosyalar ve her birinin son iceri almaya gore durumu (yeni/degisti/ayni)
 *   PUT  /api/planning/sources/dir {dir}                kaynak klasorunu ayarla (bos = varsayilan);  POST .../sources/refresh {force?}  klasoru oku, degisenleri uygula (yalniz yonetici)
 *   GET  /api/planning/orders?q=&open=1&limit=          siparisler (musteri siparis no + evrak no ile gruplu)
 *   GET  /api/planning/orders/lines?customerKey=&custOrderKey=&docKey=   bir siparisin satirlari
 *   GET  /api/planning/work-orders?q=&status=&machine=  is emirleri (status: aktif | planlandi | uretimde | bitti | iptal | tumu)
 *   POST /api/planning/work-orders                      yeni is emri (JSON: lineId ya da stockCode, targetQty, machineId, dueDate, sampleQty ...)
 *   GET  /api/planning/work-orders/next                 siradaki is emri numarasi;  PUT .../sequence {last}: numara tabanini ayarla
 *   GET/PUT /api/planning/work-orders/:no               is emri (olaylar, siparis satiri, gerceklesen uretim) / guncelle;  POST .../:no/cancel {reason}
 *   POST .../:no/start {machineId?, startAt?, person?, fields?}   uretime baslat;  POST .../:no/finish {endAt?, person?}  bitir (sonuc dondurulur)
 *   POST .../:no/reopen                                 yanlislikla bitirileni uretime geri al
 *   GET  /api/planning/downtime-codes                   durus nedeni kodlari (D1-D46, Z1-Z4) ve gruplari
 *   GET  /api/planning/shop/overview                    fabrika PC'si ana ekrani: tezgah basina durum, uretimdeki is emri, bekleyenler, nedeni sorulmamis duruslar
 *   GET  /api/planning/shop/stops?machine=&hours=       bir tezgahin OLCULMUS duruslari ve baglanmis nedenleri
 *   POST /api/planning/shop/downtime-reasons            duruse neden bagla (JSON: machineId, from, to, code, note?, person?);  DELETE .../:id kaldir
 *   GET  /api/planning/crates?woNo=&machine=&state=     kasalar (Urun Tanitim Karti): state = aktif | acik | kapali (paketleme bekleyen; ret HARIC) | paketlendi | ret (kartta ret tikli, paketlemeye gitmez) | iptal | tumu
 *   GET  /api/planning/crates/:id                       kasa + kart bilgileri;  POST .../:id/close {person?}  kapat;  .../:id/pack {qty, person?}  paketleme adedi;  .../:id/void {reason}  iptal
 *   POST /api/planning/work-orders/:no/fields {fields: {usedMaterial?, gkkReportNo?, firstApprovalNo?, measuredNetKg?, note?}} tezgah basindan duzenleme (operator + yonetici)
 *   GET  /api/planning/work-orders/:no/measurements  olcu kontrolu (plan + sutunlar);  PUT .../:no/measure-plan {rows: [{label, nominal?, lower?, upper?}]};  POST .../:no/measurements {slot?, values, checks, person?}  (operator + yonetici)
 *   GET  /api/planning/crates/:id/sheet             urun tanitim kartinin olcu kontrol foyu (kartin zaman araligindaki olcumler)
 *   POST /api/planning/work-orders/:no/cards {person?, gkkReportNo?, steps?, reject?} URUN TANITIM KARTI BAS (steps: yikama/kurutma/tavlama kutulari; reject: URUN RET tiki, ret kasa paketlemeye gitmez) (tek adim: kasa doldu; kart numarasini sistem verir, kasa kaydi kapali olusur);
 *   POST /api/planning/work-orders/:no/crates {person?} uretimdeki is emrinde yeni kasa ac (eski iki adimli akis; kart numarasini sistem verir);  PUT /api/planning/crates/sequence {last}: kart sirasi tabani (yonetici)
 *   GET  /api/planning/material/need                    hammadde IHTIYACI (planlanan + uretimdeki kalan adet; hammadde bazinda kg ve cubuk)
 *   GET  /api/planning/material/stock                   DEPO STOGU (Kaynak klasorunden Mikro goruntusu) + ayrilan/girilmemis tuketim -> hammadde bazinda SERBEST kg
 *   GET  /api/planning/material/consumption?from=&to=&fis=   gerceklesen SARFIYAT (biten is emirleri; fis: bekleyen | girildi | tumu);  .../consumption.csv?...&view=is-emri|hammadde
 *   POST /api/planning/material/fis {orders[], docNo?, kg?, note?}   sarfiyat fisi Mikro'ya ELLE girildi isareti;  POST .../fis/undo {orders[]}  geri al
 *   GET  /api/planning/efficiency?from=&to=&machine=    verimlilik raporu (is emri x vardiya; yalniz yonetici);  .../efficiency.csv?...&view=gunluk|matris|urun|tezgah
 *   GET  /api/planning/downtime-report?from=&to=&machine=    durus raporu (neden kodu dakikalari, nedeni belirsiz);  .../downtime-report.csv?...&view=durus|durus-kod-gun
 *   GET  /api/planning/programs                         tornalarda gorulen programlar + esleme durumu (operator + yonetici; esleme yazma uclari da)
 *   GET  /api/planning/programs/product-search?q=&limit=  eslemede urun secmek icin DAR arama {total, items: [{stockCode, name, customerCode}]} (operator + yonetici; urun karti degil)
 *   PUT  /api/planning/programs/map                     {program, stockCode}: programi urune bagla
 *   DELETE /api/planning/programs/map?program=          eslemeyi kaldir
 *   POST /api/planning/programs/confirm-exact           stok koduyla birebir tutan onerilerin hepsini onayla
 *   GET  /api/planning/gkk?q=&erpMaterial=&stockCode=   GKK rapor numaralari (EYS.FR.011; okuma: giris yapmis herkes); erpMaterial = is emrinin hammadde kodu -> eslesenler `matches`'te
 *   POST /api/planning/gkk, PUT|DELETE .../gkk/:id, PUT .../gkk/sequence {last}   (yonetici)
 *   GET  /api/planning/first-approvals?q=&year=         ilk onay raporlari / numune takip listesi (EYS.FR.013; okuma: herkes)
 *   POST /api/planning/first-approvals {woNo, person?, again?}   usta tezgah basinda numara alir (operator + yonetici; elle kayit yoneticiye ozel); PUT|DELETE .../:id, PUT .../sequence (yonetici)
 *   GET  /api/planning/work-orders/:no/drawings.pdf     is emrinin teknik resimleri TEK PDF'te birlesik (okuma: herkes)
 *   GET  /api/planning/work-orders/:no/print.pdf        is emri FORMU (on sayfa) + teknik resimler (arka sayfalar) TEK PDF'te: ekranda gosterilen ve yazdirilan dosya (okuma: herkes)
 *   POST /api/planning/work-orders/:no/drawings?name=   govde = ham PDF (yonetici);  DELETE .../drawings/:id
 *   GET  /api/planning/measure-reports?q=               olcu raporlari listesi;  GET .../work-orders/:no/measure-report  is emrinin tum olcumleri
 *   PUT  /api/planning/products/:kod/measure-plan {rows}   urun kartinin kalici olcu plani (yonetici)
 *   POST /api/planning/schedule/suggest                 CIZELGELEME ONERISI (OR-Tools CP-SAT; yalniz yonetici): bekleyen is emirlerini tezgahlara onerir, ASLA yazmaz
 *   POST /api/planning/schedule/apply {assignments: [{no, machineId}]}   onaylanan atamalari isler (mevcut updateWorkOrder yolu; baslamis is emri sessizce atlanir)
 */
import { PlanningError } from './planning.js';
import { MAX_DRAWING_BYTES } from './quality.js';

/** Excel, kullanilan alani bicimlendirilmis sayfalari yuz binlerce bos satirla disa aktarabilir: genis sinir. */
const MAX_CSV_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 100_000;

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
        reject(new PlanningError(`İstek gövdesi çok büyük (en fazla ${Math.round(max / 1048576)} MB).`, 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

async function readJson(req) {
  const buf = await readBuffer(req, MAX_JSON_BYTES);
  if (buf.length === 0) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('nesne bekleniyordu');
    return v;
  } catch (err) {
    throw new PlanningError(`Gövde JSON olarak okunamadı: ${err.message}`);
  }
}

/**
 * Operator (fabrika PC'sinin ortak hesabi) is emrini baslatirken yalniz bu alanlari doldurabilir; hedef adet, agirlik, hammadde kodu gibi
 * planlama alanlarini degistiremez (yonetici ister). Sunucu zorlar; arayuz zaten yalniz bunlari gonderir.
 */
const OPERATOR_START_FIELDS = new Set(['usedMaterial', 'gkkReportNo', 'firstApprovalNo', 'measuredNetKg', 'note']);

/** Islemi yapan kisi: giris yapmis kullanici (sunucu belirler); giris kapaliysa (demo/test) null. */
const who = (req) => (req.user && !req.user.authDisabled ? req.user.username : null);

/** Urun kartindaki dosya: PDF tarayicida acilir, Word dosyasi indirilir (Turkce dosya adi icin filename*). */
function sendProductFile(res, f) {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(f.name)?.[1]?.toLowerCase();
  const type = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword' }[ext] ?? 'application/octet-stream';
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'content-type': type, 'content-length': f.data.length, 'cache-control': 'no-store',
    'content-disposition': `${ext === 'pdf' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    ...(ext === 'pdf' ? { 'x-frame-options': 'SAMEORIGIN' } : {}),
  });
  res.end(f.data);
}

function sendError(res, err) {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[planlama]', err);
  sendJson(res, status, { error: err.message, ...(typeof err.code === 'string' ? { code: err.code } : {}) });
}

const intParam = (url, name, fallback, { min = 0, max = 1000 } = {}) => {
  const n = Number(url.searchParams.get(name));
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/**
 * Bir uc, kurulumda KAPATILABILEN bir bolume mi ait? (shared/features.js; bolum anahtari = sekme anahtari)
 *   hammadde   /material/*  (ihtiyac, sarfiyat, Mikro fisi)
 *   paketleme  POST /crates/:id/pack  (kesin paketleme adedi girisi). Kart basma, yeniden yazdirma, olcu foyu, ret, kasa LISTESI acik kalir.
 */
function sectionOf(method, path) {
  if (/^\/api\/planning\/material(?:\/|$)/.test(path)) return 'hammadde';
  if (method === 'POST' && /^\/api\/planning\/crates\/\d{1,12}\/pack$/.test(path)) return 'paketleme';
  if (/^\/api\/planning\/packing(?:\/|$)/.test(path)) return 'paketleme'; // paketleme formu (EYS.FR.007)
  return null;
}

/**
 * @param {{planning: import('./planning.js').Planning, closedSections?: string[]}} deps closedSections: bu kurulumda kapali bolumler (config/features.json)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<boolean>}
 */
export function createPlanningRoutes({ planning, closedSections = [] }) {
  const closed = new Set(closedSections);
  return async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/planning')) return false;
    const method = req.method;
    let m;

    // Kapali bolum: kimlik/rol fark etmez (yonetici dahil) reddedilir; arayuz zaten gostermez, bu eski sekme / elle istek icindir.
    const section = closed.size > 0 ? sectionOf(method, path) : null;
    if (section && closed.has(section)) {
      return sendJson(res, 403, { error: 'Bu bölüm bu kurulumda kapalı.', code: 'section-closed', section }), true;
    }

    try {
      if (method === 'GET' && path === '/api/planning/summary') return sendJson(res, 200, planning.summary()), true;

      /* ---- urunler ---- */
      if (path === '/api/planning/products') {
        if (method === 'GET') {
          return sendJson(res, 200, planning.listProducts({
            q: url.searchParams.get('q') ?? '', limit: intParam(url, 'limit', 100, { min: 1, max: 500 }), offset: intParam(url, 'offset', 0, { max: 1_000_000 }),
          })), true;
        }
        if (method === 'POST') return sendJson(res, 201, planning.createProduct(await readJson(req), { by: who(req) })), true;
      }
      if ((m = /^\/api\/planning\/products\/([^/]+)$/.exec(path))) {
        const code = decodeURIComponent(m[1]);
        if (method === 'GET') return sendJson(res, 200, planning.getProduct(code)), true;
        if (method === 'PUT') return sendJson(res, 200, planning.updateProduct(code, await readJson(req), { by: who(req) })), true;
      }

      /* ---- iceri alma ---- */
      if (method === 'POST' && path === '/api/planning/import') {
        const body = await readBuffer(req, MAX_CSV_BYTES);
        const result = planning.importFile(body, {
          filename: (url.searchParams.get('filename') ?? '').slice(0, 200) || null,
          by: who(req),
          keepOld: url.searchParams.get('keepOld') === '1',
        });
        return sendJson(res, 200, result), true;
      }

      /* ---- kaynak klasoru: Mikro / GKK Excel dosyalarini sabit klasorden oku (yalniz yonetici) ---- */
      if (method === 'GET' && path === '/api/planning/sources') return sendJson(res, 200, planning.sources.status()), true;
      if (method === 'PUT' && path === '/api/planning/sources/dir') {
        planning.sources.setDir((await readJson(req)).dir);
        return sendJson(res, 200, planning.sources.status()), true;
      }
      if (method === 'POST' && path === '/api/planning/sources/refresh') {
        const body = await readJson(req);
        return sendJson(res, 200, planning.sources.refresh({ by: who(req), force: body.force === true })), true;
      }

      /* ---- paketleme formu (EYS.FR.007): operator + yonetici ---- */
      if (method === 'GET' && path === '/api/planning/packing/sheet') {
        return sendJson(res, 200, planning.packing.sheet({ day: url.searchParams.get('day') || undefined, shift: url.searchParams.get('shift') || undefined })), true;
      }
      if (method === 'PUT' && path === '/api/planning/packing/sheet/air') return sendJson(res, 200, planning.packing.setAirBar(await readJson(req), { by: who(req) })), true;
      if (method === 'GET' && path === '/api/planning/packing/suggest') return sendJson(res, 200, planning.packing.suggest(url.searchParams.get('stockCode') ?? '')), true;
      if (method === 'POST' && path === '/api/planning/packing/rows') return sendJson(res, 201, planning.packing.addRow(await readJson(req), { by: who(req) })), true;
      if ((m = /^\/api\/planning\/packing\/rows\/(\d{1,12})$/.exec(path))) {
        if (method === 'PUT') return sendJson(res, 200, planning.packing.updateRow(Number(m[1]), await readJson(req), { by: who(req) })), true;
        if (method === 'DELETE') return sendJson(res, 200, planning.packing.voidRow(Number(m[1]), { reason: url.searchParams.get('reason') ?? '' }, { by: who(req) })), true;
      }

      /* ---- teknik resim ve etiket klasorleri: dosyalari urun koduna gore urun kartlarina esle (yonetici) ---- */
      if ((m = /^\/api\/planning\/(drawing|sticker)-folder(?:\/(dir|match))?$/.exec(path))) {
        const folder = m[1] === 'drawing' ? planning.drawingFolder : planning.stickerFolder;
        if (!m[2] && method === 'GET') return sendJson(res, 200, folder.status()), true;
        if (m[2] === 'dir' && method === 'PUT') { folder.setDir((await readJson(req)).dir); return sendJson(res, 200, folder.status()), true; }
        if (m[2] === 'match' && method === 'POST') return sendJson(res, 200, folder.match({ by: who(req), update: (await readJson(req)).update === true })), true;
      }
      if ((m = /^\/api\/planning\/product-files\/(\d{1,12})$/.exec(path))) {
        if (method === 'GET') return sendProductFile(res, planning.quality.productFileData(Number(m[1]))), true;
        if (method === 'DELETE') { planning.quality.removeProductFile(Number(m[1])); return sendJson(res, 200, { ok: true }), true; }
      }

      /* ---- siparisler ---- */
      if (method === 'GET' && path === '/api/planning/orders') {
        return sendJson(res, 200, {
          orders: planning.searchOrders({
            q: url.searchParams.get('q') ?? '', openOnly: url.searchParams.get('open') === '1', limit: intParam(url, 'limit', 100, { min: 1, max: 500 }),
          }),
        }), true;
      }
      if (method === 'GET' && path === '/api/planning/orders/lines') {
        const p = url.searchParams;
        if (!p.has('customerKey') || !p.has('custOrderKey') || !p.has('docKey')) throw new PlanningError('customerKey, custOrderKey ve docKey gerekli.');
        return sendJson(res, 200, {
          lines: planning.orderLines({ customerKey: p.get('customerKey'), custOrderKey: p.get('custOrderKey'), docKey: p.get('docKey') }),
        }), true;
      }

      /* ---- is emirleri ---- */
      if (path === '/api/planning/work-orders') {
        if (method === 'GET') {
          const status = url.searchParams.get('status') ?? 'aktif';
          return sendJson(res, 200, planning.listWorkOrders({
            q: url.searchParams.get('q') ?? '', status: ['aktif', 'planlandi', 'uretimde', 'bitti', 'iptal', 'tumu'].includes(status) ? status : 'aktif',
            machineId: url.searchParams.get('machine') ?? '', limit: intParam(url, 'limit', 100, { min: 1, max: 500 }), offset: intParam(url, 'offset', 0, { max: 1_000_000 }),
          })), true;
        }
        if (method === 'POST') return sendJson(res, 201, planning.createWorkOrder(await readJson(req), { by: who(req) })), true;
      }
      if (method === 'GET' && path === '/api/planning/work-orders/next') return sendJson(res, 200, planning.nextWorkOrderNo()), true;
      if (method === 'PUT' && path === '/api/planning/work-orders/sequence') {
        return sendJson(res, 200, planning.setWorkOrderSequence((await readJson(req)).last)), true;
      }
      if ((m = /^\/api\/planning\/work-orders\/(\d{10})$/.exec(path))) {
        if (method === 'GET') return sendJson(res, 200, planning.getWorkOrder(m[1])), true;
        if (method === 'PUT') return sendJson(res, 200, planning.updateWorkOrder(m[1], await readJson(req), { by: who(req) })), true;
      }
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/(start|finish|reopen)$/.exec(path))) {
        const by = who(req);
        if (m[2] === 'reopen') return sendJson(res, 200, planning.reopenWorkOrder(m[1], { by })), true;
        const body = await readJson(req);
        if (m[2] === 'start' && req.user?.role === 'operator') {
          const bad = Object.keys(body.fields ?? {}).filter((k) => !OPERATOR_START_FIELDS.has(k));
          if (bad.length > 0) throw new PlanningError(`Operatör bu alanları değiştiremez: ${bad.join(', ')}. Yönetici gerekir.`, 403);
        }
        return sendJson(res, 200, m[2] === 'start' ? planning.startWorkOrder(m[1], body, { by }) : planning.finishWorkOrder(m[1], body, { by })), true;
      }
      /* ---- olcu kontrolu (EYS.FR.005): operator + yonetici ---- */
      if (method === 'GET' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/measurements$/.exec(path))) return sendJson(res, 200, planning.getMeasurements(m[1])), true;
      if (method === 'PUT' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/measure-plan$/.exec(path))) {
        const body = await readJson(req);
        if (body.saveToProduct === true && req.user?.role === 'operator') throw new PlanningError('Ürün kartına yazmak yönetici işidir.', 403);
        return sendJson(res, 200, planning.setMeasurePlan(m[1], body.rows, { by: who(req), saveToProduct: body.saveToProduct === true })), true;
      }
      /* ---- olcu raporlari (kalite kontrol ve paketlemeye giden raporlar): okuma herkese ---- */
      if (method === 'GET' && path === '/api/planning/measure-reports') {
        return sendJson(res, 200, planning.measureReports({ q: url.searchParams.get('q') ?? '', limit: intParam(url, 'limit', 50, { min: 1, max: 200 }), offset: intParam(url, 'offset', 0, { max: 1_000_000 }) })), true;
      }
      if (method === 'GET' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/measure-report$/.exec(path))) return sendJson(res, 200, planning.measureReport(m[1])), true;
      if (method === 'PUT' && (m = /^\/api\/planning\/products\/([^/]+)\/measure-plan$/.exec(path))) {
        return sendJson(res, 200, planning.setProductMeasurePlan(decodeURIComponent(m[1]), (await readJson(req)).rows)), true;
      }

      /* ---- teknik resimler (PDF): okuma herkese, yukleme/silme yonetici ---- */
      if (method === 'GET' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/drawings\.pdf$/.exec(path))) {
        const merged = planning.quality.mergedDrawings(m[1]);
        if (!merged) throw new PlanningError('Bu iş emrinde teknik resim yok.', 404);
        // Dashboard bu PDF'i ayni sitedeki bir cerceve (iframe) icinde gosterir: yalniz bu uc icin SAMEORIGIN
        res.writeHead(200, {
          'content-type': 'application/pdf', 'content-length': merged.buffer.length, 'cache-control': 'no-store',
          'content-disposition': `inline; filename="cizimler-${m[1]}.pdf"`, 'x-frame-options': 'SAMEORIGIN',
        });
        res.end(merged.buffer);
        return true;
      }
      if (method === 'GET' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/print\.pdf$/.exec(path))) {
        const buffer = planning.workOrderPrintPdf(m[1]);
        res.writeHead(200, {
          'content-type': 'application/pdf', 'content-length': buffer.length, 'cache-control': 'no-store',
          'content-disposition': `inline; filename="is-emri-${m[1]}.pdf"`, 'x-frame-options': 'SAMEORIGIN',
        });
        res.end(buffer);
        return true;
      }
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/drawings$/.exec(path))) {
        const data = await readBuffer(req, MAX_DRAWING_BYTES + 4096);
        return sendJson(res, 201, { drawings: planning.quality.addDrawing(m[1], { name: url.searchParams.get('name'), data }, { by: who(req) }) }), true;
      }
      if (method === 'DELETE' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/drawings\/(\d{1,12})$/.exec(path))) {
        return sendJson(res, 200, { drawings: planning.quality.deleteDrawing(m[1], Number(m[2]), { by: who(req) }) }), true;
      }

      /* ---- GKK rapor numaralari (EYS.FR.011) ---- */
      if (path === '/api/planning/gkk') {
        if (method === 'GET') {
          return sendJson(res, 200, planning.quality.listGkk({
            q: url.searchParams.get('q') ?? '', erpMaterial: url.searchParams.get('erpMaterial') ?? '', stockCode: url.searchParams.get('stockCode') ?? '',
            limit: intParam(url, 'limit', 300, { min: 1, max: 1000 }), offset: intParam(url, 'offset', 0, { max: 1_000_000 }),
          })), true;
        }
        if (method === 'POST') return sendJson(res, 201, planning.quality.createGkk(await readJson(req), { by: who(req) })), true;
      }
      if (method === 'PUT' && path === '/api/planning/gkk/sequence') return sendJson(res, 200, planning.quality.setGkkSequence((await readJson(req)).last)), true;
      if ((m = /^\/api\/planning\/gkk\/(\d{1,12})$/.exec(path))) {
        if (method === 'PUT') return sendJson(res, 200, planning.quality.updateGkk(Number(m[1]), await readJson(req), { by: who(req) })), true;
        if (method === 'DELETE') return sendJson(res, 200, planning.quality.deleteGkk(Number(m[1]))), true;
      }

      /* ---- ilk onay raporu / numune takip listesi (EYS.FR.013) ---- */
      if (path === '/api/planning/first-approvals') {
        if (method === 'GET') {
          return sendJson(res, 200, planning.quality.listApprovals({
            q: url.searchParams.get('q') ?? '', year: intParam(url, 'year', 0, { max: 2200 }),
            limit: intParam(url, 'limit', 200, { min: 1, max: 1000 }), offset: intParam(url, 'offset', 0, { max: 1_000_000 }),
          })), true;
        }
        if (method === 'POST') {
          const body = await readJson(req);
          // Operator yalniz bir is emrinden numara alabilir; alanlari kendisi yazamaz (elle kayit yoneticiye ozel)
          if (req.user?.role === 'operator') {
            const extra = Object.keys(body).filter((k) => !['woNo', 'person', 'again'].includes(k));
            if (!body.woNo || extra.length > 0) throw new PlanningError('Operatör yalnız bir iş emrinden ilk onay numarası alabilir.', 403);
          }
          return sendJson(res, 201, planning.quality.createApproval(body, { by: who(req) })), true;
        }
      }
      if (method === 'PUT' && path === '/api/planning/first-approvals/sequence') return sendJson(res, 200, planning.quality.setApprovalSequence((await readJson(req)).last)), true;
      if ((m = /^\/api\/planning\/first-approvals\/(\d{1,12})$/.exec(path))) {
        if (method === 'PUT') return sendJson(res, 200, planning.quality.updateApproval(Number(m[1]), await readJson(req), { by: who(req) })), true;
        if (method === 'DELETE') return sendJson(res, 200, planning.quality.deleteApproval(Number(m[1]), { by: who(req) })), true;
      }
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/measurements$/.exec(path))) {
        return sendJson(res, 200, planning.saveMeasurements(m[1], await readJson(req), { by: who(req) })), true;
      }
      if (method === 'GET' && (m = /^\/api\/planning\/crates\/(\d{1,12})\/sheet$/.exec(path))) return sendJson(res, 200, planning.measureSheet(Number(m[1]))), true;

      // Tezgah basindan is emri alani duzenleme (operator + yonetici): yalniz ilk onay rapor no, olculen net gramaj, GKK rapor no, kullanilan hammadde, aciklama
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/fields$/.exec(path))) {
        const body = await readJson(req);
        return sendJson(res, 200, planning.updateWorkOrderFields(m[1], body.fields ?? {}, { by: who(req) })), true;
      }
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/cancel$/.exec(path))) {
        return sendJson(res, 200, planning.cancelWorkOrder(m[1], { reason: (await readJson(req)).reason, by: who(req) })), true;
      }

      /* ---- fabrika PC'si: duruslar ve ana ekran (operator + yonetici) ---- */
      if (method === 'GET' && path === '/api/planning/downtime-codes') return sendJson(res, 200, planning.downtimeCodes()), true;
      if (method === 'GET' && path === '/api/planning/shop/overview') return sendJson(res, 200, planning.shopOverview()), true;
      if (method === 'GET' && path === '/api/planning/shop/stops') {
        const machine = url.searchParams.get('machine') ?? '';
        return sendJson(res, 200, { machineId: machine, minStopMinutes: planning.downtimeCodes().minStopMinutes, stops: planning.machineStops(machine, { hours: intParam(url, 'hours', 24, { min: 1, max: 192 }) }) }), true;
      }
      if (method === 'POST' && path === '/api/planning/shop/downtime-reasons') {
        return sendJson(res, 201, planning.addDowntimeReason(await readJson(req), { by: who(req) })), true;
      }
      if (method === 'DELETE' && (m = /^\/api\/planning\/shop\/downtime-reasons\/(\d{1,12})$/.exec(path))) {
        return sendJson(res, 200, planning.removeDowntimeReason(Number(m[1]), { by: who(req) })), true;
      }

      /* ---- kasalar (Urun Tanitim Karti): operator + yonetici ---- */
      if (method === 'GET' && path === '/api/planning/crates') {
        const st = url.searchParams.get('state') ?? 'aktif';
        return sendJson(res, 200, planning.listCrates({
          woNo: url.searchParams.get('woNo') ?? '', machineId: url.searchParams.get('machine') ?? '',
          state: ['aktif', 'acik', 'kapali', 'paketlendi', 'ret', 'iptal', 'tumu'].includes(st) ? st : 'aktif',
          limit: intParam(url, 'limit', 100, { min: 1, max: 500 }), offset: intParam(url, 'offset', 0, { max: 1_000_000 }),
        })), true;
      }
      if (method === 'PUT' && path === '/api/planning/crates/sequence') return sendJson(res, 200, planning.setCrateSequence((await readJson(req)).last)), true;
      if (method === 'GET' && (m = /^\/api\/planning\/crates\/(\d{1,12})$/.exec(path))) return sendJson(res, 200, planning.getCrate(Number(m[1]))), true;
      if (method === 'POST' && (m = /^\/api\/planning\/crates\/(\d{1,12})\/(close|pack|void)$/.exec(path))) {
        const body = await readJson(req);
        const by = who(req);
        const id = Number(m[1]);
        return sendJson(res, 200, m[2] === 'close' ? planning.closeCrate(id, body, { by }) : m[2] === 'pack' ? planning.packCrate(id, body, { by }) : planning.voidCrate(id, body, { by })), true;
      }
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/cards$/.exec(path))) {
        return sendJson(res, 201, planning.issueCard(m[1], await readJson(req), { by: who(req) })), true;
      }
      if (method === 'POST' && (m = /^\/api\/planning\/work-orders\/(\d{10})\/crates$/.exec(path))) {
        return sendJson(res, 201, planning.openCrate(m[1], await readJson(req), { by: who(req) })), true;
      }

      /* ---- verimlilik ve durus raporlari (yalniz yonetici) ---- */
      if (method === 'GET' && /^\/api\/planning\/(?:efficiency|downtime-report)(?:\.csv)?$/.exec(path)) {
        const q = { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined, machine: url.searchParams.get('machine') || '' };
        const isDowntime = path.includes('downtime-report');
        if (path.endsWith('.csv')) {
          const view = url.searchParams.get('view') ?? '';
          const allowed = isDowntime ? ['durus', 'durus-kod-gun'] : ['gunluk', 'matris', 'urun', 'tezgah'];
          const { filename, text } = planning.efficiencyCsv(q, allowed.includes(view) ? view : allowed[0]);
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
          res.end(text);
          return true;
        }
        return sendJson(res, 200, isDowntime ? planning.downtimeReport(q) : planning.efficiencyReport(q)), true;
      }

      /* ---- hammadde ve sarfiyat (yalniz yonetici) ---- */
      if (method === 'GET' && path === '/api/planning/material/need') return sendJson(res, 200, planning.materialNeed()), true;
      if (method === 'GET' && path === '/api/planning/material/stock') return sendJson(res, 200, planning.materialStock()), true;
      if (method === 'GET' && (path === '/api/planning/material/consumption' || path === '/api/planning/material/consumption.csv')) {
        const fis = url.searchParams.get('fis') ?? 'tumu';
        const q = { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined, fis: ['bekleyen', 'girildi', 'tumu'].includes(fis) ? fis : 'tumu' };
        if (path.endsWith('.csv')) {
          const view = url.searchParams.get('view') === 'hammadde' ? 'hammadde' : 'is-emri';
          const { filename, text } = planning.materialCsv(q, view);
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
          res.end(text);
          return true;
        }
        return sendJson(res, 200, planning.materialConsumption(q)), true;
      }
      if (method === 'POST' && path === '/api/planning/material/fis') return sendJson(res, 200, planning.markFis(await readJson(req), { by: who(req) })), true;
      if (method === 'POST' && path === '/api/planning/material/fis/undo') return sendJson(res, 200, planning.clearFis(await readJson(req), { by: who(req) })), true;

      /* ---- program eslemesi ---- */
      if (method === 'GET' && path === '/api/planning/programs') return sendJson(res, 200, planning.listPrograms()), true;
      if (method === 'GET' && path === '/api/planning/programs/product-search') {
        const r = planning.listProducts({ q: url.searchParams.get('q') ?? '', limit: intParam(url, 'limit', 30, { min: 1, max: 50 }), offset: 0 });
        return sendJson(res, 200, { total: r.total, items: r.items.map((x) => ({ stockCode: x.stockCode, name: x.name, customerCode: x.customerCode })) }), true;
      }
      if (method === 'PUT' && path === '/api/planning/programs/map') {
        const b = await readJson(req);
        return sendJson(res, 200, planning.mapProgram(b.program, b.stockCode, { by: who(req) })), true;
      }
      if (method === 'DELETE' && path === '/api/planning/programs/map') {
        planning.unmapProgram(url.searchParams.get('program') ?? '');
        return sendJson(res, 200, { ok: true }), true;
      }
      if (method === 'POST' && path === '/api/planning/programs/confirm-exact') {
        return sendJson(res, 200, { confirmed: planning.confirmExactSuggestions({ by: who(req) }) }), true;
      }

      /* ---- cizelgeleme / optimizasyon (OR-Tools CP-SAT; yalniz yonetici): oneri ASLA otomatik uygulanmaz ---- */
      if (method === 'POST' && path === '/api/planning/schedule/suggest') return sendJson(res, 200, await planning.schedule.suggest()), true;
      if (method === 'POST' && path === '/api/planning/schedule/apply') {
        const body = await readJson(req);
        return sendJson(res, 200, planning.schedule.apply(body.assignments, { by: who(req) })), true;
      }

      return sendJson(res, 404, { error: 'bulunamadı' }), true;
    } catch (err) {
      // PlanningError / ImportError kendi durum kodunu tasir; digerleri 500.
      return sendError(res, err), true;
    }
  };
}
