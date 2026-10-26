/**
 * Dashboard kabugu: giristen sonra iki AYRI uygulama (apps.js): CNC Telemetri ve Planlama.
 *   #/uygulamalar      uygulama secimi (birden cok uygulamasi olan kullanici; adres bos ise de burasi acilir)
 *
 * CNC Telemetri - gorunumler, kalici bir tezgah secici:
 *   #/filo             filo geneli (KPI + kartlar)
 *   #/tezgah/CNC-01    tek tezgah ayrintisi
 *   #/uretim           uretim raporu (vardiya x tezgah x program adetleri)
 *   #/programlar       program kutuphanesi   (#/programlar/12: program ayrintisi)
 *   #/ayarlar          tezgah ve surucu ayarlari
 *
 * Planlama (yan menusu ve ust cubugu ayri; tezgah listesi yok) - yalniz yonetici:
 *   #/planlama         is emirleri; #/planlama/tezgahbasi | gkk | ilkonay | olcuraporlari | urunler | siparisler | programlar
 *
 * Canli degerler SSE ile saniyede bir gelir ve YALNIZCA metin dugumleri
 * yamanir - grafikler ve seritler kendi yavas donguleriyle yenilenir, boylece
 * imlec ve balon her saniye sifirlanmaz.
 */
import { timeline, ribbonHtml } from './charts.js';
import { renderConfig, resetConfigView } from './config-view.js';
import { renderLibrary, resetLibraryView, renderMachinePrograms } from './library-view.js';
import { renderProduction, resetProductionView, initMachineProduction, refreshMachineProduction } from './production-view.js';
import { renderPlanning, renderPlanningNav, planningTabsFor, defaultPlanningTab } from './planning-view.js';
import { appsFor, renderApps } from './apps.js';
import { initAuth, isAdmin, getSession, checkSessionAfterStreamError } from './auth-view.js';
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

/** Grafiklerin ve seridin yenilenme sikligi - canli degerlerden bagimsiz. */
const HISTORY_REFRESH_MS = 10_000;

const state = {
  /** @type {object|null} */ snapshot: null,
  /** @type {'fleet'|'machine'|'config'|'library'|'production'|'planning'|'apps'} */ view: 'fleet',
  /** @type {'tezgahbasi'|'paketleme'|'isemirleri'|'gkk'|'ilkonay'|'olcuraporlari'|'verimlilik'|'hammadde'|'urunler'|'siparisler'|'programlar'} planlama ekraninda secili sekme */ planningTab: 'isemirleri',
  /** @type {string|null} */ selected: null,
  /** @type {number|null} kutuphane ekraninda secili program */ programId: null,
  window: '30m',
  /** Secili tezgah icin son cekilen gecmis. */
  history: null,
  detailFor: null,
};

const $ = (sel) => document.querySelector(sel);
const refs = {};

/* ------------------------------------------------------------------ yonlendirme */

/** Rolun giris adresi: birden cok uygulamasi varsa secim ekrani, tek uygulamasi varsa dogrudan o (izleyici: filo, operator: tezgah basi). */
function homeHash(role) {
  const apps = appsFor(role);
  if (apps.length >= 2) return '#/uygulamalar';
  if (apps.length === 1) return apps[0].key === 'planlama' ? `#/planlama/${defaultPlanningTab(role)}` : apps[0].entry;
  return '#/filo';
}

function readRoute(depth = 0) {
  const hash = location.hash.replace(/^#/, '');
  const role = getSession()?.user?.role;
  const m = /^\/tezgah\/(.+)$/.exec(hash);
  const lm = /^\/programlar(?:\/(\d+))?$/.exec(hash);
  const pm = /^\/planlama(?:\/(tezgahbasi|paketleme|isemirleri|gkk|ilkonay|olcuraporlari|verimlilik|hammadde|urunler|siparisler|programlar))?$/.exec(hash);
  if (m) {
    state.view = 'machine';
    state.selected = decodeURIComponent(m[1]);
  } else if (lm) {
    state.view = 'library';
    state.selected = null;
    state.programId = lm[1] ? Number(lm[1]) : null;
  } else if (hash === '/ayarlar') {
    state.view = 'config';
    state.selected = null;
  } else if (hash === '/uretim') {
    state.view = 'production';
    state.selected = null;
  } else if (pm) {
    state.view = 'planning';
    state.selected = null;
    state.planningTab = pm[1] ?? defaultPlanningTab(role);
  } else if (hash === '/uygulamalar' || hash === '' || hash === '/') {
    state.view = 'apps';
    state.selected = null;
  } else {
    state.view = 'fleet';
    state.selected = null;
  }

  // Yetkisiz ekrana (adres cubuguna yazilsa bile) girilmez: kendi giris adresine doner. Sunucu bu uclari zaten reddeder;
  // burasi yalniz bos/hatali bir ekran gostermemek icindir.
  const allowed = new Set(appsFor(role).map((a) => a.key));
  const appKey = state.view === 'planning' ? 'planlama' : state.view === 'apps' ? 'apps' : 'telemetri';
  const adminOnlyTelemetry = state.view === 'library' || state.view === 'config'; // viewer'a kapali telemetri ekranlari
  const denied = appKey === 'apps' ? allowed.size < 2 : !allowed.has(appKey) || (adminOnlyTelemetry && role !== 'admin');
  if (denied) {
    const home = homeHash(role);
    if (location.hash !== home) history.replaceState(null, '', home);
    if (depth < 2 && hash !== home.replace(/^#/, '')) return readRoute(depth + 1); // en cok iki kez: yetkisiz rolde sonsuz dongu olmasin
  }
  // planlama bolumu rolun gorebildigi bolumlerden degilse (operator: yalniz tezgah basi) varsayilana doner
  if (state.view === 'planning' && !planningTabsFor(role).includes(state.planningTab)) {
    state.planningTab = defaultPlanningTab(role);
    history.replaceState(null, '', `#/planlama/${state.planningTab}`);
  }
  if (state.view === 'apps' && hash !== '/uygulamalar') history.replaceState(null, '', '#/uygulamalar');
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
  refs.libraryBtn.classList.toggle('is-active', state.view === 'library');
  refs.productionBtn.classList.toggle('is-active', state.view === 'production');
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
    (m.controllerModelLabel ? ` · ${escapeHtml(m.controllerModelLabel)}` : '') +
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

    // Vardiya adetleri (07-19 / 19-07, program bazinda, yanlarinda parca suresi): izleme verisi, viewer da gorur.
    '<section class="dt-block" data-role="production"></section>' +

    '<section class="dt-block">' +
    '<div class="dt-block-head">' +
    '<h3>Durum şeridi</h3>' +
    '<div class="dt-actions">' +
    '<div class="seg" data-role="windows" role="group" aria-label="Zaman aralığı"></div>' +
    '<a class="icon-btn" data-role="csv" download title="Seçili zaman aralığı. Özet: üretilen her parça ve durum / program / alarm değişimleri; arada geçen saniyelik satırlar yok">CSV indir</a>' +
    '<a class="icon-btn" data-role="csv-raw" download title="Seçili zaman aralığı. Kaydedilen her örnek (eski biçim)">Ham CSV</a>' +
    '</div>' +
    '</div>' +
    '<div class="tl-host" data-role="timeline"></div>' +
    '<ul class="legend" data-role="legend"></ul>' +
    '<div class="dt-summary" data-role="summary"></div>' +
    '</section>' +

    '<section class="dt-block">' +
    '<h3>En uzun duruşlar</h3>' +
    '<div data-role="downtimes"></div>' +
    '</section>' +

    // Program kutuphanesi ile karsilastirma ve tezgaha program gonderme: YALNIZ yonetici.
    (isAdmin() ? '<section class="dt-block" data-role="programs"></section>' : '') +

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
  const programsHost = refs.detail.querySelector('[data-role="programs"]');
  if (programsHost) renderMachinePrograms(programsHost, m);
  initMachineProduction(refs.detail.querySelector('[data-role="production"]'), m.machineId);

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
      fetch(`/api/machines/${encodeURIComponent(id)}/history?window=${win}&maxPoints=50`).then((r) => r.json()),
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
  const csvRaw = refs.detail.querySelector('[data-role="csv-raw"]');
  if (csvRaw) {
    csvRaw.href = `/api/machines/${encodeURIComponent(state.selected)}/export.csv?window=${state.window}&format=ham`;
  }
}

/* ----------------------------------------------------------------------- cizim */

/** Uygulamaya gore kabuk: hangi yan menu, ust cubuk yazisi, baglanti gostergesi ve alt bilgi gorunur. */
/**
 * Yan menu(ler) pencereye SIGAR ve gerekirse KENDI kaydirma cubuguyla kayar: uzun menude ("Ayarlar", "Program kutuphanesi" ...) alt kisma ulasmak icin
 * butun sayfayi kaydirmak gerekmez. Menu sticky: sayfa basinda ust cubugun altinda durur, kaydirinca pencerenin 14 px altina yapisir; her iki durumda
 * yukseklik "pencere - menunun ustu - 14 px" olmali, bu yuzden olculur. Dar ekranda menu sayfa akisindadir (sinir yok).
 */
function fitSidebars() {
  const narrow = matchMedia('(max-width: 900px)').matches;
  for (const sb of document.querySelectorAll('.sidebar')) {
    if (sb.hidden || narrow) { sb.style.maxHeight = ''; continue; }
    const top = Math.max(sb.getBoundingClientRect().top, 14);
    sb.style.maxHeight = `${Math.max(180, Math.floor(innerHeight - top - 14))}px`;
  }
}
let fitQueued = false;
/** Kaydirma/yeniden boyutlandirmada her karede en fazla bir kez olcer. */
function queueFitSidebars() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitSidebars(); });
}

function syncChrome(view) {
  const app = view === 'apps' ? 'apps' : view === 'planning' ? 'planlama' : 'telemetri';
  const tele = app === 'telemetri';
  refs.app.dataset.app = app;
  refs.sidebar.hidden = !tele;
  // tek bolumlu kullanicida (operator: yalniz tezgah basi) yan menu gereksiz
  refs.planNav.hidden = app !== 'planlama' || (planningTabsFor(getSession()?.user?.role).length < 2 && !isAdmin());
  refs.conn.hidden = !tele;
  refs.footer.hidden = !tele;
  refs.appsView.hidden = app !== 'apps';
  refs.planningView.hidden = app !== 'planlama';
  if (!tele) {
    for (const el of [refs.fleetView, refs.detail, refs.configView, refs.libraryView, refs.productionView]) el.hidden = true;
  }
  refs.eyebrow.textContent = app === 'planlama' ? 'Planlama · iş emri ve verimlilik' : app === 'apps' ? 'CNC-TLM-001' : 'CNC-TLM-001 · Canlı Telemetri';
  if (app === 'planlama') refs.title.textContent = 'Planlama';
  else if (app === 'apps') refs.title.textContent = 'Uygulama Seçimi';
  document.title = app === 'planlama' ? 'Planlama' : app === 'apps' ? 'CNC Telemetri Platformu' : 'CNC Filo Telemetrisi';
  refs.appsBtn.hidden = app === 'apps' || appsFor(getSession()?.user?.role).length < 2;
  fitSidebars(); // hangi yan menu gorunuyorsa yuksekligi yeniden olculur
}

function render() {
  syncChrome(state.view);
  // Telemetri verisine bagli olmayan iki ekran: SSE'nin ilk karesini beklemeden cizilir.
  if (state.view === 'apps') {
    if (state.prevView !== 'apps') renderApps(refs.appsView, appsFor(getSession()?.user?.role), getSession()?.authDisabled ? undefined : getSession()?.user);
    state.prevView = 'apps';
    return;
  }
  if (state.view === 'planning') {
    // Planlama kendi verisini ceker; yalnizca rota/bolum degisince (ya da ekrana ilk girilince) cizilir, SSE karelerinde dokunulmaz.
    const key = state.planningTab;
    if (state.prevView !== 'planning') delete refs.planningView.dataset.key;
    if (refs.planningView.dataset.key !== key) {
      refs.planningView.dataset.key = key;
      renderPlanningNav(refs.planNav, key);
      renderPlanning(refs.planningView, key);
    }
    state.prevView = 'planning';
    return;
  }

  const snap = state.snapshot;
  if (!snap) return;
  renderSidebar();

  const m = state.view === 'machine' ? machineById(state.selected) : null;
  // Adres cubugunda olmayan bir tezgah yaziliysa filoya dusulur.
  const view = state.view === 'machine' && m === null ? 'fleet' : state.view;

  refs.fleetView.hidden = view !== 'fleet';
  refs.detail.hidden = view !== 'machine';
  refs.configView.hidden = view !== 'config';
  refs.libraryView.hidden = view !== 'library';
  refs.productionView.hidden = view !== 'production';

  refs.title.textContent =
    view === 'machine' ? m.name
      : view === 'config' ? 'Ayarlar'
        : view === 'production' ? 'Üretim Raporu'
          : view === 'library' ? 'Program Kütüphanesi' : 'Filo Genel Bakış';

  if (view === 'machine') {
    if (state.detailFor !== m.machineId) {
      renderDetailStatic(m);
      state.history = null;
      refreshHistory();
    }
    patchDetail(m);
  } else if (view === 'library') {
    // Kutuphane kendi verisini ceker; yalnizca rota degisince (ya da ekrana ilk
    // girildiginde) cizilir, SSE karelerinde dokunulmaz.
    const key = `${state.programId}`;
    if (state.prevView !== 'library') {
      resetLibraryView(); // girerken taze veri
      delete refs.libraryView.dataset.key;
    }
    if (refs.libraryView.dataset.key !== key) {
      refs.libraryView.dataset.key = key;
      renderLibrary(refs.libraryView, state.programId);
    }
  } else if (view === 'production') {
    // Uretim raporu kendi verisini ceker (kendi 15 sn dongusuyle tazelenir); SSE karelerinde yeniden cizilmez.
    if (state.prevView !== 'production') {
      resetProductionView();
      delete refs.productionView.dataset.ready;
    }
    if (!refs.productionView.dataset.ready) {
      refs.productionView.dataset.ready = '1';
      renderProduction(refs.productionView);
    }
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

  state.prevView = view;

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
  es.addEventListener('error', () => {
    setConn('bağlantı kesildi — yeniden deneniyor', false);
    // Kopma oturum bitisinden mi? (bittiyse giris ekranina doner; yalniz ag sorunuysa akis kendi yeniden baglanir)
    checkSessionAfterStreamError();
  });
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

async function init() {
  // Once giris: oturum yoksa giris/ilk kurulum ekrani gelir ve giris yapilana dek burada beklenir.
  await initAuth();

  refs.machineList = $('#machine-list');
  refs.fleetBtn = $('#fleet-btn');
  refs.configBtn = $('#config-btn');
  refs.configView = $('#config-view');
  refs.libraryBtn = $('#library-btn');
  refs.libraryView = $('#library-view');
  refs.productionBtn = $('#production-btn');
  refs.planningView = $('#planning-view');
  refs.planNav = $('#plan-sidebar');
  refs.appsView = $('#apps-view');
  refs.appsBtn = $('#apps-btn');
  refs.app = $('.app');
  refs.eyebrow = $('#eyebrow');
  refs.footer = $('.footnote');
  refs.productionView = $('#production-view');
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
  refs.libraryBtn.addEventListener('click', () => { location.hash = '#/programlar'; });
  refs.productionBtn.addEventListener('click', () => { location.hash = '#/uretim'; });
  refs.appsBtn.addEventListener('click', () => { location.hash = '#/uygulamalar'; });
  refs.planNav.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-tab]')?.dataset.tab;
    if (tab) location.hash = `#/planlama/${tab}`;
  });
  // Izleyici: program kutuphanesi ve ayarlar menuden de kalkar.
  refs.libraryBtn.hidden = !isAdmin();
  refs.configBtn.hidden = !isAdmin();
  addEventListener('hashchange', () => { readRoute(); render(); });
  addEventListener('scroll', queueFitSidebars, { passive: true });
  addEventListener('resize', queueFitSidebars);

  initTheme();
  initKeyboard();
  readRoute();
  connect();

  setInterval(() => {
    if (!state.selected) return;
    refreshHistory();
    refreshMachineProduction();
  }, HISTORY_REFRESH_MS);
  // Pencere boyutu degisince grafikler yeniden olculmeli.
  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawHistory, 150);
  });
}

init().catch((err) => {
  console.error('[dashboard] baslatilamadi', err);
  document.body.insertAdjacentHTML('afterbegin', `<p class="notice notice-sim" style="margin:16px">Arayüz başlatılamadı: ${escapeHtml(err.message)}</p>`);
});
