/**
 * Uygulama secimi: giristen sonra kullanici hangi uygulamayi acacagini secer.
 * Iki uygulama birbirinden ayridir (menu, ust cubuk, adresler ayri):
 *   - CNC Telemetri: canli tezgah izleme, uretim raporu, program kutuphanesi, ayarlar
 *   - Planlama: is emri, siparis, urun karti, program esleme (sonra hammadde ve verimlilik)
 * Hangi rolun hangi uygulamayi gorecegi BURADA yalniz kolaylik icindir; yetkiyi sunucu verir (backend/auth/policy.js).
 * Birden cok uygulamasi olmayan kullanici (operator: yalniz Planlama) secim ekranini hic gormez; izleyici artik ikisini de gorur (Planlama'da yalniz okur),
 * dogrudan kendi uygulamasina girer.
 * Bu dosya baska dashboard modullerini import etmez (dongu olmasin).
 */
import { escapeHtml } from './format.js';

/** @type {ReadonlyArray<{key: string, title: string, desc: string, entry: string, roles: string[], icon: string}>} */
export const APPS = Object.freeze([
  {
    key: 'telemetri',
    title: 'CNC Telemetri',
    desc: 'Tezgahları canlı izleyin: durum, mil, parça sayacı, duruşlar. Üretim raporu, program kütüphanesi ve ayarlar.',
    entry: '#/filo',
    roles: ['admin', 'viewer'],
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" stroke-width="3"/>' +
      '<path d="M10 28h7l4-10 6 16 4-10h7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    key: 'planlama',
    title: 'Planlama',
    desc: 'İş emri, sipariş ve ürün kartı; tezgah başı: iş emri başlat/bitir ve duruş nedenleri; GKK rapor numaraları, ilk onay raporu, ölçü raporları, hammadde ve verimlilik. İzleyici hesap: tezgah başı, iş emirleri, GKK, ilk onay ve ölçü raporlarını yalnız okur.',
    entry: '#/planlama',
    roles: ['admin', 'operator', 'viewer'],
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="9" y="7" width="30" height="35" rx="4" fill="none" stroke="currentColor" stroke-width="3"/>' +
      '<path d="M17 7V5h14v2M16 19l3 3 5-6M16 31l3 3 5-6M28 20h6M28 32h6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
]);

/** Rolun acabilecegi uygulamalar (secim ekraninda gorunenler). */
export const appsFor = (role) => APPS.filter((a) => a.roles.includes(role));

/** @param {HTMLElement} host @param {typeof APPS[number][]} apps @param {{username: string}|undefined} user */
export function renderApps(host, apps, user) {
  host.innerHTML =
    `<p class="apps-hello">${user ? `Merhaba <b>${escapeHtml(user.username)}</b>. ` : ''}Hangi uygulamayı açmak istiyorsunuz?</p>` +
    `<div class="apps-grid">${apps.map((a) =>
      `<a class="app-tile" href="${a.entry}" data-app="${a.key}"><span class="app-icon">${a.icon}</span>` +
      `<h2>${escapeHtml(a.title)}</h2><p>${escapeHtml(a.desc)}</p><span class="app-go">Aç →</span></a>`).join('')}</div>`;
  host.querySelector('.app-tile')?.focus();
}
