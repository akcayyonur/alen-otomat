/**
 * Grafik bilesenleri - bagimlilik yok, duz SVG.
 *
 * Tasarim kurallari (dataviz):
 *  - Tek olcum = tek seri = lejant yok; baslik seriyi adlandirir.
 *  - Iki olcum asla tek grafikte iki eksene bolunmez; ayri grafik acilir.
 *  - Izgara ve eksenler geri planda, veri onde.
 *  - Her cizgi grafigi imlec cizgisi + balon tasir.
 *  - NO_DATA rengi tek basina ayirt edici degil; taramali desen ile cizilir.
 */
import { stateOf, num, dur, clock, dateTime, escapeHtml } from './format.js';

const PAD = { top: 10, right: 12, bottom: 20, left: 46 };
const HEIGHT = 150;

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
};

/** Ekseni okunur sayilara yuvarlar (1-2-5 adimlari). */
function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * Tek serili zaman grafigi.
 * @param {HTMLElement} host  icine cizilecek kap (position:relative olmali)
 * @param {{points:{ts:number,value:number|null}[], unit?:string, step?:boolean,
 *          fromMs?:number, toMs?:number, label:string}} opts
 */
export function lineChart(host, opts) {
  const { points, unit = '', step = false, label } = opts;
  host.textContent = '';

  const width = Math.max(260, host.clientWidth || 600);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const valid = points.filter((p) => p.value !== null && p.value !== undefined);
  if (valid.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'Bu alan için henüz ölçüm yok.';
    host.append(empty);
    return;
  }

  const fromMs = opts.fromMs ?? points[0].ts;
  const toMs = opts.toMs ?? points[points.length - 1].ts;
  const spanMs = Math.max(1, toMs - fromMs);

  let lo = Math.min(...valid.map((p) => p.value));
  let hi = Math.max(...valid.map((p) => p.value));
  if (lo === hi) { lo -= 1; hi += 1; }
  // Sifir anlamli bir taban: devir ve ilerleme sifirdan baslar.
  if (lo > 0) lo = 0;
  const pad = (hi - lo) * 0.08;
  hi += pad;

  const xOf = (ts) => PAD.left + ((ts - fromMs) / spanMs) * plotW;
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const svg = el('svg', {
    width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`,
    role: 'img', 'aria-label': `${label} zaman grafiği`,
  });

  // --- izgara + y ekseni (geri planda) ---
  for (const t of niceTicks(lo, hi)) {
    const y = yOf(t);
    svg.append(el('line', { x1: PAD.left, x2: width - PAD.right, y1: y, y2: y, class: 'grid' }));
    const text = el('text', { x: PAD.left - 7, y: y + 3.5, class: 'axis', 'text-anchor': 'end' });
    text.textContent = num(t, Math.abs(t) < 10 && t % 1 !== 0 ? 1 : 0);
    svg.append(text);
  }

  // --- x ekseni: bastaki ve sondaki saat ---
  for (const [ts, anchor] of [[fromMs, 'start'], [toMs, 'end']]) {
    const text = el('text', {
      x: anchor === 'start' ? PAD.left : width - PAD.right,
      y: HEIGHT - 5, class: 'axis', 'text-anchor': anchor,
    });
    text.textContent = clock(ts);
    svg.append(text);
  }

  // --- veri yolu ---
  // Kopuk araliklar birlestirilmez: null gelen yerde cizgi kesilir, boylece
  // veri boslugu duz bir cizgi olarak YANLIS gosterilmez.
  let d = '';
  let open = false;
  let prev = null;
  for (const p of points) {
    if (p.value === null || p.value === undefined) { open = false; continue; }
    const x = xOf(p.ts);
    const y = yOf(p.value);
    if (!open) { d += `M${x.toFixed(1)} ${y.toFixed(1)}`; open = true; }
    else if (step && prev !== null) d += `H${x.toFixed(1)}V${y.toFixed(1)}`;
    else d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    prev = p.value;
  }
  svg.append(el('path', { d, class: 'series-line' }));

  // --- imlec katmani ---
  const cursor = el('line', { class: 'cursor', y1: PAD.top, y2: PAD.top + plotH, style: 'opacity:0' });
  const dot = el('circle', { r: 4.5, class: 'cursor-dot', style: 'opacity:0' });
  svg.append(cursor, dot);

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;

  const hit = el('rect', {
    x: PAD.left, y: PAD.top, width: plotW, height: plotH,
    fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.append(hit);

  const hide = () => { tip.hidden = true; cursor.style.opacity = '0'; dot.style.opacity = '0'; };

  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    // SVG olculen genislikte cizildigi icin olcekleme gerekmez.
    const px = ev.clientX - box.left;
    const ts = fromMs + ((px - PAD.left) / plotW) * spanMs;

    let near = null;
    let bestDelta = Infinity;
    for (const p of valid) {
      const delta = Math.abs(p.ts - ts);
      if (delta < bestDelta) { bestDelta = delta; near = p; }
    }
    if (!near) return hide();

    const x = xOf(near.ts);
    const y = yOf(near.value);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x);
    cursor.style.opacity = '1';
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    dot.style.opacity = '1';

    tip.hidden = false;
    tip.innerHTML =
      `<span class="tooltip-time">${escapeHtml(clock(near.ts))}</span>` +
      `<span class="tooltip-value">${escapeHtml(num(near.value, 1))}` +
      (unit ? ` <span class="tooltip-unit">${escapeHtml(unit)}</span>` : '') +
      '</span>';
    // Balon kenarlardan tasmasin.
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(x, half + 2), width - half - 2)}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
  });
  hit.addEventListener('pointerleave', hide);

  host.append(svg, tip);
}

/**
 * Durum zaman seridi. Araliklardan cizilir (ornek saymaz), bu yuzden kisa
 * alarmlar ve veri bosluklari kaybolmaz.
 * @param {HTMLElement} host
 * @param {{spans:{state:string,startedAt:number,endedAt:number,reason:string|null}[],
 *          fromMs:number, toMs:number}} opts
 */
export function timeline(host, { spans, fromMs, toMs }) {
  host.textContent = '';
  const width = Math.max(260, host.clientWidth || 600);
  const H = 34;
  const spanMs = Math.max(1, toMs - fromMs);

  const svg = el('svg', {
    width, height: H + 18, viewBox: `0 0 ${width} ${H + 18}`,
    role: 'img', 'aria-label': 'Durum zaman şeridi',
  });

  // Veri boslugu icin taramali desen - renk tek basina ayirt edici olmasin.
  const defs = el('defs');
  const pattern = el('pattern', {
    id: 'hatch-nodata', width: 6, height: 6,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  pattern.append(el('rect', { width: 6, height: 6, class: 'tl-nodata-bg' }));
  pattern.append(el('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'tl-nodata-line' }));
  defs.append(pattern);
  svg.append(defs);

  svg.append(el('rect', { x: 0, y: 0, width, height: H, class: 'tl-base', rx: 3 }));

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;

  for (const s of spans) {
    const x = ((s.startedAt - fromMs) / spanMs) * width;
    const w = Math.max(1, ((s.endedAt - s.startedAt) / spanMs) * width);
    const info = stateOf(s.state);
    const rect = el('rect', {
      x, y: 0, width: w, height: H,
      class: `tl-seg tl-${info.cls}`,
      fill: s.state === 'NO_DATA' ? 'url(#hatch-nodata)' : null,
    });

    rect.addEventListener('pointerenter', () => {
      tip.hidden = false;
      tip.innerHTML =
        `<span class="tooltip-time">${escapeHtml(info.icon)} ${escapeHtml(info.label)}</span>` +
        `<span class="tooltip-value">${escapeHtml(dur((s.endedAt - s.startedAt) / 1000))}</span>` +
        `<span class="tooltip-unit">${escapeHtml(dateTime(s.startedAt))}</span>` +
        (s.reason ? `<span class="tooltip-unit">${escapeHtml(s.reason)}</span>` : '');
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(x + w / 2, half + 2), width - half - 2)}px`;
      tip.style.top = `${-tip.offsetHeight - 6}px`;
    });
    rect.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(rect);
  }

  for (const [ts, anchor] of [[fromMs, 'start'], [toMs, 'end']]) {
    const text = el('text', {
      x: anchor === 'start' ? 0 : width, y: H + 13,
      class: 'axis', 'text-anchor': anchor,
    });
    text.textContent = clock(ts);
    svg.append(text);
  }

  host.append(svg, tip);
}

/**
 * Kart uzerindeki minik durum seridi - sunucudan gelen harf dizisini boyar.
 * R=calisiyor I=bosta A=alarm O=kapali N=veri yok -=hic gozlenmedi
 */
const RIBBON_CLS = { R: 'run', I: 'idle', A: 'alarm', O: 'off', N: 'nodata', '-': 'none' };

export function ribbonHtml(ribbon) {
  if (!ribbon) return '';
  let out = '';
  let runLength = 0;
  for (let i = 0; i < ribbon.length; i += 1) {
    const ch = ribbon[i];
    if (ribbon[i + 1] === ch) { runLength += 1; continue; }
    const cls = RIBBON_CLS[ch] ?? 'none';
    out += `<i class="rb rb-${cls}" style="flex:${runLength + 1}"></i>`;
    runLength = 0;
  }
  return out;
}
