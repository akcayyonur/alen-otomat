import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Makine envanteri (CNC-TLM-001 Bolum 03A). Saha bilgisi netlestikce
 * guncellenecek TEK yer burasi - simulator de backend de bunu okur.
 */
const CONFIG_URL = new URL('../config/machines.json', import.meta.url);

export function loadInventory() {
  const raw = readFileSync(fileURLToPath(CONFIG_URL), 'utf8');
  const list = JSON.parse(raw);
  return list.map((m) => ({ ...m, reports: [...m.reports] }));
}
