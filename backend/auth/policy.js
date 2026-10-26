/**
 * Hangi uc kime acik? SAF islev (HTTP'siz), test edilir. Kural: VARSAYILAN REDDET.
 *
 *   public   giris gerektirmez (statik dosyalar, oturum/giris uclari, saglik)
 *   local    yalniz sunucu bilgisayarindan (ajan -> ingest, ajanin tezgah listesi)
 *   viewer   giris yapmis herhangi biri (viewer, operator ya da admin): yalniz IZLEME (telemetri; planlamada yalniz asagidaki VIEWER_PLANNING okumalari)
 *   operator operator (fabrika PC'sinin ortak hesabi) ya da yonetici: is emri baslat/bitir, durus nedeni (planlama T asamasi)
 *   admin    yalniz yonetici
 *
 * Listede acikca yazmayan her /api yolu admin'dir: yarin eklenen bir uc, siz haberdar olmadan
 * viewer'a acilmaz. Viewer'a acilanlar asagida TEK YERDE ve sinirli.
 */

/** GET /api/machines/<id> ve yalniz bu alt yollar izleme verisidir. Programlar/klasorler DEGIL. */
const VIEWER_MACHINE = /^\/api\/machines\/[^/]+(?:\/(?:history|spans|summary|downtimes|export\.csv))?$/;

/**
 * Planlamada IZLEYICININ (viewer) de okuyabildigi uclar: YALNIZ GET, TEK YERDE. Tezgah basi, is emirleri (liste, ayrinti, form, birlesik teknik resim),
 * GKK rapor numaralari, ilk onay raporlari ve olcu raporlari. Siparis, urun karti, verimlilik, hammadde, ice aktarma, program esleme gibi baska
 * hicbir planlama ucu izleyiciye acik DEGILDIR (yazan her uc zaten operator/admin).
 */
const VIEWER_PLANNING = Object.freeze([
  /^\/api\/planning\/(?:summary|downtime-codes|gkk|first-approvals|measure-reports|crates)$/,
  /^\/api\/planning\/shop\/(?:overview|stops)$/,
  /^\/api\/planning\/work-orders$/,
  /^\/api\/planning\/work-orders\/\d{10}$/,
  /^\/api\/planning\/work-orders\/\d{10}\/(?:measurements|measure-report|drawings\.pdf|print\.pdf)$/,
  /^\/api\/planning\/crates\/\d{1,12}(?:\/sheet)?$/,
]);

/**
 * Fabrika PC'sinin (operator) kullanabildigi planlama uclari (yazma + program eslemesi icin okuma): YALNIZ bunlar, TEK YERDE. Viewer bunlari yapamaz; baska planlama ucu
 * (urun karti, siparis, ice aktarma, program esleme, is emri olusturma/duzenleme/iptal/geri alma, GKK ve cizim yonetimi) yoneticiye ozeldir.
 * Operatorun baslatirken hangi is emri alanlarini yazabilecegi ayrica routes.js'te zorlanir.
 */
const OPERATOR_PLANNING = Object.freeze([
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/(?:start|finish)$/],
  // ilk onay raporu: usta tezgah basinda numara alir (elle/duzeltme/silme yoneticiye ozel)
  ['POST', /^\/api\/planning\/first-approvals$/],
  ['POST', /^\/api\/planning\/shop\/downtime-reasons$/],
  ['DELETE', /^\/api\/planning\/shop\/downtime-reasons\/\d{1,12}$/],
  // kasalar (Urun Tanitim Karti): ac / kapat / paketleme adedi / iptal ve okuma; kart numarasi sirasi tabani (PUT crates/sequence) yoneticiye ozel
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/crates$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/cards$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/fields$/],
  // olcu kontrolu (EYS.FR.005): plan, saatlik olcum girisi, kartin foyu
  ['PUT', /^\/api\/planning\/work-orders\/\d{10}\/measure-plan$/],
  ['POST', /^\/api\/planning\/work-orders\/\d{10}\/measurements$/],
  ['POST', /^\/api\/planning\/crates\/\d{1,12}\/(?:close|pack|void)$/],
  // program eslemesi: hangi torna programi hangi urunu uretiyor (ustalar bilir). Okuma + esle / kaldir / birebir onerileri onayla; urun karti DEGIL,
  // yalniz dar urun aramasi (stok kodu, ad, musteri kodu) acilir
  // paketleme formu (EYS.FR.007): vardiya sayfasi, hava basinci, satir ekle/duzelt/iptal, koli ici adet onerisi; urun kartindaki dosyayi (etiket) acma.
  // Klasorleri ayarlama / eslestirme ve dosya kaldirma yoneticiye ozel.
  ['GET', /^\/api\/planning\/packing\/(?:sheet|suggest)$/], ['PUT', /^\/api\/planning\/packing\/sheet\/air$/],
  ['POST', /^\/api\/planning\/packing\/rows$/], ['PUT', /^\/api\/planning\/packing\/rows\/\d{1,12}$/],
  ['DELETE', /^\/api\/planning\/packing\/rows\/\d{1,12}$/], ['GET', /^\/api\/planning\/product-files\/\d{1,12}$/],
  ['GET', /^\/api\/planning\/programs$/], ['GET', /^\/api\/planning\/programs\/product-search$/],
  ['PUT', /^\/api\/planning\/programs\/map$/], ['DELETE', /^\/api\/planning\/programs\/map$/], ['POST', /^\/api\/planning\/programs\/confirm-exact$/],
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

  if (m === 'GET' && VIEWER_PLANNING.some((re) => re.test(p))) return 'viewer';
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
