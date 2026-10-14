/**
 * Planlama > Program eşleme: tornalarda PARCA URETMIS programlar (telemetriden) ve hangi ürüne bağlı oldukları.
 * Oneri kurallari (backend/planning/program-map.js): stok koduyla birebir (SR001-013 = SR001.013), musteri koduyla, urun adinin basinda kod.
 * Oneri HICBIR ZAMAN kendiliginden uygulanmaz: onaylanir. Eslesmeyen program uretim raporuna "urun" olarak yansir (simdilik program adi).
 */
import { escapeHtml, dateTime } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, fmtNum, debounce, openModal, chip, cellText } from './planning-common.js';

const KIND_TEXT = Object.freeze({
  kod: 'stok koduyla birebir',
  'musteri-kodu': 'müşteri koduyla',
  ad: 'ürün adı bu kodla başlıyor (daha zayıf kanıt)',
});

/** @param {HTMLElement} host */
export function renderPrograms(host) {
  const st = { data: null, error: null };
  host.innerHTML = '<p class="empty">Yükleniyor…</p>';

  const status = (r) => (r.status === 'esli' ? chip('ok', '✓', 'eşli') : r.status === 'oneri' ? chip('warn', '▲', 'öneri var') : chip('none', '✕', 'eşleşmemiş'));

  function actions(r) {
    const attr = `data-program="${escapeHtml(r.program)}"`;
    if (r.status === 'esli') {
      return `<b class="mono">${escapeHtml(r.mapped.stockCode)}</b> <span class="hint" style="margin:0">${escapeHtml(r.mapped.productName ?? '')}</span> ` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="unmap" ${attr}>Kaldır</button>`;
    }
    const sug = r.suggestions.map((c) =>
      `<button type="button" class="icon-btn icon-btn-sm" data-act="map" data-code="${escapeHtml(c.stockCode)}" ${attr} title="${escapeHtml(c.name ?? '')}">` +
      `${escapeHtml(c.stockCode)} ✓ onayla</button>`).join(' ');
    const kind = r.suggestionKind ? `<span class="hint" style="margin:0">${escapeHtml(KIND_TEXT[r.suggestionKind] ?? '')}</span> ` : '';
    return `${kind}${sug} <button type="button" class="icon-btn icon-btn-sm" data-act="pick" ${attr}>Başka ürün seç…</button>`;
  }

  function draw() {
    if (st.error) { host.innerHTML = `<p class="notice notice-sim">Programlar alınamadı: ${escapeHtml(st.error)}</p>`; return; }
    const { programs, counts } = st.data;
    const exact = programs.filter((r) => r.status === 'oneri' && r.suggestionKind === 'kod' && r.suggestions.length === 1).length;
    host.innerHTML =
      '<p class="hint">Tornalarda parça üretmiş programlar. Program adı ürün kartına bağlanınca raporlar ve iş emirleri o ürünü tanır. ' +
      'Öneri, onaylamadan uygulanmaz.</p>' +
      `<p class="pl-counts">${chip('ok', '✓', `${fmtNum(counts.mapped)} eşli`)} ${chip('warn', '▲', `${fmtNum(counts.suggested)} öneri var`)} ` +
      `${chip('none', '✕', `${fmtNum(counts.unmatched)} eşleşmemiş`)}` +
      (exact > 0 ? ` <button type="button" class="icon-btn btn-primary" data-act="confirm-exact">Stok koduyla birebir tutan ${fmtNum(exact)} öneriyi onayla</button>` : '') + '</p>' +
      (programs.length === 0 ? '<p class="empty">Henüz parça üretimi kaydedilmiş program yok (tornalar çalışınca burada görünür).</p>' :
        '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th>Program</th><th>Tezgah</th><th class="num">Üretilen parça</th>' +
        '<th>Son görülme</th><th>Durum</th><th>Ürün / eylem</th></tr></thead><tbody>' +
        programs.map((r) =>
          `<tr><td class="mono"><b>${escapeHtml(r.program)}</b></td><td>${r.machines.length ? escapeHtml(r.machines.join(', ')) : '<span class="is-null">—</span>'}</td>` +
          `<td class="num">${r.seen ? fmtNum(r.parts) : '<span class="is-null" title="Şu an kayıtta üretimi yok">—</span>'}</td>` +
          `<td>${r.lastTs ? escapeHtml(dateTime(r.lastTs)) : '<span class="is-null">—</span>'}</td><td>${status(r)}</td><td>${actions(r)}</td></tr>`).join('') +
        '</tbody></table></div>');
  }

  async function load() {
    try {
      st.data = await api('/api/planning/programs');
      st.error = null;
    } catch (err) {
      st.error = err.message;
    }
    draw();
  }

  async function run(fn) {
    try { await fn(); } catch (err) { alert(`İşlem yapılamadı: ${err.message}`); }
    load();
  }

  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const { act, program, code } = btn.dataset;
    if (act === 'map') run(() => put('/api/planning/programs/map', { program, stockCode: code }));
    else if (act === 'unmap') run(() => del(`/api/planning/programs/map?${new URLSearchParams({ program })}`));
    else if (act === 'confirm-exact') run(() => post('/api/planning/programs/confirm-exact', {}));
    else if (act === 'pick') openProductPicker(program, (stockCode) => run(() => put('/api/planning/programs/map', { program, stockCode })));
  };
  load();
}

/** Urun arayip secme penceresi (eslesmeyen programa urun baglamak icin). */
function openProductPicker(program, onPick) {
  const m = openModal({ title: `"${program}" programı hangi ürün?` });
  m.body.innerHTML =
    '<input type="search" class="pl-search" data-role="q" placeholder="Stok kodu, ürün adı ya da müşteri kodu…" aria-label="Ürün ara">' +
    '<div data-role="res" class="pl-picker"><p class="empty">Aramaya başlayın.</p></div>';
  const q = m.body.querySelector('[data-role="q"]');
  const res = m.body.querySelector('[data-role="res"]');
  let seq = 0;
  const search = debounce(async () => {
    const my = ++seq;
    const text = q.value.trim();
    if (text === '') { res.innerHTML = '<p class="empty">Aramaya başlayın.</p>'; return; }
    try {
      const r = await api(`/api/planning/programs/product-search?${new URLSearchParams({ q: text, limit: 30 })}`);
      if (my !== seq) return;
      res.innerHTML = r.items.length === 0 ? '<p class="empty">Eşleşen ürün yok. Ürün kartı açılmamışsa yöneticiye bildirin.</p>' :
        '<table class="tbl"><tbody>' + r.items.map((p) =>
          `<tr class="pl-row" data-code="${escapeHtml(p.stockCode)}" tabindex="0"><td class="mono"><b>${escapeHtml(p.stockCode)}</b></td><td>${cellText(p.name)}</td>` +
          `<td class="mono">${cellText(p.customerCode)}</td></tr>`).join('') + '</tbody></table>' +
        (r.total > r.items.length ? `<p class="hint">İlk ${r.items.length} / ${r.total}: aramayı daraltın.</p>` : '');
    } catch (err) {
      if (my === seq) res.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }, 250);
  q.addEventListener('input', search);
  const choose = (ev) => {
    const row = ev.target.closest?.('.pl-row');
    if (!row) return;
    m.close();
    onPick(row.dataset.code);
  };
  res.addEventListener('click', choose);
  res.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') choose(ev); });
  q.focus();
}
