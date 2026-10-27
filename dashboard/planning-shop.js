/**
 * Planlama > Tezgah başı: fabrika bilgisayarındaki OPERATÖR ekranı (ortak hesap) ve yönetici için aynı görünüm.
 *
 * Tezgah başına bir kart: canlı durum, ÇALIŞAN PROGRAM (iş emri bağlı olmasa da: ne zamandır, kaç parça, hangi ürün; iş emri yukarıdan "İş emrini bağla" ile bağlanır), üretimdeki iş emri ve ilerlemesi, "İş emrini düzenle" (ilk onay rapor no, ölçülen net gramaj...), sırada bekleyen iş emirleri ("Başlat"), "Bitir" ve
 * duruş nedenleri. Duruşun SÜRESİ telemetriden gelir; operatör yalnız NEDENİ seçer (dakika yazmaz). Bir duruş birden çok nedene bölünebilir.
 * Ürün tanıtım kartı (tek adım): kasa dolunca usta iş emrinde "Ürün tanıtım kartı bas" der, kartı kasaya atıp kasayı paketlemeye yollar
 * (kart numarasını sistem verir; iş emri bittikten sonra da basılabilir). Kesin adet Paketleme bölümünde girilir.
 * Büyük dokunmatik düğmeler (tablet gelince aynı ekran). Veri 10 sn'de bir tazelenir.
 */
import { escapeHtml, stateOf } from './format.js';
import { api, post } from './lib-common.js';
import { del, cellText, fmtNum, fmtDec, openModal, chip, debounce, rememberedPerson, rememberPerson, isViewer, sectionClosed, truncCell } from './planning-common.js';
import { openStartDialog, openFinishDialog, openEditFieldsDialog } from './planning-production.js';
import { openCrateCard, openIssueCard } from './planning-card.js';
import { openMeasureDialog, openMeasureReport } from './planning-measure.js';
import { openWorkOrderForm } from './planning-wo-form.js';
import { createFirstApproval } from './planning-approvals.js';

const REFRESH_MS = 10_000;
const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', hour12: false });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** Bugün değilse gün ile birlikte. */
const when = (ms) => (sameDay(ms, Date.now()) ? hm(ms) : `${new Date(ms).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' })} ${hm(ms)}`);
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} sa ${pad(m % 60)} dk` : `${m} dk`;
};
/** ms -> <input type="datetime-local"> değeri (yerel). */
const localDt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const STATE_NOUN = Object.freeze({ IDLE: 'boşta', ALARM: 'alarm', OFF: 'kapalı' });
/** Programın hangi ürüne ait sayıldığı: eşleme kesin, diğerleri kural önerisi. */
const PRODUCT_HOW = Object.freeze({ esleme: 'programla eşli', kod: 'stok koduyla tanındı', 'musteri-kodu': 'müşteri ürün koduyla tanındı', ad: 'ürün adıyla tanındı, öneri' });

/* ============================================================ ana ekran */

/** @param {HTMLElement} host */
export async function renderShop(host) {
  const token = Symbol('shop');
  host.__shopToken = token;
  host.innerHTML =
    '<p class="hint" data-role="info">Yükleniyor…</p><div class="shop-grid" data-role="grid"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  let last = '';
  let data = null;
  const readOnly = isViewer(); // izleyici: her şeyi görür, hiçbir şeyi değiştiremez (sunucu da reddeder)

  /** Üretimdeki iş emrinin GKK ve ilk onay numaraları (ustaların iş emrine yazdığı). */
  function refsBlock(a) {
    const approval = a.firstApprovalNo
      ? `<b class="mono">${escapeHtml(a.firstApprovalNo)}</b>`
      : (readOnly ? '<span class="is-null">yok</span>' : '<span class="is-null">alınmadı</span>');
    return `<p class="hint shop-refs">GKK rapor no: ${a.gkkReportNo ? `<b class="mono">${escapeHtml(a.gkkReportNo)}</b>` : '<span class="is-null">yok</span>'}` +
      ` · İlk onay: ${approval}${a.material ? ` · hammadde <span class="mono">${escapeHtml(a.material)}</span>` : ''}</p>`;
  }

  /** Üretimdeki iş emrinin kart satırı: basılan kart sayısı, son kart ve "Ürün tanıtım kartı bas". */
  function cardBlock(a) {
    const c = a.cards ?? { count: 0, last: null };
    const info = c.last
      ? `${fmtNum(c.count)} kart basıldı · son <b class="mono">${escapeHtml(c.last.cardNo)}</b> (${escapeHtml(when(c.last.at))})`
      : 'Bu iş emri için henüz kart basılmadı';
    const legacy = a.crate ? ` · açık kasa <span class="mono">${escapeHtml(a.crate.cardNo)}</span> (kart basılınca kapanır)` : '';
    const ms = a.measure ?? { rows: 0, last: null };
    const msInfo = ms.rows === 0 ? 'Ölçü kontrolü: ölçüler henüz tanımlı değil' : ms.last ? `Son ölçü ${when(ms.last)} (${escapeHtml(dur(data.now - ms.last))} önce)` : 'Ölçü kontrolü: henüz ölçüm girilmedi';
    const formBtn = `<button type="button" class="icon-btn shop-btn" data-act="wo-form" data-no="${escapeHtml(a.no)}" title="İş emri formu ve teknik resimler">İş emri formu</button>`;
    if (readOnly) {
      return `<div class="shop-crate"><p class="hint">${info}</p><p class="hint">${msInfo}</p>` +
        `<div class="shop-actions">${formBtn}<button type="button" class="icon-btn shop-btn" data-act="measure-report" data-no="${escapeHtml(a.no)}">Ölçü raporu</button>` +
        `${c.last ? `<button type="button" class="icon-btn shop-btn" data-act="crate-card" data-id="${c.last.id}">Son kartı göster</button>` : ''}</div></div>`;
    }
    return `<div class="shop-crate"><p class="hint">${info}${legacy}</p><p class="hint">${msInfo}</p>` +
      `<div class="shop-actions">${formBtn}<button type="button" class="icon-btn shop-btn" data-act="measure" data-no="${escapeHtml(a.no)}">Ölçü kontrolü</button>` +
      `<button type="button" class="icon-btn shop-btn" data-act="measure-report" data-no="${escapeHtml(a.no)}">Ölçü raporu</button>` +
      `<button type="button" class="icon-btn shop-btn btn-primary" data-act="card-issue" data-no="${escapeHtml(a.no)}">Ürün tanıtım kartı bas</button>` +
      `${c.last ? `<button type="button" class="icon-btn shop-btn" data-act="crate-card" data-id="${c.last.id}">Son kartı yeniden yazdır</button>` : ''}</div></div>`;
  }

  /** Tezgahta SU AN calisan program (is emri baglanmasa da): ad, ne zamandir, kac parca, hangi urun; is emri bagliysa capraz denetim. */
  function programBlock(m) {
    const p = m.program;
    if (!p || p.state === 'veri-yok') return '<p class="hint shop-program">Çalışan program bilinmiyor: tezgahtan veri gelmiyor.</p>';
    if (p.state === 'program-yok') return '<p class="hint shop-program">Çalışan program okunamıyor.</p>';
    const since = p.startedAt ? ` · <b>${escapeHtml(dur(data.now - p.startedAt))}</b>'dır (${escapeHtml(when(p.startedAt))}'den beri)` : '';
    const parts = p.parts != null ? ` · <b>${fmtNum(p.parts)}</b> parça${p.approx ? ' (yaklaşık)' : ''}` : '';
    const sub = p.subProgram ? ` · alt program <span class="mono">${escapeHtml(p.subProgram)}</span>` : '';
    const product = p.product
      ? `Ürün: <b class="mono">${escapeHtml(p.product.stockCode)}</b> ${cellText(p.product.name)} <span class="hint">(${escapeHtml(PRODUCT_HOW[p.product.how] ?? p.product.how)})</span>`
      : p.ambiguous.length ? `Ürün belirsiz: birden çok ürün bu koda uyuyor (${escapeHtml(p.ambiguous.join(', '))}); Program eşleme sekmesinden eşleyin.`
      : 'Ürün tanınmadı: Program eşleme sekmesinden eşleyin.';
    const mismatch = p.mismatch ? ` ${chip('bad', '▲', 'program başka ürüne ait')} <span class="hint">bağlı iş emri ${escapeHtml(p.mismatch.woStockCode)}</span>` : '';
    return `<div class="shop-program"><p><span aria-hidden="true">▶</span> Çalışan program: <b class="mono">${escapeHtml(p.name)}</b>${sub}${since}${parts}</p><p class="hint">${product}${mismatch}</p></div>`;
  }

  /** İş emri bağlı değilken: çalışan programa uyan bekleyen iş emirleri; "İş emrini bağla" sayımı programın başladığı andan başlatır. */
  function waitingBlock(m) {
    const w = m.program?.waiting ?? [];
    if (w.length === 0) return '';
    const start = m.program.startedAt;
    return '<p class="hint">Bu programa uyan bekleyen iş emirleri:</p><ul class="shop-planned">' + w.map((x) =>
      `<li><span><b class="mono">${escapeHtml(x.no)}</b> · <span class="mono">${escapeHtml(x.stockCode)}</span> · hedef ${fmtNum(x.targetQty)}` +
      `${x.machineId && x.machineId !== m.id ? ` · <span class="hint">${escapeHtml(x.machineId)} için planlı</span>` : ''}<br><span class="shop-prod">${cellText(x.productName)}</span></span>` +
      `<span class="shop-li-actions"><button type="button" class="icon-btn shop-btn" data-act="wo-form" data-no="${escapeHtml(x.no)}" title="İş emri formu ve teknik resimler">Form</button>` +
      (readOnly ? '' : `<button type="button" class="icon-btn shop-btn btn-primary" data-act="bind" data-no="${escapeHtml(x.no)}"${start ? ` data-start="${start}"` : ''} data-program="${escapeHtml(m.program.name)}" title="Üretim sayımı programın başladığı andan itibaren (en fazla 72 saat geriye) yapılır">İş emrini bağla</button>`) + '</span></li>').join('') + '</ul>';
  }

  function cardHtml(m) {
    const live = m.live;
    const info = stateOf(live?.connected ? live.state : 'NO_DATA');
    const stateChip = `<span class="chip chip-${info.cls === 'run' ? 'ok' : info.cls === 'alarm' ? 'bad' : info.cls === 'idle' ? 'info' : 'none'}"><span aria-hidden="true">${info.icon}</span> ${escapeHtml(info.label)}</span>`;
    let body;
    if (m.active) {
      const a = m.active;
      const over = a.produced > a.targetQty;
      body =
        `<p class="shop-wo"><b class="mono">${escapeHtml(a.no)}</b> · <span class="mono">${escapeHtml(a.stockCode)}</span><br><span class="shop-prod">${cellText(a.productName)}</span></p>` +
        `<div class="pl-meter" role="img" aria-label="${fmtNum(a.produced)} / ${fmtNum(a.targetQty)} adet"><span class="${over ? 'is-over' : ''}" style="width:${Math.min(100, a.pct ?? 0)}%"></span></div>` +
        `<p class="pl-meter-t"><b>${fmtNum(a.produced)} / ${fmtNum(a.targetQty)} adet</b> · %${fmtDec(a.pct ?? 0, 0)}${a.remaining > 0 ? ` · kalan ${fmtNum(a.remaining)}` : ''}</p>` +
        `<p class="hint">başlangıç ${escapeHtml(when(a.startedAt))}${a.eta ? ` · tahmini bitiş ${escapeHtml(when(a.eta.ms))}` : ''}${a.eta?.lateRisk ? ` ${chip('bad', '▲', 'termin riski')}` : ''}${a.warnings > 0 ? ` ${chip('info', '▲', `${a.warnings} uyarı`)}` : ''}</p>` +
        refsBlock(a) +
        cardBlock(a) +
        (readOnly ? '' : `<div class="shop-actions"><button type="button" class="icon-btn shop-btn" data-act="edit-wo" data-no="${escapeHtml(a.no)}" title="İlk onay rapor no, ölçülen net gramaj, GKK rapor no...">İş emrini düzenle</button>` +
          `<button type="button" class="icon-btn shop-btn" data-act="approval-new" data-no="${escapeHtml(a.no)}" title="İlk parça ölçülüp onaylanınca sıradaki ilk onay numarasını verir">İlk onay numarası al</button>` +
          `<button type="button" class="icon-btn shop-btn btn-primary" data-act="finish" data-no="${escapeHtml(a.no)}">İş emrini bitir</button></div>`);
    } else {
      const running = m.program?.state === 'calisiyor';
      const shown = new Set((m.program?.waiting ?? []).map((x) => x.no));
      const planned = m.planned.filter((x) => !shown.has(x.no)); // bagla listesinde zaten gosterilenler tekrarlanmaz
      body =
        `<p class="hint shop-none">${running ? '<b>İş emri bağlı değil.</b> Program çalışıyor; üretim, iş emri bağlanınca programın başladığı andan (en fazla 72 saat) geriye dönük sayılır.' : 'Bu tezgahta üretimde iş emri yok.'}</p>` +
        waitingBlock(m) +
        // Son kasa iş emri bittikten sonra da dolabilir: son 24 saatte biten iş emri için kart basılabilir.
        (m.finished
          ? `<div class="shop-crate"><p class="hint">Son biten iş emri: <b class="mono">${escapeHtml(m.finished.no)}</b> · <span class="mono">${escapeHtml(m.finished.stockCode)}</span> (${escapeHtml(when(m.finished.finishedAt))})</p>` +
            `<div class="shop-actions"><button type="button" class="icon-btn shop-btn" data-act="wo-form" data-no="${escapeHtml(m.finished.no)}">İş emri formu</button>` +
            (readOnly ? '' : `<button type="button" class="icon-btn shop-btn" data-act="card-issue" data-no="${escapeHtml(m.finished.no)}">Ürün tanıtım kartı bas</button>`) + '</div></div>'
          : '') +
        (planned.length
          ? `<ul class="shop-planned">${planned.slice(0, 3).map((w) =>
            `<li><span><b class="mono">${escapeHtml(w.no)}</b> · <span class="mono">${escapeHtml(w.stockCode)}</span> · hedef ${fmtNum(w.targetQty)}<br><span class="shop-prod">${cellText(w.productName)}</span></span>` +
            `<span class="shop-li-actions"><button type="button" class="icon-btn shop-btn" data-act="wo-form" data-no="${escapeHtml(w.no)}" title="İş emri formu ve teknik resimler">Form</button>` +
            (readOnly ? '' : `<button type="button" class="icon-btn shop-btn btn-primary" data-act="start" data-no="${escapeHtml(w.no)}">Başlat</button>`) + '</span></li>').join('')}</ul>`
          : (shown.size > 0 ? '' : '<p class="hint">Bu tezgaha atanmış bekleyen iş emri yok.</p>')) +
        (readOnly ? '' : `<div class="shop-actions"><button type="button" class="icon-btn shop-btn" data-act="pick">Başka iş emri başlat…</button></div>`);
    }
    const s = m.stops;
    const stopBtn = s.pending > 0
      ? `<button type="button" class="icon-btn shop-btn shop-stopbtn is-warn" data-act="stops"><span aria-hidden="true">▲</span> ${s.pending} duruşun nedeni ${readOnly ? 'girilmemiş' : 'bekliyor'} (${escapeHtml(dur(s.pendingMs))})</button>`
      : '<button type="button" class="icon-btn shop-btn shop-stopbtn" data-act="stops">Duruşlar</button>';
    const ongoing = s.ongoing != null ? `<p class="hint shop-ongoing"><span aria-hidden="true">❙❙</span> Şu an duruyor: ${escapeHtml(dur(data.now - s.ongoing))} (${escapeHtml(hm(s.ongoing))}'den beri)</p>` : '';
    return `<article class="shop-card${m.active ? ' is-running' : ''}" data-machine="${escapeHtml(m.id)}">` +
      `<header class="shop-head"><div><h3>${escapeHtml(m.name)}</h3><span class="mono hint">${escapeHtml(m.id)}</span></div>${stateChip}</header>` +
      `${programBlock(m)}${ongoing}${body}${stopBtn}</article>`;
  }

  function draw() {
    const key = JSON.stringify(data.machines);
    $('info').textContent = `Her ${REFRESH_MS / 1000} sn'de bir tazelenir · ${data.minStopMinutes} dk'dan uzun duruşların nedeni sorulur${sectionClosed('paketleme') ? '' : ` · paketleme bekleyen kasa: ${data.packing?.waiting ?? 0}`} · son güncelleme ${new Date(data.now).toLocaleTimeString('tr-TR', { hour12: false })}`;
    if (key === last) return; // değişmediyse yeniden çizme (düğmeler/odak yerinde kalsın)
    last = key;
    $('grid').innerHTML = data.machines.map(cardHtml).join('');
  }

  async function load() {
    try {
      data = await api('/api/planning/shop/overview');
      draw();
    } catch (err) {
      $('info').textContent = `Alınamadı: ${err.message}`;
    }
  }

  const refresh = () => load();
  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const machine = btn.closest('.shop-card')?.dataset.machine;
    const act = btn.dataset.act;
    if (act === 'start') openStartDialog(btn.dataset.no, refresh, { machineId: machine });
    else if (act === 'bind') {
      const at = Number(btn.dataset.start) || null;
      openStartDialog(btn.dataset.no, refresh, {
        machineId: machine, startAt: at,
        startNote: at ? `Tezgahta çalışan program ${btn.dataset.program}, ${when(at)} itibarıyla çalışıyor.` : '',
      });
    }
    else if (act === 'finish') openFinishDialog(btn.dataset.no, refresh);
    else if (act === 'edit-wo') openEditFieldsDialog(btn.dataset.no, refresh);
    else if (act === 'pick') openPicker(machine, refresh);
    else if (act === 'stops') openStopsDialog(machine, data.machines.find((x) => x.id === machine)?.name ?? machine, refresh, { readOnly });
    else if (act === 'card-issue') openIssueCard(btn.dataset.no, refresh);
    else if (act === 'measure') openMeasureDialog(btn.dataset.no, refresh);
    else if (act === 'measure-report') openMeasureReport(btn.dataset.no);
    else if (act === 'wo-form') openWorkOrderForm(btn.dataset.no);
    else if (act === 'approval-new') createFirstApproval(btn.dataset.no, refresh);
    else if (act === 'crate-card') openCrateCard(Number(btn.dataset.id));
  };

  await load();
  const timer = setInterval(() => {
    if (host.__shopToken !== token || !host.isConnected) { clearInterval(timer); return; }
    load();
  }, REFRESH_MS);
}

/* ===================================================== başka iş emri seç */

/** Bekleyen (planlandı) herhangi bir iş emrini, bu tezgahta başlatmak için seç. */
function openPicker(machineId, onDone) {
  const m = openModal({ title: `Bu tezgahta başlatılacak iş emri · ${machineId}` });
  m.body.innerHTML =
    '<input type="search" class="pl-search" data-role="q" placeholder="İş emri no, ürün ya da müşteri sipariş no…" aria-label="İş emri ara" autocomplete="off">' +
    '<div class="table-wrap" data-role="list"></div>';
  const list = m.body.querySelector('[data-role="list"]');
  let seq = 0;
  async function load() {
    const my = ++seq;
    const q = m.body.querySelector('[data-role="q"]').value.trim();
    try {
      const r = await api(`/api/planning/work-orders?${new URLSearchParams({ status: 'planlandi', q, limit: 50 })}`);
      if (my !== seq) return;
      list.innerHTML = r.items.length === 0 ? '<p class="empty">Bekleyen iş emri yok.</p>' :
        '<table class="tbl tbl-pl"><tbody>' + r.items.map((w) =>
          `<tr class="pl-row" data-no="${escapeHtml(w.no)}" tabindex="0"><td class="mono"><b>${escapeHtml(w.no)}</b></td><td class="trunc"${truncCell(w.productName)}><span class="mono">${escapeHtml(w.stockCode)}</span> ${cellText(w.productName)}</td>` +
          `<td class="num">${fmtNum(w.targetQty)}</td><td class="mono">${escapeHtml(w.machineId)}</td></tr>`).join('') + '</tbody></table>';
    } catch (err) {
      list.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }
  const search = debounce(load, 250);
  m.body.addEventListener('input', (ev) => { if (ev.target.dataset?.role === 'q') search(); });
  const pick = (ev) => {
    const row = ev.target.closest('.pl-row');
    if (!row) return;
    m.close();
    openStartDialog(row.dataset.no, onDone, { machineId });
  };
  list.addEventListener('click', pick);
  list.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(ev); });
  m.body.querySelector('[data-role="q"]').focus();
  load();
}

/* ============================================================ duruşlar */

let codesCache = null;
async function codes() {
  codesCache ??= await api('/api/planning/downtime-codes');
  return codesCache;
}

/** Bir tezgahın son 24 saatteki ölçülmüş duruşları; her biri için neden seç / kaldır. */
export async function openStopsDialog(machineId, name, onChanged = () => {}, { readOnly = false } = {}) {
  const m = openModal({ title: `Duruşlar · ${name}`, wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let r;
  try {
    r = await api(`/api/planning/shop/stops?${new URLSearchParams({ machine: machineId, hours: 24 })}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }

  function draw() {
    const stops = r.stops;
    m.body.innerHTML =
      `<p class="hint">Son 24 saatte ${r.minStopMinutes} dakikadan uzun ${stops.length} duruş. Süre tezgahtan ölçülür${readOnly ? '; nedenleri fabrika ekranında ustalar girer' : '; siz yalnız nedenini seçersiniz. Bir duruşu birden çok nedene bölebilirsiniz (ör. 40 dk çubuk değişimi + 20 dk ayarcı bekleme)'}.</p>` +
      (stops.length === 0 ? '<p class="empty">Nedeni sorulacak duruş yok.</p>' : stops.map((s, i) => {
        const parts = Object.entries(s.states).map(([k, v]) => `${STATE_NOUN[k] ?? k} ${dur(v)}`).join(' · ');
        const info = stateOf(s.dominant);
        return `<section class="stop${s.answered ? ' is-answered' : ''}" data-i="${i}">` +
          `<header class="stop-head"><b>${escapeHtml(when(s.from))} – ${s.ongoing ? 'şimdi' : escapeHtml(hm(s.to))}</b> · ${escapeHtml(dur(s.durationMs))} ` +
          `<span class="chip chip-${s.dominant === 'ALARM' ? 'bad' : 'info'}"><span aria-hidden="true">${info.icon}</span> ${escapeHtml(parts)}</span>` +
          `${s.ongoing ? ` ${chip('info', '❙❙', 'şu an sürüyor')}` : ''}</header>` +
          (s.reasons.length ? `<ul class="stop-reasons">${s.reasons.map((x) =>
            `<li><span class="chip chip-ok"><span aria-hidden="true">✓</span> <b>${escapeHtml(x.code)}</b> ${escapeHtml(x.name ?? '')}</span> <span class="hint">${escapeHtml(hm(x.from))}–${escapeHtml(hm(x.to))} (${escapeHtml(dur(x.to - x.from))})${x.person ? ` · ${escapeHtml(x.person)}` : ''}${x.note ? ` · ${escapeHtml(x.note)}` : ''}</span> ` +
            (readOnly ? '' : `<button type="button" class="icon-btn icon-btn-sm" data-act="remove" data-id="${x.id}">Kaldır</button>`) + '</li>').join('')}</ul>` : '') +
          (s.answered ? '' : `<p class="stop-open"><span aria-hidden="true">▲</span> Nedeni belirsiz: <b>${escapeHtml(dur(s.uncoveredMs))}</b> ` +
            (readOnly ? '' : `<button type="button" class="icon-btn shop-btn btn-primary" data-act="reason" data-i="${i}">Neden seç…</button>`) + '</p>') +
          '</section>';
      }).join(''));
  }

  async function reload() {
    r = await api(`/api/planning/shop/stops?${new URLSearchParams({ machine: machineId, hours: 24 })}`);
    draw();
    onChanged();
  }

  m.body.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || readOnly) return;
    if (btn.dataset.act === 'reason') {
      const stop = r.stops[Number(btn.dataset.i)];
      openReasonPicker(machineId, stop, reload);
    } else if (btn.dataset.act === 'remove') {
      btn.disabled = true;
      try { await del(`/api/planning/shop/downtime-reasons/${btn.dataset.id}`); await reload(); } catch (e) { btn.disabled = false; window.alert(e.message); }
    }
  });
  draw();
}

/** İki adım: kod seç (büyük düğmeler, gruplu) -> süre/not/kişi -> kaydet. */
async function openReasonPicker(machineId, stop, onSaved) {
  const m = openModal({ title: 'Duruş nedeni seç' });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let cfg;
  try {
    cfg = await codes();
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const gap = stop.uncovered[0] ?? { from: stop.from, to: stop.to };
  const st = { tab: 'sik' };

  function pickStep() {
    const tabs = [{ id: 'sik', label: 'Sık kullanılanlar' }, ...cfg.groups.map((g) => ({ id: g.id, label: g.label }))];
    const list = st.tab === 'sik' ? cfg.codes.filter((c) => c.frequent) : cfg.codes.filter((c) => c.group === st.tab);
    m.body.innerHTML =
      `<p class="hint">${escapeHtml(when(gap.from))} – ${escapeHtml(hm(gap.to))} (${escapeHtml(dur(gap.to - gap.from))}) için neden:</p>` +
      `<div class="seg shop-tabs" role="group" aria-label="Neden grupları">${tabs.map((t) =>
        `<button type="button" data-tab="${t.id}" aria-pressed="${t.id === st.tab}"${t.id === st.tab ? ' class="is-on"' : ''}>${escapeHtml(t.label)}</button>`).join('')}</div>` +
      `<div class="shop-codes">${list.map((c) =>
        `<button type="button" class="shop-code" data-code="${escapeHtml(c.code)}"><b class="mono">${escapeHtml(c.code)}</b><span>${escapeHtml(c.name)}</span></button>`).join('')}</div>`;
  }

  function formStep(code) {
    m.body.innerHTML =
      `<p class="notice"><b class="mono">${escapeHtml(code.code)}</b> · ${escapeHtml(code.name)}</p>` +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld fld-touch"><span>Başlangıç</span><input name="from" type="datetime-local" value="${localDt(gap.from)}"></label>` +
      `<label class="fld fld-touch"><span>Bitiş</span><input name="to" type="datetime-local" value="${localDt(gap.to)}"></label>` +
      '<label class="fld fld-touch"><span>Yapan kişi (isteğe bağlı)</span><input name="person" maxlength="60"></label>' +
      '<label class="fld fld-touch"><span>Not (isteğe bağlı)</span><input name="note" maxlength="200"></label></div>' +
      '<p class="hint">Süre tezgahtan ölçüldü; yalnız duruşun bir kısmı bu nedenle ise bitişi öne çekin, kalan kısım için sonra başka neden seçersiniz.</p>' +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="back">Geri</button><button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>';
    const form = m.body.querySelector('form');
    form.elements.person.value = rememberedPerson();
    const dirty = new Set();
    form.addEventListener('input', (ev) => { if (ev.target.name === 'from' || ev.target.name === 'to') dirty.add(ev.target.name); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = m.body.querySelector('[data-role="err"]');
      const btn = form.querySelector('[type="submit"]');
      err.hidden = true;
      btn.disabled = true;
      // dokunulmamış saatler tam (saniyeli) değerleriyle gider: dakikaya yuvarlama durus sınırını aşmasın
      const from = dirty.has('from') ? new Date(form.elements.from.value).getTime() : gap.from;
      const to = dirty.has('to') ? new Date(form.elements.to.value).getTime() : gap.to;
      try {
        rememberPerson(form.elements.person.value);
        await post('/api/planning/shop/downtime-reasons', { machineId, from, to, code: code.code, person: form.elements.person.value, note: form.elements.note.value });
        m.close();
        await onSaved();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  m.body.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-tab]')?.dataset.tab;
    if (tab) { st.tab = tab; pickStep(); return; }
    const code = ev.target.closest('[data-code]')?.dataset.code;
    if (code) { formStep(cfg.codes.find((c) => c.code === code)); return; }
    if (ev.target.closest('[data-act="back"]')) pickStep();
  });
  pickStep();
}
