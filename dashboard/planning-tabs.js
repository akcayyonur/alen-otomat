/**
 * Planlama sekmelerinin ROL tablosu (tarayıcıdan bağımsız, testli: backend/apps.test.js). Hangi rol hangi sekmeyi görür?
 * Yetkiyi sunucu verir (backend/auth/policy.js); bu tablo yalnız menüyü ve açılış sekmesini belirler.
 *
 *   yönetici  hepsi
 *   operatör  fabrika PC'si: Tezgah başı, Paketleme, İş emirleri (YALNIZ okur: liste + form), GKK rapor no (okur), İlk onay raporu (numara alır), Ölçü raporları (okur),
 *             Program eşleme (okur + eşler)
 *   izleyici  Tezgah başı, İş emirleri, GKK rapor no, İlk onay raporu, Ölçü raporları: hepsi YALNIZ OKUMA
 */
const ALL = Object.freeze(['admin', 'operator', 'viewer']);

export const TAB_ROLES = Object.freeze({
  tezgahbasi: ALL,
  paketleme: Object.freeze(['admin', 'operator']),
  isemirleri: ALL,
  gkk: ALL,
  ilkonay: ALL,
  olcuraporlari: ALL,
  verimlilik: Object.freeze(['admin']),
  hammadde: Object.freeze(['admin']),
  urunler: Object.freeze(['admin']),
  siparisler: Object.freeze(['admin']),
  programlar: Object.freeze(['admin', 'operator']),
});

/** Menüdeki sıra. */
export const TAB_ORDER = Object.freeze(Object.keys(TAB_ROLES));

/** @param {string} role @param {string[]} [closed] bu kurulumda kapali bolumler (config/features.json): kimse (yonetici dahil) gormez */
export const tabsForRole = (role, closed = []) => TAB_ORDER.filter((k) => TAB_ROLES[k].includes(role) && !closed.includes(k));

/** Girişte açılan sekme: yönetici iş emirlerini, diğerleri tezgah başını görür. */
export const defaultTabFor = (role) => (role === 'admin' ? 'isemirleri' : 'tezgahbasi');
