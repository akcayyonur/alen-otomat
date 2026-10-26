/**
 * Program kutuphanesi ekranlarinin ORTAK yardimcilari (kutuphane ekrani, program editoru,
 * klasor penceresi). Yalniz bir yerde tanimli olsun diye ayrildi; ekranlar birbirini import etmez.
 */
import { escapeHtml, num } from './format.js';
import { getSession, authDisabled } from './auth-view.js';

export const kb = (n) => (n == null ? '—' : n < 1024 ? `${num(n)} bayt` : `${num(n / 1024, 1)} KB`);
export const folderLabel = (c) => (c === '' ? 'Kök (ortak alan)' : c);
export const programLabel = (customer, name) => `${customer === '' ? '' : `${customer}\\`}${name}`;

export class ApiError extends Error {
  /** @param {string} message @param {number} status @param {string|null} [code] sunucunun makine-okunur nedeni */
  constructor(message, status, code = null) { super(message); this.status = status; this.code = code; }
}

export async function api(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(`Sunucuya ulaşılamadı: ${err.message}`, 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Hata (HTTP ${res.status})`, res.status, body.code ?? null);
  return body;
}

export const post = (path, obj) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });

/** Giris yapmis kullanicinin adi (giris sistemi aciksa); yoksa null. Sunucu da islemi yapani oturumdan alir. */
const sessionUser = () => (authDisabled() ? null : (getSession()?.user?.username ?? null));

/** "Adiniz" alanlarina eklenir: giris varsa ad sabittir (kayda oturumdaki kullanici adi yazilir). */
export const byLocked = () => (sessionUser() ? ' readonly title="Giriş yapan kullanıcı adıyla kaydedilir"' : '');

export const userName = {
  get() { return sessionUser() ?? (() => { try { return localStorage.getItem('cnc-user') ?? ''; } catch { return ''; } })(); },
  set(v) { try { localStorage.setItem('cnc-user', v); } catch { /* gizli sekme */ } },
};

/** Bir gonderme/tarama/klasor acma/kayit bitince (baska ekranlardan da) listeler tazelensin. */
export const CHANGED = 'cnc:programs-changed';
export const announce = () => document.dispatchEvent(new CustomEvent(CHANGED));

/** Denetim kaydindaki adimlarin Turkce adlari (gonderme + klasor acma). */
export const STEP_LABEL = Object.freeze({
  'on-kontrol': 'Ön kontrol',
  yukle: 'Geçici adla yükleme',
  'boyut-dogrula': 'Boyut doğrulama',
  'geri-oku-sha': 'Geri okuma ve SHA-256',
  'nihai-ada-cevir': 'Nihai ada çevirme',
  'son-dogrulama': 'Son doğrulama',
  'ayni-mi': 'İçerik karşılaştırma',
  yedek: 'Tornadaki eski hâli yedekleme',
  'yedek-temizle': 'Yan adlı eski dosyayı silme',
  'geri-al': 'Geri alma (eski hâl yerine konuldu)',
  sonuc: 'Sonuç',
  temizlik: 'Temizlik',
  'klasor-ac': 'Klasörü açma (MKD)',
  'klasor-dogrula': 'Klasörü doğrulama',
  silme: 'Tornadan silme (DELE)',
  'silme-dogrula': 'Silindiğini doğrulama',
});

export const TRANSFER_STATUS = Object.freeze({
  basarili: { icon: '✓', label: 'Başarılı', cls: 'ok' },
  reddedildi: { icon: '✕', label: 'Yapılmadı (ön kontrol)', cls: 'bad' },
  basarisiz: { icon: '✕', label: 'Başarısız', cls: 'bad' },
  dogrulanamadi: { icon: '▲', label: 'Doğrulanamadı', cls: 'warn' },
  basladi: { icon: '…', label: 'Sürüyor', cls: 'info' },
});

/** Adim tablosu (sonuc ekranlarinda ortak). */
export function stepsTable(steps) {
  return '<h4 class="sub">Adımlar</h4><table class="tbl"><thead><tr><th>Adım</th><th>Sonuç</th><th class="num">Süre</th><th>Ayrıntı</th></tr></thead><tbody>' +
    steps.map((x) => `<tr><td>${escapeHtml(STEP_LABEL[x.step] ?? x.step)}</td>` +
      `<td><span class="chip chip-${x.ok ? 'ok' : 'bad'}"><span aria-hidden="true">${x.ok ? '✓' : '≠'}</span> ${x.ok ? 'tamam' : 'hata'}</span></td>` +
      `<td class="num">${num(x.ms)} ms</td><td class="mono">${escapeHtml(x.detail ?? '')}</td></tr>`).join('') +
    '</tbody></table>';
}
