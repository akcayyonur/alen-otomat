import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Kurulumda KAPALI bölümler (config/features.json): henüz rafine edilmeyen Planlama bölümleri bir kuruluma girmeden kapatılır.
 * Kapalı bölüm HİÇ KİMSEYE (yönetici dahil) görünmez ve sunucu ilgili uçları 403 `section-closed` ile reddeder (backend/planning/routes.js).
 * Yeniden açmak = dosyadaki listeden çıkarıp sunucuyu yeniden başlatmak; kurulum paketinde `build-installer.ps1 -KapaliBolumler` verir
 * (varsayılan paketleme + hammadde): yani "yeni kurulumla". Depodaki dosya her şeyi AÇIK bırakır (geliştirme/demo etkilenmez).
 *
 * Hatalı dosya (bilinmeyen bölüm, yanlış yazılmış anahtar) sunucuyu BAŞLATMAZ: sessizce açık kalan bir "kapalı" bölüm en kötü hatadır.
 */

/** Kapatılabilen bölümler: anahtar = Planlama sekme anahtarı (dashboard/planning-tabs.js). */
export const CLOSABLE_SECTIONS = Object.freeze({
  paketleme: 'Planlama › Paketleme sekmesi ve kasa paketleme adedi girişi (kart basma, yeniden yazdırma, ölçü föyü ve ret çalışmaya devam eder)',
  hammadde: 'Planlama › Hammadde sekmesi: ihtiyaç, sarfiyat ve Mikro fişi uçları (iş emri ayrıntısındaki bilgi paneli kalır)',
});

const ALLOWED_KEYS = new Set(['closedSections', '_aciklama']);
const CONFIG_URL = new URL('../config/features.json', import.meta.url);

/** @returns {{closedSections: string[]}} kapalı bölümler, CLOSABLE_SECTIONS sırasında ve tekrarsız */
export function validateFeatures(cfg) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('features: dosya bir nesne olmalı ({"closedSections": [...]}).');
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(k)) throw new Error(`features: bilinmeyen anahtar "${k}" (yalnız closedSections).`);
  }
  const list = cfg.closedSections ?? [];
  if (!Array.isArray(list)) throw new Error('features: "closedSections" bir liste olmalı.');
  for (const s of list) {
    if (typeof s !== 'string' || !Object.hasOwn(CLOSABLE_SECTIONS, s)) {
      throw new Error(`features: kapatılamayan ya da bilinmeyen bölüm "${s}" (geçerli: ${Object.keys(CLOSABLE_SECTIONS).join(', ')}).`);
    }
  }
  const set = new Set(list);
  return { closedSections: Object.keys(CLOSABLE_SECTIONS).filter((k) => set.has(k)) };
}

/**
 * @param {string|URL} [file] varsayılan config/features.json; dosya yoksa her şey açık
 * @returns {{closedSections: string[]}}
 */
export function loadFeatures(file = CONFIG_URL) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  if (!existsSync(path)) return { closedSections: [] };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); // Not Defteri/PowerShell BOM yazabilir
  } catch (err) {
    throw new Error(`features: ${path} okunamadı: ${err.message}`);
  }
  return validateFeatures(cfg);
}
