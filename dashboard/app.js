/**
 * CNC Telemetri - dashboard uygulamasi.
 *
 * Iki gorunum, kalici bir tezgah secici:
 *   #/filo             filo geneli (KPI + kartlar)
 *   #/tezgah/CNC-01    tek tezgah ayrintisi
 *
 * Canli degerler SSE ile saniyede bir gelir ve YALNIZCA metin dugumleri
 * yamanir - grafikler ve seritler kendi yavas donguleriyle yenilenir, boylece
 * imlec ve balon her saniye sifirlanmaz.
 */
import { lineChart, timeline, ribbonHtml } from './charts.js';
import { renderConfig, resetConfigView } from './config-view.js';
import {
  STATES, stateOf, num, pct, dur, clock, dateTime, ago,
  FIELD_GROUPS, escapeHtml,
} from './format.js';

const WINDOWS = [
  { key: '30m', label: '30 dk' },
  { key: '8h', label: '8 saat' },
  { key: '24h', label: '24 saat' },
  { key: '7d', label: '7 gün' },
];

const CHARTS = [
  { key: 'spindle_rpm', label: 'Mil devri', unit: 'rpm' },
  { key: 'feed_rate', label: 'İlerleme', unit: 'mm/dk' },
  { key: 'part_count', label: 'Parça sayacı', unit: 'adet', step: true },
];

/** Grafiklerin ve seridin yenilenme sikligi - canli degerlerden bagimsiz. */
const HISTORY_REFRESH_MS = 10_000;

const state = {
  /** @type {object|null} */ snapshot: null,
  /** @type {'fleet'|'machine'|'config'} */ view: 'fleet',
  /** @type {string|null} */ selected: null,
  window: '30m',
  tableView: false,
  /** Secili tezgah icin son cekilen gecmis. */
  history: null,
  detailFor: null,
};

const $ = (sel) => document.querySelector(sel);
const refs = {};

/* ------------------------------------------------------------------ yonlendirme */

function readRoute() {
  const hash = location.hash.replace(/^#/, '');
  const m = /^\/tezgah\/(.+)$/.exec(hash);
  if (m) {
    state.view = 'machine';
    state.selected = decodeURIComponent(m[1]);
  } else if (hash === '/ayarlar') {
    state.view = 'config';
    state.selected = null;
  } else {
    state.view = 'fleet';
    state.selected = null;
  }
}

function go(machineId) {
  location.hash = machineId ? `#/tezgah/${encodeURIComponent(machineId)}` : '#/filo';
}

/* ------------------------------------------------------------------- yan menu */

function machineById(id) {
  return state.snapshot?.machines.find((m) => m.machineId === id) ?? null;
}

function renderSidebar() {
  const list = refs.machineList;
  const machines = state.snapshot?.machines ?? [];
  const signature = machines.map((m) => m.machineId).join(',');

  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.textContent = '';
    for (const m of machines) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mi';
      btn.dataset.machine = m.machineId;
      btn.innerHTML =
        '<span class="mi-dot" data-role="dot"><i></i></span>' +
        `<span class="mi-main"><span class="mi-name">${escapeHtml(m.name)}</span>` +
        `<span class="mi-sub" data-role="sub"></span></span>` +
        '<span class="mi-state" data-role="state"></span>';
      btn.addEventListener('click', () => go(m.machineId));
      li.append(btn);
      list.append(li);
    }
  }

  for (const m of machines) {
    const btn = list.querySelector(`[data-machine="${CSS.escape(m.machineId)}"]`);
    if (!btn) continue;
    const info = stateOf(m.state);
    btn.classList.toggle('is-active', m.machineId === state.selected);
    btn.setAttribute('aria-current', m.machineId === state.selected ? 'true' : 'false');
    btn.querySelector('[data-role="dot"]').className = `mi-dot st-${info.cls}`;
    btn.querySelector('[data-role="sub"]').textContent =
      `${m.machineId}${m.identified === false ? ' · kimlik eksik' : ''}`;
    const stateEl = btn.querySelector('[data-role="state"]');
    stateEl.className = `mi-state st-text-${info.cls}`;
    stateEl.textContent = `${info.icon} ${info.label}`;
  }

  refs.fleetBtn.classList.toggle('is-active', state.view === 'fleet');
  refs.configBtn.classList.toggle('is-active', state.view === 'config');
}

/* ------------------------------------------------------------------- filo gorunumu */

const KPI_ORDER = ['RUNNING', 'IDLE', 'ALARM', 'OFF', 'NO_DATA'];

function renderFleet() {
  const snap = state.snapshot;
  if (!snap) return;

  // --- KPI seridi ---
  if (!refs.kpis.dataset.ready) {
    refs.kpis.dataset.ready = '1';
    refs.kpis.innerHTML = KPI_ORDER.map((key) => {
      const info = STATES[key];
      return (
        `<div class="kpi kpi-${info.cls}">` +
        `<span class="kpi-icon" aria-hidden="true">${info.icon}</span>` +
        `<span class="kpi-value" data-kpi="${key}">0</span>` +
        `<span class="kpi-label">${escapeHtml(info.label)}</span>` +
        '</div>'
      );
    }).join('');
  }
  for (const key of KPI_ORDER) {
    refs.kpis.querySelector(`[data-kpi="${key}"]`).textContent = num(snap.counts[key] ?? 0);
  }

  // --- kartlar ---
  const grid = refs.fleetGrid;
  const signature = snap.machines.map((m) => m.machineId).join(',');
  if (grid.dataset.signature !== signature) {
    grid.dataset.signature = signature;
    grid.textContent = '';
    for (const m of snap.machines) {
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.machine = m.machineId;
      card.innerHTML =
        '<header class="card-top">' +
        `<div><h3>${escapeHtml(m.name)}</h3>` +
        `<p class="card-id">${escapeHtml(m.machineId)} · ${escapeHtml(m.controller ?? '—')}</p></div>` +
        '<span class="badge" data-role="badge"></span>' +
        '</header>' +
        '<p class="card-since" data-role="since"></p>' +
        '<div class="card-metrics">' +
        '<div><span class="m-label">Mil devri</span><span class="m-value" data-role="rpm"></span></div>' +
        '<div><span class="m-label">İlerleme</span><span class="m-value" data-role="feed"></span></div>' +
        '<div><span class="m-label">Parça</span><span class="m-value" data-role="part"></span></div>' +
        '<div><span class="m-label">Çalışma oranı</span><span class="m-value" data-role="ratio"></span></div>' +
        '</div>' +
        '<div class="ribbon" data-role="ribbon" aria-hidden="true"></div>' +
        '<p class="card-foot" data-role="foot"></p>';
      card.addEventListener('click', () => go(m.machineId));
      card.tabIndex = 0;
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(m.machineId); }
      });
      grid.append(card);
    }
  }

  for (const m of snap.machines) {
    const card = grid.querySelector(`[data-machine="${CSS.escape(m.machineId)}"]`);
    if (!card) continue;
    const info = stateOf(m.state);
    const t = m.telemetry;

    card.className = `card card-${info.cls}`;
    const badge = card.querySelector('[data-role="badge"]');
    badge.className = `badge st-${info.cls}`;
    badge.textContent = `${info.icon} ${info.label}`;

    card.querySelector('[data-role="since"]').textContent =
      m.statusDurationSec != null ? `${dur(m.statusDurationSec)} bu durumda` : 'veri bekleniyor';
    card.querySelector('[data-role="rpm"]').textContent =
      m.connected && t ? `${num(t.spindleRpm)} rpm` : '—';
    card.querySelector('[data-role="feed"]').textContent =
      m.connected && t ? `${num(t.feedRate)} mm/dk` : '—';
    card.querySelector('[data-role="part"]').textContent =
      t?.partCount != null ? `${num(t.partCount)} / ${num(t.partTarget)}` : '—';
    card.querySelector('[data-role="ratio"]').textContent = pct(m.runRatio);
    card.querySelector('[data-role="ribbon"]').innerHTML = ribbonHtml(m.ribbon);

    const alarm = t?.alarms?.[0];
    card.querySelector('[data-role="foot"]').textContent = alarm
      ? `${alarm.code} · ${alarm.text}`
      : t?.downtimeReason ?? (t?.program ? `Program ${t.program}` : '');
  }
}

/* ---------------------------------------------------------------- detay gorunumu */

function detailShell(m) {
  const identified = m.identified !== false;
  return (
    '<header class="dt-head">' +
    '<div>' +
    `<span class="eyebrow">${escapeHtml(m.machineId)} · ${escapeHtml(m.controller ?? '—')} · ${escapeHtml(m.softwareVersion ?? '—')}</span>` +
    `<h2>${escapeHtml(m.name)}</h2>` +
    `<p class="dt-sub">${escapeHtml(m.machineBuilder ?? '')} ${escapeHtml(m.machineModel ?? '')}` +
    (m.cncSerial ? ` · CNC seri ${escapeHtml(m.cncSerial)}` : '') +
    ` · sürücü <b>${escapeHtml(m.driverLabel ?? m.source ?? '—')}</b>` +
    (m.ip ? ` · ${escapeHtml(m.ip)}` : '') +
    '</p>' +
    '</div>' +
    '<div class="dt-head-right">' +
    '<span class="badge badge-lg" data-role="badge"></span>' +
    '<span class="dt-since" data-role="since"></span>' +
    '</div>' +
    '</header>' +
    (identified ? '' :
      '<p class="notice">Bu tezgahın panel bilgileri henüz toplanmadı (CNC seri no, gövde seri no, ' +
      'üretim yılı). Filo tek tip olduğu için ortak özellikler gösteriliyor. Kablo çekimi sırasında doldurulacak.') +
    (m.source === 'simulator' ?
      '<p class="notice notice-sim">Bu tezgahın verisi SİMÜLE — gerçek kontrolcüden gelmiyor.</p>' : '') +

    '<section class="dt-live" data-role="live"></section>' +

    '<section class="dt-block">' +
    '<div class="dt-block-head">' +
    '<h3>Durum şeridi</h3>' +
    '<div class="seg" data-role="windows" role="group" aria-label="Zaman aralığı"></div>' +
    '</div>' +
    '<div class="tl-host" data-role="timeline"></div>' +
    '<ul class="legend" data-role="legend"></ul>' +
    '<div class="dt-summary" data-role="summary"></div>' +
    '</section>' +

    '<section class="dt-block">' +
    '<div class="dt-block-head">' +
    '<h3>Ölçümler</h3>' +
    '<div class="dt-actions">' +
    '<button type="button" class="icon-btn" data-role="table-toggle">Tablo</button>' +
    '<a class="icon-btn" data-role="csv" download>CSV indir</a>' +
    '</div>' +
    '</div>' +
    '<div class="charts" data-role="charts"></div>' +
    '<div class="table-wrap" data-role="table" hidden></div>' +
    '</section>' +

    '<section class="dt-block">' +
    '<h3>En uzun duruşlar</h3>' +
    '<div data-role="downtimes"></div>' +
    '</section>' +

    '<section class="dt-block">' +
    '<h3>Kontrolcüden gelen ham değerler</h3>' +
    '<p class="hint">Normalize edilmeyen alanlar. <code>rawStatus</code> önemli: durum eşlemesini ' +
    'makineye gitmeden buradan doğrulayabilirsin.</p>' +
    '<div data-role="raw"></div>' +
    '</section>'
  );
}

function renderDetailStatic(m) {
  refs.detail.innerHTML = detailShell(m);
  state.detailFor = m.machineId;

  // Alan gruplari - yapi bir kez kurulur, degerler sonra yamanir.
  refs.detail.querySelector('[data-role="live"]').innerHTML = FIELD_GROUPS.map((g) =>
    `<div class="fg"><h4>${escapeHtml(g.title)}</h4><dl>` +
    g.fields.map((f) =>
      `<div class="fg-row${f.wide ? ' fg-wide' : ''}">` +
      `<dt>${escapeHtml(f.label)}</dt>` +
      `<dd data-field="${escapeHtml(f.key)}"${f.mono ? ' class="mono"' : ''}>—</dd>` +
      '</div>').join('') +
    '</dl></div>').join('');

  // Zaman araligi dugmeleri
  const seg = refs.detail.querySelector('[data-role="windows"]');
  seg.innerHTML = WINDOWS.map((w) =>
    `<button type="button" data-window="${w.key}"${w.key === state.window ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"'}>${escapeHtml(w.label)}</button>`,
  ).join('');
  seg.addEventListener('click', (ev) => {
    const key = ev.target.closest('[data-window]')?.dataset.window;
    if (!key || key === state.window) return;
    state.window = key;
    for (const b of seg.querySelectorAll('[data-window]')) {
      const on = b.dataset.window === key;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    refreshHistory();
  });

  // Durum aciklamasi - renk tek basina anlam tasimadigi icin her zaman var.
  refs.detail.querySelector('[data-role="legend"]').innerHTML = Object.entries(STATES)
    .map(([, info]) =>
      `<li><span class="lg-swatch st-${info.cls}"></span>${escapeHtml(info.icon)} ${escapeHtml(info.label)}</li>`)
    .join('');

  const toggle = refs.detail.querySelector('[data-role="table-toggle"]');
  toggle.addEventListener('click', () => {
    state.tableView = !state.tableView;
    toggle.classList.toggle('is-on', state.tableView);
    refs.detail.querySelector('[data-role="charts"]').hidden = state.tableView;
    refs.detail.querySelector('[data-role="table"]').hidden = !state.tableView;
    drawHistory();
  });

  refs.detail.querySelector('[data-role="charts"]').innerHTML = CHARTS.map((c) =>
    '<figure class="chart">' +
    `<figcaption>${escapeHtml(c.label)}` +
    (c.unit ? ` <span class="unit">${escapeHtml(c.unit)}</span>` : '') +
    `<b data-now="${escapeHtml(c.key)}"></b></figcaption>` +
    `<div class="chart-host" data-chart="${escapeHtml(c.key)}"></div>` +
    '</figure>').join('');
}

function patchDetail(m) {
  const info = stateOf(m.state);
  const badge = refs.detail.querySelector('[data-role="badge"]');
  if (!badge) return;
  badge.className = `badge badge-lg st-${info.cls}`;
  badge.textContent = `${info.icon} ${info.label}`;
  refs.detail.querySelector('[data-role="since"]').textContent =
    (m.statusDurationSec != null ? `${dur(m.statusDurationSec)} bu durumda` : '') +
    ` · son veri ${ago(m.lastSeenAt, state.snapshot.serverTime)}`;

  const t = m.telemetry ?? {};
  for (const group of FIELD_GROUPS) {
    for (const f of group.fields) {
      const cell = refs.detail.querySelector(`[data-field="${CSS.escape(f.key)}"]`);
      if (!cell) continue;
      const raw = t[f.key];
      cell.textContent = f.fmt(raw);
      // Okunamayan alan bos gorunur ama "0" ile karistirilmaz.
      cell.classList.toggle('is-null', raw === null || raw === undefined || raw === '');
    }
  }

  for (const c of CHARTS) {
    const now = refs.detail.querySelector(`[data-now="${CSS.escape(c.key)}"]`);
    if (!now) continue;
    const key = { spindle_rpm: 'spindleRpm', feed_rate: 'feedRate', part_count: 'partCount' }[c.key];
    now.textContent = m.connected ? num(t[key]) : '—';
  }

  // Ham degerler
  const rawHost = refs.detail.querySelector('[data-role="raw"]');
  const entries = Object.entries(t.controller ?? {});
  rawHost.innerHTML = entries.length === 0
    ? '<p class="empty">Ham değer gelmiyor.</p>'
    : '<dl class="raw">' + entries.map(([k, v]) =>
      `<div class="fg-row"><dt class="mono">${escapeHtml(k)}</dt>` +
      `<dd class="mono">${v === '' ? '<span class="is-null">boş</span>' : escapeHtml(v)}</dd></div>`,
    ).join('') + '</dl>';

  // Alarm varsa en ustte goster
  const alarms = t.alarms ?? [];
  let alarmBox = refs.detail.querySelector('.alarm-box');
  if (alarms.length > 0) {
    if (!alarmBox) {
      alarmBox = document.createElement('div');
      alarmBox.className = 'alarm-box';
      refs.detail.querySelector('[data-role="live"]').before(alarmBox);
    }
    alarmBox.innerHTML = '<span class="alarm-icon" aria-hidden="true">▲</span><div>' +
      alarms.map((a) =>
        `<p><b>${escapeHtml(a.code)}</b> ${escapeHtml(a.text)}</p>`).join('') + '</div>';
  } else if (alarmBox) {
    alarmBox.remove();
  }
}

/* ------------------------------------------------------------------ gecmis verisi */

async function refreshHistory() {
  const id = state.selected;
  if (!id) return;
  const win = state.window;
  try {
    const [hist, detail] = await Promise.all([
      fetch(`/api/machines/${encodeURIComponent(id)}/history?window=${win}&maxPoints=1200`).then((r) => r.json()),
      fetch(`/api/machines/${encodeURIComponent(id)}?window=${win}`).then((r) => r.json()),
    ]);
    // Istek donerken kullanici baska tezgaha gecmis olabilir.
    if (state.selected !== id || state.window !== win) return;
    state.history = { ...hist, spans: detail.spans, summary: detail.summary, downtimes: detail.downtimes };
    drawHistory();
  } catch (err) {
    console.warn('gecmis alinamadi', err);
  }
}

function drawHistory() {
  const h = state.history;
  if (!h || state.detailFor !== state.selected) return;

  const tlHost = refs.detail.querySelector('[data-role="timeline"]');
  if (tlHost) timeline(tlHost, { spans: h.spans ?? [], fromMs: h.fromMs, toMs: h.toMs });

  // Pencere, izlemenin basladigi andan genisse bunu soyle - yoksa veri sagda
  // sikisik gorunur ve kullanici bozuk sanir.
  const tracked = h.summary?.trackedFrom;
  let startNote = refs.detail.querySelector('.track-note');
  if (tracked && tracked > h.fromMs + 60_000) {
    if (!startNote) {
      startNote = document.createElement('p');
      startNote.className = 'hint track-note';
      tlHost.after(startNote);
    }
    startNote.textContent =
      `Bu tezgahın kaydı ${dateTime(tracked)} tarihinde başladı — ` +
      'öncesi boş görünüyor çünkü henüz izlenmiyordu, veri kaybı değil.';
  } else if (startNote) {
    startNote.remove();
  }

  // --- vardiya ozeti ---
  const s = h.summary;
  const sumHost = refs.detail.querySelector('[data-role="summary"]');
  if (sumHost && s) {
    const cells = [
      ['Çalışma oranı', pct(s.runRatio, 1), 'Ölçüm yapılan sürenin yüzdesi'],
      ['Çalıştı', dur(s.totals.RUNNING / 1000), null],
      ['Boşta', dur(s.totals.IDLE / 1000), null],
      ['Alarm', dur(s.totals.ALARM / 1000), null],
      ['Kapalı', dur(s.totals.OFF / 1000), null],
      ['Veri yok', dur(s.noDataMs / 1000), `${num(s.gapCount)} kopma · en uzun ${dur(s.longestGapMs / 1000)}`],
      ['Veri kapsaması', pct(s.coverage, 1), 'İzlemenin başladığı andan bu yana'],
    ];
    sumHost.innerHTML = cells.map(([label, value, hint]) =>
      '<div class="sm">' +
      `<span class="sm-label">${escapeHtml(label)}</span>` +
      `<span class="sm-value">${escapeHtml(value)}</span>` +
      (hint ? `<span class="sm-hint">${escapeHtml(hint)}</span>` : '') +
      '</div>').join('');
  }

  // --- grafikler ya da tablo ---
  if (state.tableView) {
    drawTable(h);
  } else {
    for (const c of CHARTS) {
      const host = refs.detail.querySelector(`[data-chart="${CSS.escape(c.key)}"]`);
      if (!host) continue;
      lineChart(host, {
        points: (h.samples ?? []).map((row) => ({ ts: Number(row.ts), value: row[c.key] })),
        unit: c.unit,
        step: c.step === true,
        fromMs: h.fromMs,
        toMs: h.toMs,
        label: c.label,
      });
    }
  }

  // --- durus listesi ---
  const dtHost = refs.detail.querySelector('[data-role="downtimes"]');
  if (dtHost) {
    const rows = (h.downtimes ?? []).slice(0, 12);
    dtHost.innerHTML = rows.length === 0
      ? '<p class="empty">Bu aralıkta duruş kaydı yok.</p>'
      : '<table class="tbl"><thead><tr><th>Durum</th><th>Başlangıç</th>' +
        '<th class="num">Süre</th><th>Not</th></tr></thead><tbody>' +
        rows.map((d) => {
          const info = stateOf(d.state);
          return '<tr>' +
            `<td><span class="st-text-${info.cls}">${escapeHtml(info.icon)} ${escapeHtml(info.label)}</span></td>` +
            `<td>${escapeHtml(dateTime(d.startedAt))}</td>` +
            `<td class="num">${escapeHtml(dur(d.durationMs / 1000))}</td>` +
            `<td>${escapeHtml(d.reason ?? '')}</td></tr>`;
        }).join('') + '</tbody></table>';
  }

  // --- CSV baglantisi ---
  const csv = refs.detail.querySelector('[data-role="csv"]');
  if (csv) {
    csv.href = `/api/machines/${encodeURIComponent(state.selected)}/export.csv?window=${state.window}`;
  }
}

/** Grafiklerin tablo karsiligi - renk/konum gormeden de okunabilsin. */
function drawTable(h) {
  const host = refs.detail.querySelector('[data-role="table"]');
  if (!host) return;
  const rows = (h.samples ?? []).slice(-200).reverse();
  host.innerHTML =
    `<p class="hint">${num(h.total)} ölçümden son ${num(rows.length)} satır gösteriliyor. ` +
    'Tamamı için CSV indir.</p>' +
    '<table class="tbl"><thead><tr><th>Zaman</th><th>Durum</th>' +
    CHARTS.map((c) => `<th class="num">${escapeHtml(c.label)}</th>`).join('') +
    '<th>Program</th></tr></thead><tbody>' +
    rows.map((r) => {
      const info = stateOf(r.status);
      return '<tr>' +
        `<td>${escapeHtml(clock(Number(r.ts)))}</td>` +
        `<td><span class="st-text-${info.cls}">${escapeHtml(info.icon)} ${escapeHtml(info.label)}</span></td>` +
        CHARTS.map((c) => `<td class="num">${escapeHtml(num(r[c.key]))}</td>`).join('') +
        `<td class="mono">${escapeHtml(r.program ?? '')}</td></tr>`;
    }).join('') + '</tbody></table>';
}

/* ----------------------------------------------------------------------- cizim */

function render() {
  const snap = state.snapshot;
  if (!snap) return;
  renderSidebar();

  const m = state.view === 'machine' ? machineById(state.selected) : null;
  // Adres cubugunda olmayan bir tezgah yaziliysa filoya dusulur.
  const view = state.view === 'machine' && m === null ? 'fleet' : state.view;

  refs.fleetView.hidden = view !== 'fleet';
  refs.detail.hidden = view !== 'machine';
  refs.configView.hidden = view !== 'config';

  refs.title.textContent =
    view === 'machine' ? m.name : view === 'config' ? 'Ayarlar' : 'Filo Genel Bakış';

  if (view === 'machine') {
    if (state.detailFor !== m.machineId) {
      renderDetailStatic(m);
      state.history = null;
      refreshHistory();
    }
    patchDetail(m);
  } else if (view === 'config') {
    // Ayarlar ekrani kendi verisini ceker; her SSE karesinde yeniden cizilmez.
    if (!refs.configView.dataset.ready) {
      refs.configView.dataset.ready = '1';
      renderConfig(refs.configView, () => {
        // Kaydedildi: yan menu yeni tezgahlari bir sonraki karede gosterir.
        resetConfigView();
        delete refs.configView.dataset.ready;
      });
    }
  } else {
    if (state.detailFor !== null) {
      refs.detail.innerHTML = '';
      state.detailFor = null;
    }
    renderFleet();
  }

  refs.foot.textContent =
    `${num(snap.messageCount)} mesaj · ${num(snap.rejectedCount)} reddedildi · ` +
    `sunucu ${dur(snap.uptimeSec)} ayakta · veri boşluğu eşiği ${snap.gapThresholdMs / 1000} sn`;
}

/* -------------------------------------------------------------------- baglanti */

function connect() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConn('canlı', true));
  es.addEventListener('snapshot', (ev) => {
    state.snapshot = JSON.parse(ev.data);
    setConn('canlı', true);
    render();
  });
  es.addEventListener('error', () => setConn('bağlantı kesildi — yeniden deneniyor', false));
}

function setConn(text, ok) {
  refs.connText.textContent = text;
  refs.conn.classList.toggle('is-ok', ok);
  refs.conn.classList.toggle('is-bad', !ok);
}

/* ------------------------------------------------------------------- baslatma */

function initTheme() {
  const saved = (() => {
    try { return localStorage.getItem('cnc-theme'); } catch { return null; }
  })();
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
  refs.themeBtn.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('cnc-theme', next); } catch { /* gizli sekme */ }
    // Grafikler tema renklerini CSS'ten aldigi icin yeniden cizilmeli.
    drawHistory();
  });
}

/** Yan menude ok tuslariyla dolasma. */
function initKeyboard() {
  refs.sidebar.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const buttons = [...refs.sidebar.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    if (i === -1) return;
    ev.preventDefault();
    buttons[(i + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
}

function init() {
  refs.machineList = $('#machine-list');
  refs.fleetBtn = $('#fleet-btn');
  refs.configBtn = $('#config-btn');
  refs.configView = $('#config-view');
  refs.sidebar = $('#sidebar');
  refs.kpis = $('#kpis');
  refs.fleetGrid = $('#fleet-grid');
  refs.fleetView = $('#fleet-view');
  refs.detail = $('#detail');
  refs.title = $('#view-title');
  refs.conn = $('#conn');
  refs.connText = $('#conn-text');
  refs.themeBtn = $('#theme-toggle');
  refs.foot = $('#foot-stats');

  refs.fleetBtn.addEventListener('click', () => go(null));
  refs.configBtn.addEventListener('click', () => { location.hash = '#/ayarlar'; });
  addEventListener('hashchange', () => { readRoute(); render(); });

  initTheme();
  initKeyboard();
  readRoute();
  connect();

  setInterval(() => { if (state.selected) refreshHistory(); }, HISTORY_REFRESH_MS);
  // Pencere boyutu degisince grafikler yeniden olculmeli.
  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawHistory, 150);
  });
}

init();
