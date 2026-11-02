/**
 * Ekran listesinin istemci tarafi KOPYASI. Tek gercek kaynak `shared/screens.js`tir ama tarayici statik
 * sunumdan (dashboard/ duz) "/shared/*.js" dosyalarini cekemez; bu yuzden ayni liste burada tekrarlanir.
 * Degisirse IKISI BIRDEN guncellenir (backend/apps.test.js ikisinin ayni oldugunu sinar).
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
  { id: 'siparisler', label: 'Siparişler', app: 'planlama', writable: false },
  { id: 'hammadde', label: 'Hammadde', app: 'planlama', writable: true },
  { id: 'verimlilik', label: 'Verimlilik', app: 'planlama', writable: false },
  { id: 'cizelgeleme', label: 'Çizelgeleme', app: 'planlama', writable: true },
  { id: 'fiyat', label: 'Fiyat çalışması', app: 'planlama', writable: true },
]);

export const PLANNING_SCREENS = Object.freeze(SCREENS.filter((s) => s.app === 'planlama'));
