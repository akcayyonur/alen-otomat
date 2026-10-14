/**
 * Tornadaki program adi -> urun (stok kodu) eslemesi icin ONERI kurallari.
 *
 * Gercek verilerde gorulen iki adlandirma:
 *   1. Stok koduna gore:      SR001-013  ->  SR001.013   (tire yerine nokta; Turkce harf farki: NI002-001 = Nİ002.001)
 *   2. Musteri urun koduna gore: 140100187 (programin adi musterinin urun kodu)
 *   3. Urun adi bu kodla basliyorsa ("600000000001 TEST NİPEL ...", musteri kodu karta girilmemisse): ONERI, daha zayif kanit.
 * Bunlarin disinda kalan adlar (ör. ortak alt programlar) otomatik eslenmez; elle secilir.
 * Oneri HICBIR ZAMAN kendiliginden uygulanmaz: kullanici onaylar.
 */
import { foldTr } from './normalize.js';

const CODE_LIKE = /^([A-Z]{2})(\d{3})[-_. ](\d{3})$/;

/** Esleme anahtari: buyuk/kucuk harf ve Turkce harf duyarsiz (tornanin dosya sistemi de buyuk/kucuk duyarsiz). */
export const programKey = (name) => foldTr(name);

/**
 * @param {string} programName
 * @param {{productByCodeKey: (key: string) => (object|null), productsByCustomerCode: (code: string) => object[],
 *          productsByNamePrefix?: (prefix: string) => object[]}} lookup
 * @returns {{kind: 'kod'|'musteri-kodu'|'ad'|null, candidates: object[]}}
 */
export function suggestProducts(programName, lookup) {
  const m = CODE_LIKE.exec(foldTr(programName));
  if (m) {
    const p = lookup.productByCodeKey(`${m[1]}${m[2]}.${m[3]}`);
    if (p) return { kind: 'kod', candidates: [p] };
  }
  const name = String(programName ?? '').trim();
  const byCustomer = lookup.productsByCustomerCode(name);
  if (byCustomer.length > 0) return { kind: 'musteri-kodu', candidates: byCustomer };
  // Musteri kodu karta girilmemis urunler icin: urun adi bu kodla basliyor (yalniz rakam iceren, en az 5 karakterli adlar).
  if (name.length >= 5 && /\d/.test(name) && lookup.productsByNamePrefix) {
    const byName = lookup.productsByNamePrefix(name);
    if (byName.length > 0) return { kind: 'ad', candidates: byName };
  }
  return { kind: null, candidates: [] };
}
