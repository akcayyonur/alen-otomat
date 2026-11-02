/**
 * Hangi uc kime acik? SAF islev (HTTP'siz), test edilir. Kural: VARSAYILAN REDDET.
 *
 *   public   giris gerektirmez (statik dosyalar, oturum/giris uclari, saglik)
 *   local    yalniz sunucu bilgisayarindan (ajan -> ingest, ajanin tezgah listesi)
 *   viewer   giris yapmis herhangi biri: yalniz izleme (telemetri + VIEWER_READ'teki okumalar) - admin-disi
 *            rol sistemi ONCESINDEN kalan, HERKESE acik (giris yapmis olmak yeterli) salt-okunur bir taban.
 *   {screen, level}  bir EKRANA (shared/screens.js) bagli rota: kullanicinin o ekranda 'read' ya da 'write'
 *            yetkisi olmali (grants); 'write' route'u hic kayitli olmayan ekran (isemirleri, olcuraporlari)
 *            YAPISAL OLARAK asla yazilabilir olamaz.
 *   admin    yalniz yonetici (is_admin=1)
 *
 * Listede acikca yazmayan her /api yolu admin'dir: yarin eklenen bir uc, siz haberdar olmadan baska role
 * acilmaz.
 */

/** GET /api/machines/<id> ve yalniz bu alt yollar izleme verisidir. Programlar/klasorler DEGIL. */
const VIEWER_MACHINE = /^\/api\/machines\/[^/]+(?:\/(?:history|spans|summary|downtimes|export\.csv))?$/;

/**
 * Giris yapmis HERKESE (yetkisiz/rolsuz dahil) acik salt-okunur telemetri izleme uclari. Bir rolun/admin'in
 * ekran yetkisine BAGLI DEGILDIR - ayrica "telemetri" ekran yetkisi (SCREENS[].app==='telemetri') arayuzde
 * Telemetri uygulamasinin GORUNUP GORUNMEDIGINI belirler (apps.js), sunucu tarafinda bu temel okumalari
 * kapatmaz (eski "viewer" rolunun davranisiyla birebir ayni, geriye donuk uyumluluk).
 */
const VIEWER_READ = Object.freeze([
  [['GET'], /^\/api\/(stream|machines)$/],
  [['GET'], /^\/api\/production(?:\/export\.csv|\/runs(?:\.csv)?)?$/],
  [['GET'], /^\/api\/planning\/summary$/],
]);

/**
 * Ekrana bagli uclar: her satir [methods[], regex, screenId, level]. `level:'write'` olan bir rotanin ekrani
 * shared/screens.js'te writable:false ise bu BIR HATADIR (validateScreenRoutes testle sinanir) - ama isemirleri
 * ve olcuraporlari icin hic yazma rotasi asagida KAYITLI DEGIL, yani bu hata siniifi zaten olusmaz.
 */
export const SCREEN_ROUTES = Object.freeze([
  // tezgah basi (fabrika PC'si): is emri baslat/bitir, olcu kontrolu, is emri alani duzenleme, kasa/kart
  // NOT: reassign-machine (Tezgahi duzelt) burada DEGIL - finish-manual gibi kayitsiz birakilip admin'e duser (bkz. asagidaki "is emirleri" grubu).
  [['POST'], /^\/api\/planning\/work-orders\/\d{10}\/(?:start|finish)$/, 'tezgahbasi', 'write'],
  [['POST'], /^\/api\/planning\/work-orders\/\d{10}\/fields$/, 'tezgahbasi', 'write'],
  [['PUT'], /^\/api\/planning\/work-orders\/\d{10}\/measure-plan$/, 'tezgahbasi', 'write'],
  [['POST'], /^\/api\/planning\/work-orders\/\d{10}\/measurements$/, 'tezgahbasi', 'write'],
  [['POST'], /^\/api\/planning\/work-orders\/\d{10}\/crates$/, 'tezgahbasi', 'write'],
  [['POST'], /^\/api\/planning\/work-orders\/\d{10}\/cards$/, 'tezgahbasi', 'write'],
  [['POST'], /^\/api\/planning\/shop\/downtime-reasons$/, 'tezgahbasi', 'write'],
  [['DELETE'], /^\/api\/planning\/shop\/downtime-reasons\/\d{1,12}$/, 'tezgahbasi', 'write'],
  [['GET'], /^\/api\/planning\/downtime-codes$/, 'tezgahbasi', 'read'],
  [['GET'], /^\/api\/planning\/shop\/(?:overview|stops)$/, 'tezgahbasi', 'read'],
  [['GET'], /^\/api\/planning\/crates(?:\/\d{1,12})?$/, 'tezgahbasi', 'read'],
  [['POST'], /^\/api\/planning\/crates\/\d{1,12}\/(?:close|void)$/, 'tezgahbasi', 'write'],
  [['GET'], /^\/api\/planning\/crates\/\d{1,12}\/sheet$/, 'tezgahbasi', 'read'],
  [['GET'], /^\/api\/planning\/work-orders\/\d{10}\/measurements$/, 'tezgahbasi', 'read'],

  // paketleme formu (EYS.FR.007)
  [['GET'], /^\/api\/planning\/packing\/(?:sheet|suggest)$/, 'paketleme', 'read'],
  [['PUT'], /^\/api\/planning\/packing\/sheet\/air$/, 'paketleme', 'write'],
  [['POST'], /^\/api\/planning\/packing\/rows$/, 'paketleme', 'write'],
  [['PUT'], /^\/api\/planning\/packing\/rows\/\d{1,12}$/, 'paketleme', 'write'],
  [['DELETE'], /^\/api\/planning\/packing\/rows\/\d{1,12}$/, 'paketleme', 'write'],
  [['POST'], /^\/api\/planning\/crates\/\d{1,12}\/pack$/, 'paketleme', 'write'],
  [['GET'], /^\/api\/planning\/product-files\/\d{1,12}$/, 'paketleme', 'read'],

  // is emirleri: HER ZAMAN salt okunur (hic 'write' rotasi yok - yapisal istisna)
  [['GET'], /^\/api\/planning\/work-orders$/, 'isemirleri', 'read'],
  [['GET'], /^\/api\/planning\/work-orders\/\d{10}$/, 'isemirleri', 'read'],
  [['GET'], /^\/api\/planning\/work-orders\/\d{10}\/(?:drawings\.pdf|print\.pdf)$/, 'isemirleri', 'read'],

  // GKK rapor numaralari (EYS.FR.011): okuma herkese (asagida), usta yeni numara ALABILIR
  [['GET'], /^\/api\/planning\/gkk$/, 'gkk', 'read'],
  [['POST'], /^\/api\/planning\/gkk$/, 'gkk', 'write'],

  // ilk onay raporu (EYS.FR.013): okuma herkese, usta is emrinden numara ALABILIR (elle kayit/duzelt/sil/taban yonetici)
  [['GET'], /^\/api\/planning\/first-approvals$/, 'ilkonay', 'read'],
  [['POST'], /^\/api\/planning\/first-approvals$/, 'ilkonay', 'write'],

  // olcu raporlari: HER ZAMAN salt okunur (girisler tezgah basindan / `tezgahbasi` ekranindan yapilir)
  [['GET'], /^\/api\/planning\/measure-reports$/, 'olcuraporlari', 'read'],
  [['GET'], /^\/api\/planning\/work-orders\/\d{10}\/measure-report$/, 'olcuraporlari', 'read'],

  // program eslemesi: hangi torna programi hangi urunu uretiyor (ustalar bilir); urun karti DEGIL, dar arama
  [['GET'], /^\/api\/planning\/programs$/, 'programlar', 'read'],
  [['GET'], /^\/api\/planning\/programs\/product-search$/, 'programlar', 'read'],
  [['PUT'], /^\/api\/planning\/programs\/map$/, 'programlar', 'write'],
  [['DELETE'], /^\/api\/planning\/programs\/map$/, 'programlar', 'write'],
  [['POST'], /^\/api\/planning\/programs\/confirm-exact$/, 'programlar', 'write'],

  // urun kartlari / siparisler / hammadde / verimlilik / cizelgeleme: admin-disi roller icin okuma/yazma secilebilir ekranlar
  [['GET'], /^\/api\/planning\/products$/, 'urunler', 'read'],
  [['POST'], /^\/api\/planning\/products$/, 'urunler', 'write'],
  [['GET'], /^\/api\/planning\/products\/[^/]+$/, 'urunler', 'read'],
  [['PUT'], /^\/api\/planning\/products\/[^/]+$/, 'urunler', 'write'],
  [['PUT'], /^\/api\/planning\/products\/[^/]+\/measure-plan$/, 'urunler', 'write'],
  [['GET'], /^\/api\/planning\/orders$/, 'siparisler', 'read'],
  [['GET'], /^\/api\/planning\/orders\/lines$/, 'siparisler', 'read'],
  [['GET'], /^\/api\/planning\/material(?:\/.*)?$/, 'hammadde', 'read'],
  [['POST'], /^\/api\/planning\/material\/mikro\/(?:transfer|virman)-preview$/, 'hammadde', 'read'],
  [['POST'], /^\/api\/planning\/material\/fis(?:\/undo)?$/, 'hammadde', 'write'],
  [['POST'], /^\/api\/planning\/material\/mikro\/(?:transfer|virman)-send$/, 'hammadde', 'write'],
  [['GET'], /^\/api\/planning\/efficiency(?:\.csv)?$/, 'verimlilik', 'read'],
  [['GET'], /^\/api\/planning\/downtime-report(?:\.csv)?$/, 'verimlilik', 'read'],
  [['POST'], /^\/api\/planning\/schedule\/apply$/, 'cizelgeleme', 'write'],

  // fiyat calismasi: urun karti acilmadan onceki on calisma - olusturma/silme (teknik resim yukleme) HER ZAMAN admin (kayitsiz birakilir)
  [['GET'], /^\/api\/planning\/price-studies$/, 'fiyat', 'read'],
  [['GET'], /^\/api\/planning\/price-studies\/\d{1,12}(?:\/drawing\.pdf)?$/, 'fiyat', 'read'],
  [['PUT'], /^\/api\/planning\/price-studies\/\d{1,12}\/fill$/, 'fiyat', 'write'],
]);

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {'public'|'local'|'viewer'|'admin'|{screen: string, level: 'read'|'write'}}
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
  if (m === 'POST' && p === '/api/planning/schedule/suggest') return { screen: 'cizelgeleme', level: 'read' };
  if (VIEWER_READ.some(([methods, re]) => methods.includes(m) && re.test(p)) || (m === 'GET' && VIEWER_MACHINE.test(p))) return 'viewer';

  const hit = SCREEN_ROUTES.find(([methods, re]) => methods.includes(m) && re.test(p));
  if (hit) return { screen: hit[2], level: hit[3] };

  return 'admin';
}

/** Viewer'a gonderilmeyecek alanlar (tezgahin ag ayrintilari). */
const HIDDEN_FOR_VIEWER = ['ip', 'ftpPort', 'port'];

/** Tezgah nesnesinin admin-disi kullanicilar icin kopyasi: IP/port gibi ic ag bilgileri cikarilir. */
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
