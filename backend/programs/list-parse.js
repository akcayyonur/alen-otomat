/**
 * FTP LIST ciktisi cozumleyici.
 *
 * Syntec'in Windows CE FTP sunucusu DOS bicimi verir (gercek torna 8, 2026-10-07):
 *   10-07-26  08:19                   22 MDIBlock
 *   01-12-26  15:18       <DIR>          M-TEKNIK
 * UNIX bicimi de (drwxr-xr-x ...) desteklenir: baska bir tezgah/sunucu gelirse
 * cozumleyici degismeden calissin.
 *
 * Zaman sunucunun YEREL saatidir, saat dilimi bilinmez: "YYYY-MM-DD HH:MM" metni
 * olarak tutulur, Date'e cevrilmez. (Gercek tornada API'nin verdigi dosya zamani
 * bozuk cikti; FTP'ninki gecerli. Yine de kimlik/karsilastirma icin zamana
 * guvenilmez, SHA-256'ya guvenilir.)
 */

const DOS =
  /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})\s*([AP]M)?\s+(<DIR>|[\d,]+)\s+(.+?)\s*$/i;
const UNIX =
  /^([-dl])[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}|\d{1,2}:\d{2})\s+(.+?)\s*$/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n) => String(n).padStart(2, '0');

function fullYear(y) {
  const n = Number(y);
  if (y.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

function parseDosLine(line) {
  const m = DOS.exec(line);
  if (!m) return null;
  let hour = Number(m[4]);
  if (m[6]) {
    const pm = m[6].toUpperCase() === 'PM';
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const isDir = m[7].toUpperCase() === '<DIR>';
  return {
    name: m[8],
    isDir,
    size: isDir ? null : Number(m[7].replaceAll(',', '')),
    modified: `${fullYear(m[3])}-${m[1]}-${m[2]} ${pad(hour)}:${m[5]}`,
  };
}

function parseUnixLine(line) {
  const m = UNIX.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[3].toLowerCase()) + 1;
  if (month === 0) return null;
  const isTime = m[5].includes(':');
  const year = isTime ? new Date().getFullYear() : Number(m[5]);
  return {
    name: m[6],
    isDir: m[1] === 'd',
    size: m[1] === 'd' ? null : Number(m[2]),
    modified: `${year}-${pad(month)}-${pad(Number(m[4]))} ${isTime ? m[5].padStart(5, '0') : '00:00'}`,
  };
}

/**
 * @param {string} text LIST yaniti (CRLF ya da LF ayirici)
 * @returns {{entries: {name:string,isDir:boolean,size:number|null,modified:string}[], unparsed: string[]}}
 */
export function parseList(text) {
  const entries = [];
  const unparsed = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    if (/^total\s+\d+/i.test(line)) continue; // UNIX "total 12" basligi
    const entry = parseDosLine(line) ?? parseUnixLine(line);
    if (!entry) {
      unparsed.push(line);
      continue;
    }
    if (entry.name === '.' || entry.name === '..') continue;
    entries.push(entry);
  }
  return { entries, unparsed };
}
