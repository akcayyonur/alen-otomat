/**
 * Planlama > Paketleme: kasa kapandıktan sonra paketlemede belli bir adetle paketlenen KESİN adedin girilmesi (K aşaması).
 *
 * Kasa dolarken adet bilinmez; kapanışta tezgah sayacından hesaplanan adet yalnız TAHMİNDİR. Burada girilen adet kesindir ve
 * iş emrinin paketlenen toplamına yazılır; sayılan ile paketlenen arasındaki fark gizlenmez. Büyük dokunmatik alanlar (fabrika PC'si / tablet).
 * Düzeltme için aynı kasaya adet yeniden girilebilir (geçmişe önceki değerle yazılır).
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, dateTimeText, rememberedPerson, rememberPerson } from './planning-common.js';
import { openFormDialog } from './auth-view.js';
import { openCrateCard, crateStateChip } from './planning-card.js';
import { openMeasureSheet } from './planning-measure.js';

const REFRESH_MS = 20_000;
const FILTERS = Object.freeze([
  { key: 'kapali', label: 'Paketleme bekleyenler' },
  { key: 'paketlendi', label: 'Paketlenenler' },
  { key: 'aktif', label: 'Hepsi' },
]);
const sign = (n) => (n > 0 ? `+${fmtNum(n)}` : fmtNum(n));

/** @param {HTMLElement} host */
export async function renderPacking(host) {
  const token = Symbol('packing');
  host.__packToken = token;
  const st = { state: 'kapali', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<p class="hint">Kasayla gelen <b>ürün tanıtım kartındaki KART NO</b>\'yu listede bulun, paketlenen <b>kesin adedi</b> girin. "Sayılan" tezgah sayacından hesaplanan tahmindir; fark gizlenmez.</p>' +
    '<div class="pl-bar"><div class="seg" role="group" aria-label="Kasa durumu" data-role="filters"></div>' +
    '<label class="fld-inline">Paketleyen kişi <input data-role="person" maxlength="60" autocomplete="off" placeholder="isteğe bağlı"></label></div>' +
    '<p class="notice" data-role="msg" hidden></p><p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  $('person').value = rememberedPerson();

  function drawFilters() {
    $('filters').innerHTML = FILTERS.map((f) => `<button type="button" data-filter="${f.key}" aria-pressed="${f.key === st.state}"${f.key === st.state ? ' class="is-on"' : ''}>${escapeHtml(f.label)}</button>`).join('');
  }

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.state === 'kapali' ? 'Paketleme bekleyen kasa yok.' : 'Kasa yok.')
      : `${fmtNum(st.total)} kasa${st.items.length < st.total ? ` (ilk ${fmtNum(st.items.length)} gösteriliyor)` : ''}`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kart no</th><th>İş emri</th><th>Ürün</th><th>Tezgah</th><th>Kart basıldı</th><th class="num">Sayılan (tahmin)</th><th>Paketlenen (kesin)</th><th class="num">Fark</th><th>Durum</th><th></th></tr></thead><tbody>' +
      st.items.map((k) => {
        const canPack = k.state === 'kapali' || k.state === 'paketlendi';
        return `<tr data-id="${k.id}"><td class="mono"><b>${escapeHtml(k.cardNo)}</b></td><td class="mono">${escapeHtml(k.woNo)}</td>` +
          `<td><span class="mono">${escapeHtml(k.stockCode ?? '')}</span> ${cellText(k.productName)}</td><td class="mono">${escapeHtml(k.machineId)}</td>` +
          `<td>${k.closedAt ? escapeHtml(dateTimeText(k.closedAt)) : '<span class="is-null">açık</span>'}</td><td class="num">${k.countedQty == null ? cellText(null) : `~${fmtNum(k.countedQty)}`}</td>` +
          `<td class="nowrap">${canPack
            ? `<input class="pack-qty" inputmode="numeric" autocomplete="off" aria-label="${escapeHtml(k.cardNo)} paketlenen adet" value="${k.packedQty ?? ''}" placeholder="adet"> ` +
              `<button type="button" class="icon-btn shop-btn btn-primary" data-act="pack">${k.packedQty == null ? 'Kaydet' : 'Düzelt'}</button>`
            : k.packedQty != null ? fmtNum(k.packedQty) : '<span class="is-null">kasa açık</span>'}</td>` +
          `<td class="num">${k.packDiff == null ? cellText(null) : escapeHtml(sign(k.packDiff))}</td><td>${crateStateChip(k.state)}</td>` +
          `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="card">Kart</button> <button type="button" class="icon-btn icon-btn-sm" data-act="sheet">Ölçü föyü</button>` +
          `${k.packedQty == null ? ' <button type="button" class="icon-btn icon-btn-sm" data-act="void">İptal…</button>' : ''}</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  async function load() {
    const my = ++st.seq;
    try {
      const r = await api(`/api/planning/crates?${new URLSearchParams({ state: st.state, limit: 100 })}`);
      if (my !== st.seq) return;
      st.total = r.total;
      st.items = r.items;
      drawFilters();
      draw();
    } catch (err) {
      if (my === st.seq) $('count').textContent = `Kasalar alınamadı: ${err.message}`;
    }
  }

  function say(text) {
    const el = $('msg');
    el.textContent = text;
    el.hidden = false;
  }

  host.onclick = async (ev) => {
    const filter = ev.target.closest('[data-filter]')?.dataset.filter;
    if (filter) { st.state = filter; await load(); return; }
    const btn = ev.target.closest('[data-act]');
    const row = btn?.closest('tr[data-id]');
    if (!btn || !row) return;
    const id = Number(row.dataset.id);
    const crate = st.items.find((k) => k.id === id);
    if (btn.dataset.act === 'card') openCrateCard(id);
    else if (btn.dataset.act === 'sheet') openMeasureSheet(id);
    else if (btn.dataset.act === 'pack') await save(row, crate, btn);
    else if (btn.dataset.act === 'void') {
      openFormDialog({
        title: `Kasayı iptal et · ${crate.cardNo}`,
        intro: 'Yanlış açılan kasa iptal edilir (numara yeniden verilmez). Paketlenmiş kasa iptal edilemez.',
        fields: [{ name: 'reason', label: 'İptal nedeni (zorunlu)' }],
        submitLabel: 'Kasayı iptal et',
        onSubmit: async (v) => { await post(`/api/planning/crates/${id}/void`, { reason: v.reason }); say(`${crate.cardNo} iptal edildi.`); await load(); },
      });
    }
  };
  host.onkeydown = (ev) => {
    if (ev.key !== 'Enter' || !ev.target.classList?.contains('pack-qty')) return;
    ev.preventDefault();
    const row = ev.target.closest('tr[data-id]');
    row?.querySelector('[data-act="pack"]')?.click();
  };

  async function save(row, crate, btn) {
    const input = row.querySelector('.pack-qty');
    const qty = input.value.trim();
    if (qty === '') { input.focus(); return; }
    btn.disabled = true;
    rememberPerson($('person').value);
    try {
      const r = await post(`/api/planning/crates/${crate.id}/pack`, { qty, person: $('person').value });
      say(`${r.cardNo}: ${fmtNum(r.packedQty)} adet kaydedildi${r.packDiff != null && r.packDiff !== 0 ? ` (sayılan ~${fmtNum(r.countedQty)}; fark ${sign(r.packDiff)})` : ''}.`);
      await load();
    } catch (err) {
      say(err.message);
      btn.disabled = false;
    }
  }

  await load();
  const timer = setInterval(() => {
    if (host.__packToken !== token || !host.isConnected) { clearInterval(timer); return; }
    if (host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // adet yazılırken liste yenilenmez
    load();
  }, REFRESH_MS);
}
