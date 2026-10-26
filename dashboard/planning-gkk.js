/**
 * Planlama > GKK rapor no: Giriş Kalite Kontrol rapor numarası takip formu (EYS.FR.011).
 *
 * Ustalar iş emrine yazılacak GK numarasını buradan bulur: hammadde cinsi ("AA24 X 13 - PB3") → rapor no (GK26.395) + üretici rapor tarihi.
 * İş emrinin ERP hammadde kodu ("HM614.AA24.00XYU13.00") kayıttaki cinsle otomatik eşleştirilir (openGkkPicker): ustaya önce uyanlar sunulur,
 * "aynı ölçü ama işlem farklı" (ısıl işlemli, HB ...) ayrıca işaretlenir.
 * Herkes (izleyici dahil) okur; ekleme/düzenleme/silme yöneticiye özel. Yeni numarayı sistem verir (GK + yıl + sıra).
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, cellText, fmtNum, dateText, debounce, openModal, isoDate, isAdminRole, chip, openListPrint, truncCell } from './planning-common.js';
import { openFormDialog } from './auth-view.js';

const plainDate = (ms) => (ms ? new Date(ms).toLocaleDateString('tr-TR') : '');
const MATCH = Object.freeze({
  tam: ['ok', '✓', 'tam eşleşme'],
  islemli: ['info', '▲', 'aynı ölçü, işlem farklı'],
  urun: ['info', '◆', 'dövme ürün'],
});
const matchChip = (kind) => (MATCH[kind] ? chip(...MATCH[kind]) : '');

/** @param {HTMLElement} host */
export function renderGkk(host) {
  const admin = isAdminRole();
  const st = { q: '', items: [], total: 0, count: 0, next: null, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search pl-search-big" data-role="q" placeholder="Hammadde cinsi (ör. AA24 X 13) ya da rapor no ara…" aria-label="GKK kaydı ara" autocomplete="off">' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (admin ? '<button type="button" class="icon-btn" data-act="seq">Numara tabanı…</button><button type="button" class="icon-btn btn-primary" data-act="new">Yeni GK numarası…</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').innerHTML = st.total === 0
      ? (st.q ? 'Eşleşen kayıt yok.' : `Henüz kayıt yok.${admin ? ' Sağ üstteki "Excel içeri al…" ile EYS.FR.011 formunu yükleyebilir ya da "Yeni GK numarası…" ile ekleyebilirsiniz.' : ''}`)
      : `${fmtNum(st.total)}${st.total !== st.count ? ` / ${fmtNum(st.count)}` : ''} kayıt · sıradaki numara <b class="mono">${escapeHtml(st.next?.no ?? '—')}</b>`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th class="num">Sıra</th><th>Hammadde cinsi</th><th>Rapor no</th><th>Üretici rapor tarihi</th><th>Açıklama</th>' + (admin ? '<th></th>' : '') + '</tr></thead><tbody>' +
      st.items.map((g, i) =>
        `<tr data-id="${g.id}"><td class="num">${fmtNum(i + 1)}</td><td class="trunc" title="${escapeHtml(g.material)}"><b>${escapeHtml(g.material)}</b></td><td class="mono pl-gk-no"><b>${escapeHtml(g.reportNo)}</b></td>` +
        `<td>${dateText(g.producerDate)}</td><td class="trunc"${truncCell(g.note)}>${cellText(g.note)}</td>` +
        (admin ? `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="edit" data-id="${g.id}">Düzenle</button> <button type="button" class="icon-btn icon-btn-sm" data-act="delete" data-id="${g.id}">Sil</button></td>` : '') + '</tr>').join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    try {
      const r = await api(`/api/planning/gkk?${new URLSearchParams({ q: st.q, limit: 1000 })}`);
      if (seq !== st.seq) return;
      Object.assign(st, { items: r.items, total: r.total, count: r.count, next: r.next });
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Alınamadı: ${err.message}`;
    }
  }

  const search = debounce((v) => { st.q = v.trim(); load(); }, 200);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onclick = async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const item = st.items.find((x) => x.id === Number(b.dataset.id));
    if (b.dataset.act === 'new') openGkkForm(null, st.next, load);
    else if (b.dataset.act === 'edit' && item) openGkkForm(item, st.next, load);
    else if (b.dataset.act === 'delete' && item) {
      if (!window.confirm(`${item.reportNo} · ${item.material} kaydı silinsin mi? Bu işlem geri alınamaz.`)) return;
      try { await del(`/api/planning/gkk/${item.id}`); load(); } catch (e) { window.alert(e.message); }
    } else if (b.dataset.act === 'print') {
      openListPrint({
        title: 'GİRİŞ KALİTE KONTROL RAPOR NUMARASI TAKİP FORMU', formNo: 'EYS.FR.011',
        heads: ['SIRA', 'ÜRÜN', 'RAPOR NO', 'ÜRETİCİ RAPOR TARİHİ', 'AÇIKLAMA'],
        rows: st.items.map((g, i) => [i + 1, g.material, g.reportNo, plainDate(g.producerDate), g.note ?? '']),
        note: st.q ? `Süzgeç: "${st.q}"` : '',
      });
    } else if (b.dataset.act === 'seq') {
      openFormDialog({
        title: 'GK numara tabanı',
        intro: 'Kâğıtta verilmiş ama bu listede kaydı olmayan numaralar varsa, en son verilen numarayı yazın: yeni numaralar ondan devam eder. Küçültülemez.',
        fields: [{ name: 'last', label: 'En son verilen GK numarası', hint: `ör. ${st.next?.no ?? 'GK26.396'}` }],
        submitLabel: 'Ayarla',
        onSubmit: async (v) => { await put('/api/planning/gkk/sequence', { last: v.last }); load(); },
      });
    }
  };
  load();
}

/** Ekle / düzenle (yönetici). */
function openGkkForm(item, next, onSaved) {
  const m = openModal({ title: item ? `GKK kaydı · ${item.reportNo}` : 'Yeni GK numarası' });
  m.body.innerHTML =
    '<form autocomplete="off"><div class="fld-grid">' +
    `<label class="fld pl-wide"><span>Hammadde cinsi *</span><input name="material" maxlength="80" required value="${escapeHtml(item?.material ?? '')}" placeholder="ör. AA24 X 13 - PB3"></label>` +
    `<label class="fld"><span>Rapor no</span><input name="reportNo" maxlength="12" value="${escapeHtml(item?.reportNo ?? '')}" placeholder="${escapeHtml(item ? '' : `boş bırakın: ${next?.no ?? ''}`)}"></label>` +
    `<label class="fld"><span>Üretici rapor tarihi</span><input name="producerDate" type="date" value="${escapeHtml(isoDate(item?.producerDate))}"></label>` +
    `<label class="fld pl-wide"><span>Açıklama</span><input name="note" maxlength="200" value="${escapeHtml(item?.note ?? '')}" placeholder="ör. ısıl işlemli, sertlik 110, dövme ürün"></label></div>` +
    '<p class="hint">Hammadde cinsi şu biçimde yazılırsa iş emrinin hammaddesiyle otomatik eşleşir: <b>YUV18 - PB3</b>, <b>AA24 X 13 - PB2</b>, <b>8 KÖŞE 52 X 27 - 602N</b> (şekil + ölçü [X iç ölçü] − alaşım; sonrasına işlem notu eklenebilir).</p>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">${item ? 'Kaydet' : 'Ekle'}</button></div></form>`;
  const form = m.body.querySelector('form');
  form.elements.material.focus();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    const e = form.elements;
    const body = { material: e.material.value, reportNo: e.reportNo.value, producerDate: e.producerDate.value || null, note: e.note.value };
    try {
      if (item) await put(`/api/planning/gkk/${item.id}`, body); else await post('/api/planning/gkk', body);
      m.close();
      onSaved();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/**
 * Bir iş emrine yazılacak GK numarasını listeden seçtirir. `erpMaterial` (iş emrinin hammadde kodu) ve `stockCode` ile eşleşenler önce gelir;
 * altta tüm kayıtlarda arama vardır.
 * @param {{erpMaterial?: string, stockCode?: string, current?: string, onPick: (reportNo: string) => void}} o
 */
export async function openGkkPicker({ erpMaterial = '', stockCode = '', current = '', onPick }) {
  const m = openModal({ title: 'GKK rapor numarası seç', wide: true });
  m.body.innerHTML =
    (erpMaterial ? `<p class="notice">Bu iş emrinin hammaddesi: <b class="mono">${escapeHtml(erpMaterial)}</b>${stockCode ? ` · ürün <span class="mono">${escapeHtml(stockCode)}</span>` : ''}${current ? ` · şu an yazılı: <b class="mono">${escapeHtml(current)}</b>` : ''}</p>` : '') +
    '<div data-role="matches"></div>' +
    '<h4 class="sub">Tüm kayıtlarda ara</h4>' +
    '<input type="search" class="pl-search pl-search-big" data-role="q" placeholder="Hammadde cinsi ya da rapor no…" aria-label="GKK kaydı ara" autocomplete="off">' +
    '<div class="table-wrap pl-pick" data-role="list"></div>';
  const $ = (r) => m.body.querySelector(`[data-role="${r}"]`);
  let seq = 0;

  const rowHtml = (g) =>
    `<tr><td><b>${escapeHtml(g.material)}</b>${g.match ? ` ${matchChip(g.match)}` : ''}${g.note ? `<br><small class="hint">${escapeHtml(g.note)}</small>` : ''}</td>` +
    `<td class="mono pl-gk-no"><b>${escapeHtml(g.reportNo)}</b></td><td>${dateText(g.producerDate)}</td>` +
    `<td><button type="button" class="icon-btn shop-btn btn-primary" data-pick="${escapeHtml(g.reportNo)}">Seç</button></td></tr>`;
  const table = (items) => `<table class="tbl tbl-pl"><thead><tr><th>Hammadde cinsi</th><th>Rapor no</th><th>Üretici rapor tarihi</th><th></th></tr></thead><tbody>${items.map(rowHtml).join('')}</tbody></table>`;

  async function load() {
    const my = ++seq;
    const q = $('q').value.trim();
    try {
      const r = await api(`/api/planning/gkk?${new URLSearchParams({ q, erpMaterial, stockCode, limit: 40 })}`);
      if (my !== seq) return;
      $('matches').innerHTML = erpMaterial || stockCode
        ? (r.matches.length > 0
          ? `<h4 class="sub">Bu hammaddeye uyan kayıtlar</h4><div class="table-wrap">${table(r.matches)}</div>` +
            (r.matches.some((x) => x.match === 'islemli') ? '<p class="hint">▲ işaretliler aynı ölçü ve alaşımdır ama ek işlem notu farklıdır (ısıl işlem, HB ...): iş emrindeki malzemeyle aynı olup olmadığını kontrol edin.</p>' : '')
          : '<p class="notice notice-sim">Bu hammaddeye otomatik eşleşen kayıt bulunamadı. Aşağıdan arayın; yoksa kalite bölümüne sorun.</p>')
        : '';
      $('list').innerHTML = r.items.length === 0 ? '<p class="empty">Eşleşen kayıt yok.</p>' : table(r.items) + (r.total > r.items.length ? `<p class="hint">${fmtNum(r.total)} kayıttan ilk ${fmtNum(r.items.length)} gösteriliyor; aramayı daraltın.</p>` : '');
    } catch (err) {
      if (my === seq) $('list').innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }
  const search = debounce(load, 200);
  m.body.addEventListener('input', (ev) => { if (ev.target.dataset?.role === 'q') search(); });
  m.body.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pick]');
    if (!b) return;
    m.close();
    onPick(b.dataset.pick);
  });
  $('q').focus();
  load();
}
