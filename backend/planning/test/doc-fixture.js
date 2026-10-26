/**
 * Test icin kucuk belge URETICILERI (depo herkese acik: gercek veri yok): gecerli en kucuk PDF ve minimal .docx.
 * Kurulum paketine GIRMEZ (build-installer.ps1 backend/planning/test klasorunu siler).
 */
import { zipOf } from './xlsx-fixture.js';

/** En kucuk gecerli PDF: her sayfada bir etiket (ayni etiket = ayni icerik, farkli etiket = farkli SHA). */
export function pdf(...labels) {
  const n = labels.length;
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = `<</Type /Pages /Kids [${labels.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>`;
  objs[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>';
  labels.forEach((l, i) => {
    objs[4 + i * 2] = `<</Type /Page /Parent 2 0 R /Contents ${5 + i * 2} 0 R>>`;
    const c = `BT /F1 24 Tf 72 700 Td (${l}) Tj ET`;
    objs[5 + i * 2] = `<</Length ${c.length}>>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) { offs[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Minimal .docx: her parca AYRI calisma (<w:r>) olarak yazilir, yani kod ("SR002" + ".0" + "13") Word'deki gibi parcalara bolunmus olur. */
export function docx(...runs) {
  const body = `<w:p>${runs.map((t) => `<w:r><w:t>${t}</w:t></w:r>`).join('')}</w:p>`;
  return zipOf({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}
