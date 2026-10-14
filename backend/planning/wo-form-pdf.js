/**
 * İŞ EMRİ FORMU'nun PDF sayfası (bugünkü kâğıt formun düzeni): sistemde bilinenler dolu, el ile yazılanlar boş.
 *
 * Neden PDF: formun ön sayfası ile teknik resimlerin (arka sayfa) TEK yazdırma işinde çıkması gerekir. Tarayıcı, sayfaya gömülü PDF'i
 * `window.print()` ile basmaz; bu yüzden form da PDF olarak üretilir, teknik resimlerle birleştirilir (`pdf-merge.js`) ve görüntüleyicinin
 * yazdır düğmesiyle (ya da formdaki "Yazdır" ile) bir seferde basılır. Ekranda gösterilen de bu PDF'tir: görünen = basılan.
 *
 * Bağımlılıksız: PDF elle yazılır. Yazı tipi standart Helvetica (gömülü değil); Türkçe harflerden Ç ç Ö ö Ü ü WinAnsi'de zaten vardır,
 * Ğ ğ Ş ş İ ı için yazı tipi kodlamasına Differences eklenir (iText "Cp1254" ile aynı yöntem).
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 28.35; // 10 mm
const CONTENT_W = PAGE_W - 2 * MARGIN;

/* ===================================================================== yazı tipi: kodlama ve genişlik */

/** Unicode -> PDF kodu: Türkçe'ye özgü 6 harf 128..133 (Differences), geri kalan WinAnsi. */
const TR = new Map([['Ğ', 128], ['ğ', 129], ['Ş', 130], ['ş', 131], ['İ', 132], ['ı', 133]]);
const WIN_EXTRA = new Map([['—', 0x97], ['–', 0x96], ['•', 0x95], ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['…', 0x85]]);

function codeOf(ch) {
  const t = TR.get(ch);
  if (t !== undefined) return t;
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return WIN_EXTRA.get(ch) ?? 0x3f; // desteklenmeyen karakter: "?"
}

/** Metni PDF onaltılık dizgesine çevirir (kaçış derdi yok). */
const hex = (text) => `<${Array.from(String(text), (ch) => codeOf(ch).toString(16).padStart(2, '0')).join('')}>`;

/** Helvetica / Helvetica-Bold AFM genişlikleri, kod 32..126 (1000 birim). */
const REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const BASE_OF = new Map(Object.entries({ Ç: 'C', ç: 'c', Ö: 'O', ö: 'o', Ü: 'U', ü: 'u', Ş: 'S', ş: 's', Ğ: 'G', ğ: 'g', İ: 'I', ı: 'i' }));

function glyphWidth(ch, bold) {
  const table = bold ? BOLD : REG;
  const base = BASE_OF.get(ch) ?? ch;
  const cp = base.codePointAt(0);
  const w = cp >= 32 && cp <= 126 ? table[cp - 32] : 556;
  return ch === 'ı' ? 278 : w;
}

/** Metnin punto cinsinden genişliği. */
const textWidth = (text, size, bold, spacing = 0) => {
  let w = 0;
  let n = 0;
  for (const ch of String(text)) { w += glyphWidth(ch, bold); n += 1; }
  return (w * size) / 1000 + n * spacing;
};

/** Sözcük sözcük satırlara böler (uzun sözcük karakterden bölünür). */
function wrap(text, width, size, bold) {
  const out = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (textWidth(w, size, bold) > width && w.length > 1) {
        // sözcük tek başına sığmıyor: sığan kadarını kes
        let cut = w.length - 1;
        while (cut > 1 && textWidth(w.slice(0, cut), size, bold) > width) cut -= 1;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next, size, bold) <= width) line = next;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/* ===================================================================== çizim ilkelleri */

const f2 = (n) => (Math.round(n * 100) / 100).toString();

class Canvas {
  constructor() { this.ops = []; }

  /** @param {number} x soldan @param {number} top sayfa üstünden aşağı mesafe (taban çizgisi) */
  text(x, top, str, { size = 9, bold = false, gray = 0, spacing = 0 } = {}) {
    if (str === '' || str == null) return;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${f2(size)} Tf ${f2(spacing)} Tc ${f2(gray)} g ${f2(x)} ${f2(PAGE_H - top)} Td ${hex(str)} Tj ET`);
  }

  textRight(xRight, top, str, o) { this.text(xRight - textWidth(str, o.size ?? 9, o.bold ?? false, o.spacing ?? 0), top, str, o); }

  textCenter(xMid, top, str, o) { this.text(xMid - textWidth(str, o.size ?? 9, o.bold ?? false, o.spacing ?? 0) / 2, top, str, o); }

  line(x1, t1, x2, t2, width = 0.75) {
    this.ops.push(`${f2(width)} w 0 G ${f2(x1)} ${f2(PAGE_H - t1)} m ${f2(x2)} ${f2(PAGE_H - t2)} l S`);
  }

  /** Dikdörtgen çerçeve (üst-sol köşe, genişlik, yükseklik). */
  box(x, top, w, h, width = 0.75) {
    this.ops.push(`${f2(width)} w 0 G ${f2(x)} ${f2(PAGE_H - top - h)} ${f2(w)} ${f2(h)} re S`);
  }
}

/* ===================================================================== form */

const pad2 = (n) => String(n).padStart(2, '0');
const date = (ms) => { if (!ms) return ''; const t = new Date(ms); return `${pad2(t.getDate())}.${pad2(t.getMonth() + 1)}.${t.getFullYear()}`; };
const stamp = (ms) => { const t = new Date(ms); return `${date(ms)} ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
const dayShort = (key) => { const [y, m, d] = String(key).split('-').map(Number); return `${pad2(d)}.${pad2(m)}.${y}`; };
const dec = (v, d = 2) => (v === null || v === undefined ? '' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: d }).format(v));
const gram = (kg) => (kg === null || kg === undefined ? '' : dec(kg * 1000, 2));

const LABEL = { size: 6.5, bold: true, gray: 0.2 };
const VALUE = { size: 9.5, bold: true };
const VALUE_LINE = 11.5;
const CELL_PAD_X = 4.5;
const CELL_MIN_H = 27;
const MAX_VALUE_LINES = 6;

/**
 * Alanlar: formdaki sıra aynen (iki sütun, `wide` olanlar tam satır). Değer yoksa boş kalır (el ile yazılır).
 * @param {object} w /api/planning/work-orders/:no yanıtı
 */
function fieldsOf(w) {
  const net = gram(w.netKg ?? null);
  const gross = gram(w.grossKg ?? null);
  return [
    { label: 'MAMUL ADI :', value: w.productName }, { label: 'TERMİN SÜRESİ:', value: date(w.dueDate) },
    { label: 'ALEN OTOMAT ÜRÜN KODU', value: w.stockCode }, { label: 'SİPARİŞ NO', value: w.custOrderNo },
    { label: 'MÜŞTERİ ÜRÜN KODU', value: w.customerCode }, { label: 'HEDEF ADET', value: `${new Intl.NumberFormat('tr-TR').format(w.targetQty)} AD` },
    { label: 'HAMMADDE ADI', value: w.usedMaterial ?? w.material }, { label: 'ALTERNATİF HAMMADDE ADI :', value: w.altMaterial },
    { label: 'NET GRAMAJ (gr) (MALİYET)', value: net ? `${net} GR` : '' }, { label: 'NET GRAMAJ (gr) (ÜRETİM)', value: w.measuredNetKg == null ? '' : `${gram(w.measuredNetKg)} gr` },
    { label: 'BRÜT GRAMAJ (gr)', value: gross ? `${gross} GR` : '' },
    { label: 'ÜRETİM SÜRESİ (sn) (MALİYET) SAAT', value: w.plannedSec ? `${dec(w.plannedSec, 1)} SN${w.plannedHours ? ` · ${dec(w.plannedHours, 2)} SAAT` : ''}` : '' },
    { label: 'ÜRETİM SÜRESİ (sn) (ÜRETİM)', value: '' },
    { label: 'GKK RAPOR NO', value: w.gkkReportNo }, { label: 'İLK ONAY RAPOR NO', value: w.firstApprovalNo },
    { label: 'TEZGAH NO', value: w.machineNumber ?? w.machineId },
    {
      label: 'KULLANILAN TOPLAM HAMMADDE (Kg) (Boy)', wide: true,
      value: w.rawKg === null && w.bars === null ? '' : `${w.rawKg === null ? '—' : dec(w.rawKg, 2)} KG · ${w.bars === null ? '—' : dec(w.bars, 2)} BOY`,
    },
    { label: 'AÇIKLAMA', value: w.note, wide: true },
    { label: 'ÜRETİM PLANLAMA YETKİLİSİ', value: '', wide: true, minH: 44 },
  ];
}

/** Hücreyi (yükseklik hesabı için) satırlara böler. */
function layoutCell(field, width) {
  let lines = wrap(field.value ?? '', width - 2 * CELL_PAD_X, VALUE.size, true);
  if (lines.length > MAX_VALUE_LINES) { lines = lines.slice(0, MAX_VALUE_LINES); lines[MAX_VALUE_LINES - 1] = `${lines[MAX_VALUE_LINES - 1].replace(/\s+\S*$/, '')} …`; }
  const h = Math.max(field.minH ?? CELL_MIN_H, 3 + 7.5 + 1.5 + lines.length * VALUE_LINE + 3);
  return { ...field, lines, h };
}

function drawForm(c, w, now) {
  let top = MARGIN;

  // başlık
  c.text(MARGIN, top + 17, 'İŞ EMRİ', { size: 17, bold: true, spacing: 2.4 });
  const noLabel = 'İŞ EMRİ NO:';
  const dateLabel = 'TARİH:';
  const right = MARGIN + CONTENT_W;
  const no = String(w.no);
  const dt = date(w.createdAt);
  c.textRight(right, top + 8, no, { size: 10, bold: true });
  c.textRight(right - textWidth(no, 10, true) - 4, top + 8, noLabel, LABEL);
  c.textRight(right, top + 21, dt, { size: 10, bold: true });
  c.textRight(right - textWidth(dt, 10, true) - 4, top + 21, dateLabel, LABEL);
  top += 27;
  c.line(MARGIN, top, right, top, 1.5);
  top += 5;

  // alan ızgarası: iki sütun, wide = tam satır
  const colW = CONTENT_W / 2;
  const cells = fieldsOf(w);
  let i = 0;
  while (i < cells.length) {
    const first = cells[i];
    if (first.wide) {
      const cell = layoutCell(first, CONTENT_W);
      drawCell(c, MARGIN, top, CONTENT_W, cell);
      top += cell.h;
      i += 1;
      continue;
    }
    const a = layoutCell(first, colW);
    const nextField = cells[i + 1];
    const b = nextField && !nextField.wide ? layoutCell(nextField, colW) : null;
    const h = Math.max(a.h, b?.h ?? 0);
    drawCell(c, MARGIN, top, colW, { ...a, h });
    if (b) drawCell(c, MARGIN + colW, top, colW, { ...b, h });
    top += h;
    i += b ? 2 : 1;
  }

  // alt tablo: TARİH | VARDİYA | ADET x 3 grup x 8 satır (üretime başlamış iş emrinde vardiya adetleri telemetriden dolar)
  top += 7.5;
  const slots = (w.progress?.shifts ?? []).slice(0, 24);
  const colsW = CONTENT_W / 9;
  const rowH = 19.5;
  const head = ['TARİH', 'VARDİYA', 'ADET'];
  for (let col = 0; col < 9; col += 1) {
    c.box(MARGIN + col * colsW, top, colsW, rowH);
    c.textCenter(MARGIN + (col + 0.5) * colsW, top + 12.5, head[col % 3], { size: 6.75, bold: true });
  }
  for (let row = 0; row < 8; row += 1) {
    for (let g = 0; g < 3; g += 1) {
      const s = slots[g * 8 + row];
      const cellsOf = s ? [dayShort(s.date), s.label, String(s.qty)] : ['', '', ''];
      for (let k = 0; k < 3; k += 1) {
        const x = MARGIN + (g * 3 + k) * colsW;
        c.box(x, top + rowH * (row + 1), colsW, rowH);
        c.textCenter(x + colsW / 2, top + rowH * (row + 1) + 12.5, cellsOf[k], { size: 6.75, bold: true });
      }
    }
  }
  top += rowH * 9 + 6;

  const foot = `${w.status === 'iptal' ? 'İPTAL EDİLDİ · ' : ''}${slots.length ? 'Vardiya adetleri telemetriden (tezgah sayacı) · ' : ''}Sistemden üretildi · ${stamp(now)}`;
  c.textRight(right, top + 6, foot, { size: 6.75, gray: 0.33 });
}

function drawCell(c, x, top, width, cell) {
  c.box(x, top, width, cell.h);
  c.text(x + CELL_PAD_X, top + 3 + 5.2, cell.label, LABEL);
  cell.lines.forEach((line, n) => c.text(x + CELL_PAD_X, top + 3 + 7.5 + 1.5 + 8 + n * VALUE_LINE, line, VALUE));
}

/* ===================================================================== PDF dosyası */

/**
 * @param {object} w /api/planning/work-orders/:no yanıtı (ayrıntı + progress)
 * @param {{now?: number}} [o]
 * @returns {Buffer} tek sayfalık A4 PDF
 */
export function buildWorkOrderFormPdf(w, { now = Date.now() } = {}) {
  const c = new Canvas();
  drawForm(c, w, now);
  const stream = c.ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding 7 0 R >>',
    '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 /Gbreve /gbreve /Scedilla /scedilla /Idotaccent /dotlessi] >>',
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, n) => {
    offsets.push(length);
    const buf = Buffer.from(`${n + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    parts.push(buf);
    length += buf.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
