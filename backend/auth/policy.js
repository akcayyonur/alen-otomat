/**
 * Hangi uc kime acik? SAF islev (HTTP'siz), test edilir. Kural: VARSAYILAN REDDET.
 *
 *   public   giris gerektirmez (statik dosyalar, oturum/giris uclari, saglik)
 *   local    yalniz sunucu bilgisayarindan (ajan -> ingest, ajanin tezgah listesi)
 *   viewer   giris yapmis herhangi biri (viewer, operator ya da admin): yalniz IZLEME
 *   operator operator (fabrika PC'sinin ortak hesabi) ya da yonetici: is emri baslat/bitir, durus nedeni (planlama T asamasi)
 *   admin    yalniz yonetici
 *
 * Listede acikca yazmayan her /api yolu admin'dir: yarin eklenen bir uc, siz haberdar olmadan
 * viewer'a acilmaz. Viewer'a acilanlar asagida TEK YERDE ve sinirli.
 */

/** GET /api/machines/<id> ve yalniz bu alt yollar izleme verisidir. Programlar/klasorler DEGIL. */
const VIEWER_MACHINE = /^\/api\/machines\/[^/]+(?:\/(?:history|spans|summary|downtimes|export\.csv))?$/;

/**
 * Fabrika PC'sinin (operator) kullanabildigi planlama uclari: YALNIZ bunlar, TEK YERDE. Viewer bunlari goremez; baska planlama ucu
 * (urun karti, siparis, ice aktarma, program esleme, is emri olusturma/duzenleme/iptal/geri alma) yoneticiye ozeldir.
 * Operatorun baslatirken hangi is emri alanlarini yazabilecegi ayrica routes.js'te zorlanir.
 */
const OPERATOR_PLANNING = Object.freeze([
  ['GET', /^\/api\/planning\/(?:summary|downtime-codes|shop\/(?:overview|stops))$/],
  ['GET', /^\/api\/planning\/work-orders$/],
  ['GET', /^\/api\/planning\/work-orders\/\d{10}$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/(?:start|finish)$/],
  ['POST', /^\/api\/planning\/shop\/downtime-reasons$/],
  ['DELETE', /^\/api\/planning\/shop\/downtime-reasons\/\d{1,12}$/],
  // kasalar (Urun Tanitim Karti): ac / kapat / paketleme adedi / iptal ve okuma; kart numarasi sirasi tabani (PUT crates/sequence) yoneticiye ozel
  ['GET', /^\/api\/planning\/crates$/],
  ['GET', /^\/api\/planning\/crates\/\d{1,12}$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/crates$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/cards$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/fields$/],
  // olcu kontrolu (EYS.FR.005): plan, saatlik olcum girisi, kartin foyu
  ['GET', /^\/api\/planning\/work-orders\/\d{10}\/measurements$/],
  ['PUT', /^\/api\/planning\/work-orders\/\d{10}\/measure-plan$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/measurements$/],
  ['GET', /^\/api\/planning\/crates\/\d{1,12}\/sheet$/],
  ['POST', /^\/api\/planning\/crates\/\d{1,12}\/(?:close|pack|void)$/],
]);

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {'public'|'local'|'viewer'|'operator'|'admin'}
 */
export function classify(method, pathname) {
  const m = String(method).toUpperCase();
  const p = String(pathname);
  // /api disindaki yollar: statik dosyalar ya da 404 (gizli bir sey sunmaz).
  if (!p.toLowerCase().startsWith('/api')) return 'public';

  if (m === 'GET' && p === '/api/session') return 'public';
  if (m === 'POST' && (p === '/api/auth/login' || p === '/api/auth/setup')) return 'public';
  if (m === 'GET' && p === '/api/health') return 'public'; // ayrinti yalniz admin'e (http katmani)

  if ((m === 'POST' && p === '/api/ingest') || (m === 'GET' && p === '/api/agent/machines')) return 'local';

  if (m === 'POST' && (p === '/api/auth/logout' || p === '/api/auth/password')) return 'viewer';
  if (m === 'GET' && (p === '/api/stream' || p === '/api/machines' || VIEWER_MACHINE.test(p))) return 'viewer';
  // Uretim raporu (vardiya adetleri) izleme verisidir: tezgah ag bilgisi icermez.
  if (m === 'GET' && (p === '/api/production' || p === '/api/production/export.csv' || p === '/api/production/runs' || p === '/api/production/runs.csv')) return 'viewer';

  if (OPERATOR_PLANNING.some(([mm, re]) => mm === m && re.test(p))) return 'operator';

  return 'admin';
}

/** Viewer'a gonderilmeyecek alanlar (tezgahin ag ayrintilari). */
const HIDDEN_FOR_VIEWER = ['ip', 'ftpPort', 'port'];

/** Tezgah nesnesinin viewer icin kopyasi: IP/port gibi ic ag bilgileri cikarilir. */
export function redactMachine(machine) {
  if (!machine || typeof machine !== 'object') return machine;
  const copy = { ...machine };
  for (const key of HIDDEN_FOR_VIEWER) delete copy[key];
  return copy;
}

/** /api/machines ve SSE kareleri: tum tezgahlar. */
export function redactSnapshot(snapshot) {
  return { ...snapshot, machines: snapshot.machines.map(redactMachine) };
}

/** /api/machines/:id ayrintisi. */
export function redactDetail(detail) {
  return detail?.machine ? { ...detail, machine: redactMachine(detail.machine) } : detail;
}
