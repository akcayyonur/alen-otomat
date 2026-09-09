import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Makine envanteri (CNC-TLM-001 Bolum 03A). Saha bilgisi netlestikce
 * guncellenecek TEK yer burasi - simulator de backend de bunu okur.
 *
 * Filo tek tip oldugu icin ortak alanlar `defaults` altinda tutulur; her tezgah
 * yalnizca kendi kimligini (id, ad, seri no) tasir ve gerekirse defaults'u ezer.
 */
const CONFIG_URL = new URL('../config/machines.json', import.meta.url);

/** `_` ile baslayan alanlar dosya ici aciklamalar - koda tasinmaz. */
function stripNotes(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !key.startsWith('_')));
}

export function loadInventory() {
  const raw = readFileSync(fileURLToPath(CONFIG_URL), 'utf8');
  const { defaults = {}, machines } = JSON.parse(raw);
  const shared = stripNotes(defaults);

  return machines.map((machine) => {
    const merged = { ...shared, ...stripNotes(machine) };
    return { ...merged, reports: [...merged.reports] };
  });
}
