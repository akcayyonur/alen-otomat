/**
 * Planlama > Siparisler: musteri siparis no / evrak no / musteri / urun ile arama; siparisin satirlari (bir siparişte birden çok ürün).
 * Satirdaki "Is emri ac" dugmesi dogrudan is emri formunu acar (Is emirleri sekmesindeki akisin kisayolu).
 * Ayni musteri siparis no birden cok siparise/musteriye dusebilir ("NUMUNE" gibi): tek sonuc varsayilmaz, liste gosterilir.
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { cellText, fmtNum, dateText, debounce, chip, truncCell } from './planning-common.js';
import { openNewWorkOrder } from './planning-workorders.js';

/** @param {HTMLElement} host */
export function renderOrders(host) {
  const st = { q: '', openOnly: false, orders: [], lines: [], selected: null, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Müşteri sipariş no, evrak no, müşteri ya da ürün ara…" aria-label="Sipariş ara">' +
    '<label class="chk"><input type="checkbox" data-role="open"> yalnız açık (kalan adedi olan)</label></div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap" data-role="list"></div>' +
    '<div data-role="detail"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  const groupKey = (o) => `${o.customerKey}\u0001${o.custOrderKey}\u0001${o.docKey}`;

  function drawList() {
    $('count').textContent = st.orders.length === 0
      ? (st.q || st.openOnly ? 'Eşleşen sipariş yok.' : 'Henüz sipariş yok. Sağ üstteki "Excel içeri al…" ile Mikro sipariş dosyasını (.xlsx ya da CSV) yükleyin.')
      : `${fmtNum(st.orders.length)} sipariş${st.orders.length >= 100 ? ' (ilk 100; aramayı daraltın)' : ''}${st.q === '' ? ' · en yeniler önde' : ''}`;
    $('list').innerHTML = st.orders.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Müşteri</th><th>Müşteri sip. no</th><th>Evrak no</th><th>Tarih</th>' +
      '<th class="num">Satır</th><th class="num">Sipariş adedi</th><th class="num">Açık (kalan)</th></tr></thead><tbody>' +
      st.orders.map((o) =>
        `<tr class="pl-row${st.selected === groupKey(o) ? ' is-selected' : ''}" data-key="${escapeHtml(groupKey(o))}" tabindex="0">` +
        `<td class="trunc"${truncCell(o.customer)}>${cellText(o.customer)}</td><td class="mono trunc"${truncCell(o.custOrderNo)}><b>${cellText(o.custOrderNo)}</b></td><td class="mono trunc"${truncCell(o.docNo)}>${cellText(o.docNo)}</td>` +
        `<td>${dateText(o.orderDate)}</td><td class="num">${fmtNum(o.lineCount)}</td><td class="num">${fmtNum(o.qty)}</td>` +
        `<td class="num">${o.openQty > 0 ? `<b>${fmtNum(o.openQty)}</b>` : '<span class="is-null">0</span>'}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    try {
      const r = await api(`/api/planning/orders?${new URLSearchParams({ q: st.q, ...(st.openOnly ? { open: '1' } : {}), limit: 100 })}`);
      if (seq !== st.seq) return;
      st.orders = r.orders;
      if (st.selected && !st.orders.some((o) => groupKey(o) === st.selected)) { st.selected = null; $('detail').innerHTML = ''; }
      drawList();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Siparişler alınamadı: ${err.message}`;
    }
  }

  async function showLines(order) {
    st.selected = groupKey(order);
    drawList();
    const box = $('detail');
    box.innerHTML = '<p class="empty">Satırlar yükleniyor…</p>';
    try {
      const { lines } = await api(`/api/planning/orders/lines?${new URLSearchParams({ customerKey: order.customerKey, custOrderKey: order.custOrderKey, docKey: order.docKey })}`);
      if (st.selected !== groupKey(order)) return;
      st.lines = lines;
      box.innerHTML =
        `<h4 class="sub">${escapeHtml(order.customer || '—')} · müşteri sip. no ${escapeHtml(order.custOrderNo || '—')} · evrak ${escapeHtml(order.docNo || '—')} — ${lines.length} satır</h4>` +
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Ürün kodu</th><th>Ürün adı</th><th class="num">Sipariş</th><th class="num">Sevk edilen</th>' +
        '<th class="num">Kalan</th><th>Termin</th><th>Hammadde</th><th class="num">İş emrinde</th><th>Ürün kartı</th><th></th></tr></thead><tbody>' +
        lines.map((l) =>
          `<tr><td class="mono"><b>${escapeHtml(l.stockCode)}</b></td><td class="trunc"${truncCell(l.itemName)}>${cellText(l.itemName)}</td><td class="num">${fmtNum(l.qty)}</td>` +
          `<td class="num">${fmtNum(l.shipped)}</td><td class="num">${l.remaining > 0 ? `<b>${fmtNum(l.remaining)}</b>` : fmtNum(l.remaining)}</td>` +
          `<td>${dateText(l.dueDate)}</td><td class="mono trunc"${truncCell(l.material)}>${cellText(l.material)}</td>` +
          `<td class="num">${l.planned > 0 ? fmtNum(l.planned) : '<span class="is-null">0</span>'}</td>` +
          `<td>${l.hasProduct ? chip('ok', '✓', 'var') : chip('none', '·', 'yok (ürün değil ya da kart açılmamış)')}</td>` +
          `<td class="nowrap">${l.hasProduct ? `<button type="button" class="icon-btn icon-btn-sm" data-act="wo" data-line="${l.id}">İş emri aç</button>` : ''}</td></tr>`).join('') +
        '</tbody></table></div>';
    } catch (err) {
      box.innerHTML = `<p class="notice notice-sim">Satırlar alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => { if (ev.target.dataset?.role === 'open') { st.openOnly = ev.target.checked; load(); } };
  const pick = (ev) => {
    const wo = ev.target.closest?.('[data-act="wo"]');
    if (wo) {
      const line = st.lines.find((x) => x.id === Number(wo.dataset.line));
      const order = st.orders.find((o) => groupKey(o) === st.selected);
      if (line) openNewWorkOrder({ line: { ...line, customer: line.customer ?? order?.customer } }, () => { if (order) showLines(order); });
      return;
    }
    const row = ev.target.closest?.('.pl-row');
    const order = row && st.orders.find((o) => groupKey(o) === row.dataset.key);
    if (order) showLines(order);
  };
  host.onclick = pick;
  host.onkeydown = (ev) => { if (ev.key === 'Enter') pick(ev); };
  load();
}
