import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Duruş nedeni kodları (config/downtime-codes.json): bugünkü Excel'in D1–D46 ve Z1–Z4 listesi. Planlama modülü açılışta bunu
 * veritabanıyla eşitler (kod silinmez, kaldırılan kod pasifleşir: eski kayıtlar bağlı kalır). Hatalı dosya sunucuyu BAŞLATMAZ.
 */
const CONFIG_URL = new URL('../config/downtime-codes.json', import.meta.url);
const KINDS = new Set(['D', 'Z']);

/** @returns {{groups: {id: string, label: string}[], codes: {code: string, name: string, group: string, kind: 'D'|'Z', frequent: boolean}[]}} */
export function validateDowntimeConfig(cfg) {
  const groups = cfg?.groups;
  const codes = cfg?.codes;
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('downtime-codes: "groups" listesi yok.');
  if (!Array.isArray(codes) || codes.length === 0) throw new Error('downtime-codes: "codes" listesi yok.');
  const groupIds = new Set();
  for (const g of groups) {
    if (!g?.id || !g?.label) throw new Error('downtime-codes: her grubun id ve label alanı olmalı.');
    if (groupIds.has(g.id)) throw new Error(`downtime-codes: grup tekrarı: ${g.id}`);
    groupIds.add(g.id);
  }
  const seen = new Set();
  for (const c of codes) {
    if (!/^[DZ]\d{1,3}$/.test(String(c?.code ?? ''))) throw new Error(`downtime-codes: geçersiz kod: ${c?.code}`);
    if (seen.has(c.code)) throw new Error(`downtime-codes: kod tekrarı: ${c.code}`);
    seen.add(c.code);
    if (!String(c.name ?? '').trim()) throw new Error(`downtime-codes: ${c.code} için ad yok.`);
    if (!groupIds.has(c.group)) throw new Error(`downtime-codes: ${c.code} bilinmeyen grupta: ${c.group}`);
    if (!KINDS.has(c.kind)) throw new Error(`downtime-codes: ${c.code} türü D ya da Z olmalı.`);
    if (c.code[0] !== c.kind) throw new Error(`downtime-codes: ${c.code} kodu ile türü (${c.kind}) uyuşmuyor.`);
  }
  return {
    groups: groups.map((g) => ({ id: g.id, label: g.label })),
    codes: codes.map((c) => ({ code: c.code, name: String(c.name).trim(), group: c.group, kind: c.kind, frequent: c.frequent === true })),
  };
}

let cache = null;

export function loadDowntimeCodes() {
  if (!cache) cache = validateDowntimeConfig(JSON.parse(readFileSync(fileURLToPath(CONFIG_URL), 'utf8')));
  return cache;
}
