/**
 * Planlama > Ölçü raporları: iş emirlerine bağlı ölçü kontrolü kayıtlarının raporları. Ustaların tezgah başında girdiği saatlik ölçümler (EYS.FR.005)
 * kaydedilir; kalite kontrole ve paketlemeye ürünle birlikte giden raporlar buradan görülür ve basılır.
 *
 *   - satır = ölçümü olan bir iş emri: ölçü sayısı (ürüne göre 3, 5 ...), sütun (yarım saatlik) sayısı, tolerans dışı sütun, karta bağlanmamış sütun
 *   - "Tüm ölçümler" iş emrinin bütün ölçümlerini tek raporda açar; her ürün tanıtım kartı (K000012) kendi föyünü açar (kasayla giden kâğıt)
 * Herkes görür (izleyici dahil); ölçüm girişi Tezgah başında yapılır.
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { cellText, fmtNum, dateTimeText, debounce, woStatusChip, chip, truncCell } from './planning-common.js';
import { openMeasureSheet, openMeasureReport } from './planning-measure.js';

const PAGE = 50;

/** @param {HTMLElement} host */
export function renderMeasureReports(host) {
  const st = { q: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search pl-search-big" data-role="q" placeholder="İş emri no, ürün kodu ya da ürün adı ara…" aria-label="Ölçü raporu ara" autocomplete="off"></div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>' +
    '<p class="pl-more" data-role="more" hidden><button type="button" class="icon-btn" data-act="more">Daha fazla göster</button></p>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q ? 'Eşleşen rapor yok.' : 'Henüz ölçüm girilmiş iş emri yok. Ölçümler Tezgah başı ekranındaki "Ölçü kontrolü" ile girilir.')
      : `${fmtNum(st.total)} iş emrinde ölçüm var${st.items.length < st.total ? ` (ilk ${fmtNum(st.items.length)} gösteriliyor)` : ''} · en son ölçüm üstte`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>İş emri</th><th>Ürün</th><th>Tezgah</th><th>Durum</th><th class="num">Ölçü</th><th class="num">Sütun</th><th>Son ölçüm</th><th>Uyarı</th><th>Raporlar</th></tr></thead><tbody>' +
      st.items.map((r) =>
        `<tr><td class="mono"><b>${escapeHtml(r.no)}</b></td><td class="trunc"${truncCell(r.productName)}><span class="mono"><b>${escapeHtml(r.stockCode)}</b></span> ${cellText(r.productName)}</td>` +
        `<td class="mono">${cellText(r.machineId)}</td><td>${woStatusChip(r.status)}</td><td class="num">${r.planRows || cellText(null)}</td><td class="num">${fmtNum(r.columns)}</td>` +
        `<td>${escapeHtml(dateTimeText(r.lastAt))}</td>` +
        `<td>${r.flagged > 0 ? chip('bad', '▲', `${r.flagged} sütun tolerans dışı / uygun değil`) : ''}${r.pending > 0 ? ` ${chip('none', '◔', `${r.pending} sütun kart bekliyor`)}` : ''}${r.flagged === 0 && r.pending === 0 ? '<span class="hint" style="margin:0">—</span>' : ''}</td>` +
        `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm btn-primary" data-act="report" data-no="${escapeHtml(r.no)}">Tüm ölçümler</button>` +
        r.cards.map((c) => ` <button type="button" class="icon-btn icon-btn-sm" data-act="card" data-id="${c.id}" title="${escapeHtml(c.cardNo)} kartının ölçü föyü (${c.columns} sütun)">${escapeHtml(c.cardNo)} <small>(${c.columns})</small></button>`).join('') + '</td></tr>').join('') +
      '</tbody></table>';
    $('more').hidden = st.items.length >= st.total;
  }

  async function load(reset) {
    const seq = ++st.seq;
    const offset = reset ? 0 : st.items.length;
    try {
      const r = await api(`/api/planning/measure-reports?${new URLSearchParams({ q: st.q, limit: PAGE, offset })}`);
      if (seq !== st.seq) return;
      st.total = r.total;
      st.items = reset ? r.items : [...st.items, ...r.items];
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Alınamadı: ${err.message}`;
    }
  }

  const search = debounce((v) => { st.q = v.trim(); load(true); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onclick = (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'more') load(false);
    else if (b.dataset.act === 'report') openMeasureReport(b.dataset.no);
    else if (b.dataset.act === 'card') openMeasureSheet(Number(b.dataset.id));
  };
  load(true);
}
