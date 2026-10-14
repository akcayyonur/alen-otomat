/**
 * Bagimliliksiz CSV okuyucu (RFC 4180 + Excel'in alisikanliklari).
 *
 *  - UTF-8 (BOM'lu/BOM'suz) ya da Windows-1254 (Excel'in eski "CSV (noktali virgulle ayrilmis)" kaydi)
 *  - ayirici: noktali virgul / virgul / sekme (ilk satirdan anlasilir; `sep=;` satiri da tanınır)
 *  - tirnakli alanlar, "" kacisi, alan icinde satir sonu
 *  - TAMAMEN BOS satirlar atlanir: Excel, kullanilan alani bicimlendirilmis bir sayfayi (ör. 1 milyon satir) bos satirlarla
 *    dışa aktarabilir; bunlar yuklemeyi sismirmez.
 */

/** Bayt dizisini metne cevirir: gecerli UTF-8 ise UTF-8, degilse Windows-1254 (Turkce). */
export function decodeCsv(buffer) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1254').decode(buffer), encoding: 'windows-1254' };
  }
}

function detectDelimiter(text) {
  const end = text.search(/[\r\n]/);
  const first = end === -1 ? text : text.slice(0, end);
  const count = (ch) => first.split(ch).length - 1;
  const scores = [[';', count(';')], [',', count(',')], ['\t', count('\t')]];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ';';
}

/**
 * @param {string} input
 * @returns {{delimiter: string, headers: string[], rows: string[][]}} `rows` baslik haric, bos satirlar atilmis
 */
export function parseCsv(input) {
  let s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let delimiter = null;
  const sep = /^sep=(.)\r?\n/i.exec(s);
  if (sep) {
    delimiter = sep[1];
    s = s.slice(sep[0].length);
  }
  delimiter ??= detectDelimiter(s);

  /** @type {string[][]} */
  const all = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const flushRow = () => {
    row.push(field);
    field = '';
    // Tamamen bos satir (yalniz ayiricilar) atlanir.
    if (!row.every((v) => v.trim() === '')) all.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      flushRow();
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length > 0) flushRow();

  const [headers = [], ...rows] = all;
  return { delimiter, headers: headers.map((h) => h.trim()), rows };
}
