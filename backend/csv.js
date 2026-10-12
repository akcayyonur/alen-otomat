/**
 * Turkce Excel uyumlu CSV: UTF-8 BOM + `sep=;` + noktali virgul + ondalik virgul.
 * Tezgah ham dokumu, kompakt dokum ve uretim raporlari ayni bicimi kullanir.
 */

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  // Ondalik ayirici virgul - Turkce Excel sayiyi boyle tanir.
  const text = typeof value === 'number' ? String(value).replace('.', ',') : String(value);
  return /[";\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** @param {string[]} headers @param {unknown[][]} rows */
export function csvDocument(headers, rows) {
  const lines = ['sep=;', headers.join(';')];
  for (const row of rows) lines.push(row.map(csvCell).join(';'));
  // BOM: Excel dosyayi UTF-8 olarak acsin, Turkce karakterler bozulmasin.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
