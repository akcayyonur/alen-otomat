/* CNC Telemetri Dashboard - canli akis istemcisi. Bagimlilik yok. */

const STATUS = {
  RUNNING: { label: 'Çalışıyor', glyph: '▶', cls: 'run', ribbon: 'R' },
  IDLE:    { label: 'Boşta',     glyph: '⏸', cls: 'idle', ribbon: 'I' },
  ALARM:   { label: 'Alarm',     glyph: '⚠', cls: 'alarm', ribbon: 'A' },
  OFF:     { label: 'Kapalı',    glyph: '⏻', cls: 'off', ribbon: 'O' },
};
const OFFLINE = { label: 'Bağlantı yok', glyph: '✕', cls: 'none' };

const SOURCE_LABEL = {
  opcua: 'OPC-UA', mtconnect: 'MTConnect', focas: 'FOCAS',
  modbus: 'Modbus TCP', 'retrofit-io': 'Retrofit I/O',
  'syntec-remoteapi': 'Syntec RemoteAPI', simulator: 'Simülatör',
};

const el = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('tr-TR');

const state = { snapshot: null, selectedId: null, history: null, live: false };

/* ---------- yardimcilar ---------- */

function fmtNum(v) {
  return v === null || v === undefined ? null : nf.format(Math.round(v));
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} sn`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusOf(machine) {
  if (!machine.connected || !machine.telemetry) return OFFLINE;
  return STATUS[machine.telemetry.status] ?? OFFLINE;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- canli akis ---------- */

function connect() {
  const es = new EventSource('/api/stream');

  es.addEventListener('snapshot', (event) => {
    state.snapshot = JSON.parse(event.data);
    setLive(true);
    render();
  });

  es.onerror = () => {
    // EventSource kendisi yeniden baglanir; sadece durumu gosteriyoruz.
    setLive(false);
  };
}

function setLive(live) {
  if (state.live === live) return;
  state.live = live;
  const node = el('conn');
  node.classList.toggle('live', live);
  node.classList.toggle('down', !live);
  el('conn-text').textContent = live ? 'canlı' : 'bağlantı kesildi — yeniden deneniyor';
}

/* ---------- KPI satiri ---------- */

function renderKpis(snap) {
  const c = snap.counts;
  const total = snap.machines.length;
  const tiles = [
    { key: 'RUNNING', n: c.RUNNING, meta: STATUS.RUNNING, color: 'var(--st-run)' },
    { key: 'IDLE', n: c.IDLE, meta: STATUS.IDLE, color: 'var(--st-idle)' },
    { key: 'ALARM', n: c.ALARM, meta: STATUS.ALARM, color: 'var(--st-alarm)' },
    { key: 'OFF', n: c.OFF, meta: STATUS.OFF, color: 'var(--st-off)' },
    { key: 'OFFLINE', n: c.OFFLINE, meta: OFFLINE, color: 'var(--st-none)' },
  ];

  el('kpis').innerHTML = tiles.map((t) => `
    <div class="kpi">
      <div class="kpi-label">
        <span class="legend-key" style="background:${t.color}"></span>
        <span>${t.meta.glyph} ${esc(t.meta.label)}</span>
      </div>
      <div class="kpi-value">${t.n}</div>
      <div class="kpi-sub">${total} tezgahtan</div>
    </div>`).join('');
}

/* ---------- durum seridi ---------- */

function ribbonHtml(ribbon, extraClass = '') {
  const slots = ribbon && ribbon.length > 0 ? ribbon : '-'.repeat(120);
  const cells = [...slots]
    .map((ch) => `<span class="${ch === '-' ? 'rb-empty' : `rb-${ch}`}"></span>`)
    .join('');
  return `<div class="ribbon ${extraClass}">${cells}</div>`;
}

/* ---------- filo kartlari ---------- */

function metricCell(label, value, unit, reports, field) {
  const supported = reports.includes(field);
  const shown = value === null || value === undefined
    ? (supported ? '—' : 'yok')
    : `${value}<span class="metric-unit">${unit}</span>`;
  const cls = value === null || value === undefined ? 'metric-value empty' : 'metric-value';
  const title = supported ? '' : ' title="Bu tezgah bu veriyi üretemiyor"';
  return `<div><div class="metric-label">${esc(label)}</div><div class="${cls}"${title}>${shown}</div></div>`;
}

function renderFleet(snap) {
  el('fleet').innerHTML = snap.machines.map((m) => {
    const st = statusOf(m);
    const t = m.telemetry;
    const reports = m.reports ?? [];
    return `
      <button class="card" type="button" data-id="${esc(m.machineId)}" aria-pressed="${m.machineId === state.selectedId}">
        <div class="card-head">
          <div>
            <div class="card-name">${esc(m.name)}</div>
            <div class="card-id">${esc(m.machineId)} · ${esc(m.vendor)}</div>
          </div>
          <span class="badge ${st.cls}"><span class="badge-glyph">${st.glyph}</span>${esc(st.label)}</span>
        </div>

        <div class="card-metrics">
          ${metricCell('Devir', fmtNum(t?.spindleRpm), ' rpm', reports, 'spindleRpm')}
          ${metricCell('İlerleme', fmtNum(t?.feedRate), ' mm/dk', reports, 'feedRate')}
          ${metricCell('Parça', fmtNum(t?.partCount), '', reports, 'partCount')}
        </div>

        ${ribbonHtml(m.ribbon)}

        <div class="card-foot">
          <span>${m.connected ? fmtDuration(m.statusDurationSec) + ' bu durumda' : 'veri gelmiyor'}</span>
          <span class="src-tag">${esc(SOURCE_LABEL[m.source] ?? m.source)}</span>
        </div>
      </button>`;
  }).join('');

  for (const card of el('fleet').querySelectorAll('.card')) {
    card.addEventListener('click', () => selectMachine(card.dataset.id));
  }
}

/* ---------- cizgi grafik ---------- */

const CHART = { W: 360, H: 112, PL: 44, PR: 12, PT: 10, PB: 18 };

function niceMax(value) {
  if (value <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / mag) * mag;
}

/** Ardisik null olmayan noktalari ayri parcalara boler - bosluklar kopuk cizilir. */
function segmentize(points) {
  const segments = [];
  let current = [];
  for (const p of points) {
    if (p.v === null || p.v === undefined) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function renderChart(container, samples, field, unit) {
  const { W, H, PL, PR, PT, PB } = CHART;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const values = samples.map((s) => s[field]).filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return false;

  const max = niceMax(Math.max(...values));
  const n = samples.length;
  const x = (i) => PL + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v) => PT + plotH - (v / max) * plotH;

  const points = samples.map((s, i) => ({ i, v: s[field], ts: s.ts, x: x(i), y: s[field] == null ? null : y(s[field]) }));
  const segments = segmentize(points);

  const areas = segments.filter((seg) => seg.length > 1).map((seg) => {
    const d = seg.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
    return `<path d="${d}L${seg.at(-1).x.toFixed(1)},${(PT + plotH).toFixed(1)}L${seg[0].x.toFixed(1)},${(PT + plotH).toFixed(1)}Z" fill="var(--series-wash)"/>`;
  }).join('');

  const lines = segments.map((seg) => {
    if (seg.length === 1) {
      return `<circle cx="${seg[0].x.toFixed(1)}" cy="${seg[0].y.toFixed(1)}" r="2" fill="var(--series)"/>`;
    }
    const d = seg.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');

  const ticks = [0, max / 2, max].map((v) => `
    <line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
    <text x="${PL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--ink-faint)"
          font-family="IBM Plex Mono, monospace">${nf.format(Math.round(v))}</text>`).join('');

  const last = points.filter((p) => p.y !== null).at(-1);
  const endDot = last
    ? `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>`
    : '';

  const first = samples[0];
  const lastSample = samples.at(-1);

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(field)} zaman serisi">
      ${ticks}
      ${areas}${lines}${endDot}
      <g class="hover-layer" hidden>
        <line class="hv-line" y1="${PT}" y2="${PT + plotH}" stroke="var(--ink-faint)" stroke-width="1"/>
        <circle class="hv-dot" r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>
      </g>
      <rect class="hit" x="${PL}" y="${PT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"/>
      <text x="${PL}" y="${H - 5}" font-size="9.5" fill="var(--ink-faint)" font-family="IBM Plex Mono, monospace">${fmtClock(first.ts)}</text>
      <text x="${W - PR}" y="${H - 5}" text-anchor="end" font-size="9.5" fill="var(--ink-faint)" font-family="IBM Plex Mono, monospace">${fmtClock(lastSample.ts)}</text>
    </svg>
    <div class="tooltip"></div>`;

  attachHover(container, points, unit);
  return true;
}

function attachHover(container, points, unit) {
  const svg = container.querySelector('svg');
  const layer = container.querySelector('.hover-layer');
  const hvLine = container.querySelector('.hv-line');
  const hvDot = container.querySelector('.hv-dot');
  const tip = container.querySelector('.tooltip');
  const hit = container.querySelector('.hit');
  const valid = points.filter((p) => p.y !== null);
  if (valid.length === 0) return;

  hit.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const svgX = ((event.clientX - box.left) / box.width) * CHART.W;
    let nearest = valid[0];
    for (const p of valid) {
      if (Math.abs(p.x - svgX) < Math.abs(nearest.x - svgX)) nearest = p;
    }

    layer.hidden = false;
    hvLine.setAttribute('x1', nearest.x);
    hvLine.setAttribute('x2', nearest.x);
    hvDot.setAttribute('cx', nearest.x);
    hvDot.setAttribute('cy', nearest.y);

    tip.textContent = `${fmtClock(nearest.ts)} · ${nf.format(Math.round(nearest.v))}${unit}`;
    tip.classList.add('on');
    const px = (nearest.x / CHART.W) * box.width;
    tip.style.left = `${Math.min(Math.max(px - tip.offsetWidth / 2, 4), box.width - tip.offsetWidth - 4)}px`;
    tip.style.top = '0px';
  });

  hit.addEventListener('mouseleave', () => {
    layer.hidden = true;
    tip.classList.remove('on');
  });
}

/* ---------- detay paneli ---------- */

function chartSection(title, current, samples, field, unit, machine) {
  const supported = (machine.reports ?? []).includes(field);
  const box = document.createElement('div');
  box.className = 'sec';
  box.innerHTML = `<h3 class="sec-title"><span>${esc(title)}</span><span class="cur">${current}</span></h3>`;

  const chart = document.createElement('div');
  chart.className = 'chart';
  box.appendChild(chart);

  const drawn = samples.length > 0 && renderChart(chart, samples, field, unit);
  if (!drawn) {
    chart.className = 'chart-empty';
    chart.textContent = supported
      ? 'Bu tezgah için henüz yeterli veri toplanmadı.'
      : `Bu tezgah ${esc(title.toLowerCase())} verisi üretmiyor — kaynak: ${SOURCE_LABEL[machine.source] ?? machine.source}.`;
  }
  return box;
}

function renderDetail() {
  const panel = el('detail');
  const snap = state.snapshot;
  if (!snap) return;

  const machine = snap.machines.find((m) => m.machineId === state.selectedId);
  if (!machine) {
    panel.innerHTML = '<p class="detail-empty">Ayrıntı için bir tezgah kartı seçin.</p>';
    return;
  }

  const st = statusOf(machine);
  const t = machine.telemetry;
  const samples = state.history?.machineId === machine.machineId ? state.history.samples : [];

  panel.innerHTML = `
    <h2>${esc(machine.name)}</h2>
    <div class="detail-id">${esc(machine.machineId)}</div>
    <div style="margin-top:10px">
      <span class="badge ${st.cls}"><span class="badge-glyph">${st.glyph}</span>${esc(st.label)}</span>
      <span class="detail-id" style="margin-left:8px">${fmtDuration(machine.statusDurationSec)}</span>
    </div>

    <dl class="spec">
      <dt>Marka</dt><dd>${esc(machine.vendor)}</dd>
      <dt>Kontrolcü</dt><dd>${esc(machine.controller)}</dd>
      <dt>Yıl</dt><dd>${machine.year ?? '—'}</dd>
      <dt>Kaynak</dt><dd>${esc(SOURCE_LABEL[machine.source] ?? machine.source)}</dd>
      <dt>Program</dt><dd>${t?.program ? esc(t.program) : '—'}</dd>
      <dt>Parça</dt><dd>${fmtNum(t?.partCount) ?? '—'}</dd>
      <dt>Çevrim</dt><dd>${t?.cycleTimeSec != null ? `${t.cycleTimeSec} sn` : '—'}</dd>
    </dl>`;

  if (machine.note) {
    panel.insertAdjacentHTML('beforeend',
      `<div class="note"><span class="note-label">Envanter notu</span>${esc(machine.note)}</div>`);
  }

  if (t?.alarms?.length) {
    const items = t.alarms.map((a) => `<div class="alarm-item">${esc(a.code)} — ${esc(a.text)}</div>`).join('');
    panel.insertAdjacentHTML('beforeend',
      `<div class="note alarm"><span class="note-label">Aktif alarm</span>${items}</div>`);
  } else if (t?.downtimeReason) {
    panel.insertAdjacentHTML('beforeend',
      `<div class="note"><span class="note-label">Duruş nedeni</span>${esc(t.downtimeReason)}</div>`);
  }

  // Calisma orani - tam OEE degil, yalnizca gozlem suresi icindeki kullanilabilirlik.
  if (machine.runRatio !== null && machine.runRatio !== undefined) {
    const pct = Math.round(machine.runRatio * 100);
    panel.insertAdjacentHTML('beforeend', `
      <div class="sec">
        <h3 class="sec-title"><span>Çalışma oranı</span><span class="cur">%${pct}</span></h3>
        <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
        <div class="ribbon-axis"><span>gözlem süresi içinde · tam OEE değil</span></div>
      </div>`);
  }

  // Durum zaman seridi + legend (renk tek basina anlam tasimasin diye)
  const legend = [STATUS.RUNNING, STATUS.IDLE, STATUS.ALARM, STATUS.OFF]
    .map((s) => `<span class="legend-item"><span class="legend-key" style="background:var(--st-${s.cls})"></span>${esc(s.label)}</span>`)
    .join('');
  const span = samples.length > 1
    ? `${fmtClock(samples[0].ts)} – ${fmtClock(samples.at(-1).ts)}`
    : 'veri toplanıyor';
  panel.insertAdjacentHTML('beforeend', `
    <div class="sec">
      <h3 class="sec-title"><span>Durum zaman çizelgesi</span></h3>
      ${ribbonHtml(machine.ribbon, 'lg')}
      <div class="ribbon-axis"><span>${span}</span></div>
      <div class="legend">${legend}</div>
    </div>`);

  panel.appendChild(chartSection(
    'Devir', t?.spindleRpm != null ? `${nf.format(t.spindleRpm)} rpm` : '—',
    samples, 'spindleRpm', ' rpm', machine));
  panel.appendChild(chartSection(
    'İlerleme', t?.feedRate != null ? `${nf.format(t.feedRate)} mm/dk` : '—',
    samples, 'feedRate', ' mm/dk', machine));
}

/* ---------- secim ---------- */

async function selectMachine(id) {
  state.selectedId = id;
  await loadHistory();
  render();
}

async function loadHistory() {
  if (!state.selectedId) { state.history = null; return; }
  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(state.selectedId)}/history`);
    if (res.ok) state.history = await res.json();
  } catch {
    // Gecici hata - bir sonraki dongude yeniden denenir.
  }
}

/* ---------- render ---------- */

function render() {
  const snap = state.snapshot;
  if (!snap) return;
  renderKpis(snap);
  renderFleet(snap);
  renderDetail();
  el('foot-stats').textContent =
    `${nf.format(snap.messageCount)} mesaj · ${snap.rejectedCount} reddedildi · sunucu ${fmtDuration(snap.uptimeSec)}`;
}

/* ---------- tema ---------- */

el('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('cnc-theme', next); } catch { /* kullanilamiyor olabilir */ }
});
try {
  const saved = localStorage.getItem('cnc-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch { /* yok say */ }

/* Secili tezgahin gecmisi periyodik tazelenir; anlik degerler SSE'den gelir. */
setInterval(() => { if (state.selectedId) loadHistory().then(renderDetail); }, 3000);

connect();
