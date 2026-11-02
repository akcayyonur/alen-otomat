/**
 * Rol sisteminin TEK kaynagi: hangi ekranlar var, hangi uygulamaya ait, ve admin-disi bir role "Yazabilir"
 * verilebilir mi. Rol kutularinin (Ayarlar > Roller), politika motorunun (backend/auth/policy.js) ve istemci
 * tarafi sekme filtrelemesinin (dashboard/apps.js, planning-tabs.js) HEPSI buradan okur.
 *
 * writable:false olan ekranlarda (isemirleri, olcuraporlari) "Yazabilir" SECENEGI BILE SUNULMAZ: is emirleri
 * ekraninin admin disinda ASLA yazilabilir olmamasi (kullanici karari, 2026-10-30) boylece yapisal olarak
 * garanti edilir - policy.js'te bu ekranlar icin hic 'write' rotasi KAYITLI DEGILDIR.
 */
export const SCREENS = Object.freeze([
  { id: 'telemetri', label: 'Telemetri', app: 'telemetri', writable: false },
  { id: 'tezgahbasi', label: 'Tezgah başı', app: 'planlama', writable: true },
  { id: 'paketleme', label: 'Paketleme', app: 'planlama', writable: true },
  { id: 'isemirleri', label: 'İş emirleri', app: 'planlama', writable: false },
  { id: 'gkk', label: 'GKK rapor no', app: 'planlama', writable: true },
  { id: 'ilkonay', label: 'İlk onay raporu', app: 'planlama', writable: true },
  { id: 'olcuraporlari', label: 'Ölçü raporları', app: 'planlama', writable: false },
  { id: 'programlar', label: 'Program eşleme', app: 'planlama', writable: true },
  { id: 'urunler', label: 'Ürün kartları', app: 'planlama', writable: true },
  { id: 'siparisler', label: 'Siparişler', app: 'planlama', writable: false }, // yalniz Excel/Mikro'dan gelir, elle satır yazma yok
  { id: 'hammadde', label: 'Hammadde', app: 'planlama', writable: true },
  { id: 'verimlilik', label: 'Verimlilik', app: 'planlama', writable: false }, // rapor; öneri "ürünler" ekranına yazar
  { id: 'cizelgeleme', label: 'Çizelgeleme', app: 'planlama', writable: true },
  { id: 'fiyat', label: 'Fiyat çalışması', app: 'planlama', writable: true },
]);

const BY_ID = new Map(SCREENS.map((s) => [s.id, s]));
export const SCREEN_IDS = Object.freeze(SCREENS.map((s) => s.id));
export const screenById = (id) => BY_ID.get(id) ?? null;
export const isWritable = (id) => BY_ID.get(id)?.writable === true;
export const PLANNING_SCREENS = Object.freeze(SCREENS.filter((s) => s.app === 'planlama'));

/**
 * `grants` nesnesini (ör. {tezgahbasi:'write', gkk:'read'}) doğrular; sorun yoksa null, varsa mesaj.
 * Bilinmeyen ekran id'si ya da `'write'` verilmiş writable:false ekran REDDEDİLİR.
 * @param {Record<string, string>} grants
 */
export function validateGrants(grants) {
  if (grants === null || typeof grants !== 'object' || Array.isArray(grants)) return 'Yetkiler bir nesne olmalı.';
  for (const [id, level] of Object.entries(grants)) {
    const s = screenById(id);
    if (!s) return `Bilinmeyen ekran: ${id}`;
    if (level !== 'read' && level !== 'write') return `${s.label}: yetki "read" ya da "write" olmalı.`;
    if (level === 'write' && !s.writable) return `${s.label} ekranı her zaman salt okunurdur: "Yazabilir" verilemez.`;
  }
  return null;
}
