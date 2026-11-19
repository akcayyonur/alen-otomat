/**
 * Planlama > Sipariş fişi: atölyenin elle yazdığı "SİPARİŞ FİŞİ" kağıdının dijital karşılığı (usta ihtiyaç
 * duyduğu malzeme/takımı İsim + Tarih + Adet/Malın cinsi/Marka satırlarıyla yazıp kesiyordu). `products`
 * tablosuyla HİÇ BAĞLANMAZ (Numune Takip/Hurda Girişi ile AYNI ilke) — "malın cinsi" genelde tedarikçi
 * katalog numarasıdır, Alen ürün kodu değil.
 *
 * Durum: bekliyor → verildi (sipariş verildi) → geldi (teslim alındı); yanlışlıkla ileri götürülürse
 * "Bir adım geri al". Kalemler tek seferde (wholesale) yazılır/düzenlenir — ölçü planı editörüyle
 * (`planning-measure.js`) AYNI "satır ekle/sil" deseni.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import {
  put, del, cellText, fmtNum, dateText, debounce, openModal, chip, canWrite, isAdminRole, printModal, openListPrint, truncCell, isoDate,
} from './planning-common.js';

const STATUS_CHIP = Object.freeze({
  bekliyor: chip('warn', '◔', 'bekliyor'),
  verildi: chip('info', '▶', 'sipariş verildi'),
  geldi: chip('ok', '✓', 'teslim alındı'),
});
const STATUS_TEXT = Object.freeze({ bekliyor: 'Bekliyor', verildi: 'Sipariş verildi', geldi: 'Teslim alındı' });
const rowClass = (status) => (status === 'geldi' ? ' pl-done' : status === 'verildi' ? ' pl-running' : ' pl-waiting');
const MAX_LINES = 60;

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderSupplyRequests(host) {
  const canEdit = canWrite('siparisfisi');
  const st = { q: '', status: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="İsim, malın cinsi ya da marka ara…" aria-label="Sipariş fişi ara">' +
    '<label class="fld-inline">Durum <select data-role="status"><option value="">Tümü</option><option value="bekliyor">Bekliyor</option>' +
    '<option value="verildi">Sipariş verildi</option><option value="geldi">Teslim alındı</option></select></label>' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni sipariş fişi…</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q || st.status ? 'Eşleşen sipariş fişi yok.' : `Henüz sipariş fişi yok.${canEdit ? ' "Yeni sipariş fişi…" ile başlayın.' : ''}`)
      : `${fmtNum(st.total)} sipariş fişi`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kod</th><th>Tarih</th><th>İsim</th><th class="num">Kalem</th><th>Açıklama</th><th>Durum</th></tr></thead><tbody>' +
      st.items.map((s) =>
        `<tr class="pl-row${rowClass(s.status)}" data-id="${s.id}" tabindex="0"><td class="mono"><b>${escapeHtml(s.code)}</b></td><td>${dateText(s.requestedOn)}</td>` +
        `<td class="trunc"${truncCell(s.requestedBy)}>${cellText(s.requestedBy)}</td><td class="num">${fmtNum(s.lines.length)}</td>` +
        `<td class="trunc"${truncCell(s.note)}>${cellText(s.note)}</td><td>${STATUS_CHIP[s.status] ?? s.status}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/supply-requests?${new URLSearchParams({ q: st.q, status: st.status, limit: 300 })}`);
      if (seq !== st.seq) return;
      st.total = r.total; st.items = r.items;
      draw();
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Sipariş fişleri alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => { if (ev.target.dataset?.role === 'status') { st.status = ev.target.value; load(); } };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="new"]')) { openSupplyRequestDialog(null, load); return; }
    if (ev.target.closest('[data-act="print"]')) {
      openListPrint({
        title: 'SİPARİŞ FİŞİ LİSTESİ', formNo: 'Dahili',
        heads: ['Kod', 'Tarih', 'İsim', 'Kalem', 'Açıklama', 'Durum'],
        rows: st.items.map((s) => [s.code, dateText(s.requestedOn).replace(/<[^>]+>/g, ''), s.requestedBy, s.lines.length, s.note, STATUS_TEXT[s.status] ?? s.status]),
        note: st.q || st.status ? `Süzgeç: ${[st.q && `"${st.q}"`, st.status && STATUS_TEXT[st.status]].filter(Boolean).join(' · ')}` : '',
      });
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (row) openSupplyRequestDialog(Number(row.dataset.id), load);
  };
  await load();
}

/* ============================================================================================== form / duzenle */

/**
 * Sipariş fişi detay/düzenle penceresi: yeni (id=null) ya da var olan kayıt. Kalemler (Adet/Malın cinsi/Marka)
 * satır ekle/sil ile düzenlenir; kaydedince TÜMÜ birden gönderilir (wholesale).
 * @param {number|null} id @param {() => void} [onDone]
 */
export async function openSupplyRequestDialog(id, onDone = () => {}) {
  const editable = canWrite('siparisfisi');
  const m = openModal({ title: id ? 'Sipariş fişi' : 'Yeni sipariş fişi', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let s = null;
  if (id) {
    try { s = await api(`/api/planning/supply-requests/${id}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  }
  let error = null;
  const lines = s ? s.lines.map((l) => ({ qty: String(l.qty), item: l.item, brand: l.brand ?? '' })) : [{ qty: '', item: '', brand: '' }];
  // header alanlari (lines'la AYNI nedenle, bkz. asagidaki read()): "Kalem ekle/sil" tum formu yeniden cizer,
  // s hala null oldugu icin s?.requestedBy gibi bir deger kullanilirsa az once yazilan İsim/Açıklama SİLİNİRDİ.
  const fields = { requestedBy: s?.requestedBy ?? '', requestedOn: isoDate(s?.requestedOn ?? Date.now()), note: s?.note ?? '' };

  function linesTable() {
    return '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th class="num">#</th><th class="num">Adet</th><th>Malın cinsi</th><th>Marka</th>' +
      (editable ? '<th></th>' : '') + '</tr></thead><tbody>' +
      lines.map((l, i) => `<tr data-i="${i}"><td class="num"><b>${i + 1}</b></td>` +
        `<td><input name="qty${i}" inputmode="numeric" value="${escapeHtml(l.qty)}" class="ms-in"${editable ? '' : ' readonly'}></td>` +
        `<td><input name="item${i}" maxlength="200" value="${escapeHtml(l.item)}" placeholder="ör. B114.0016.2.02"${editable ? '' : ' readonly'}></td>` +
        `<td><input name="brand${i}" maxlength="80" value="${escapeHtml(l.brand)}" placeholder="ör. HORN"${editable ? '' : ' readonly'}></td>` +
        (editable ? `<td><button type="button" class="icon-btn icon-btn-sm" data-act="del-line" data-i="${i}" aria-label="${i + 1}. satırı sil">Sil</button></td>` : '') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  function draw() {
    if (lines.length === 0) lines.push({ qty: '', item: '', brand: '' });
    m.body.innerHTML =
      (s ? `<p class="pl-wohead"><b class="mono">${escapeHtml(s.code)}</b> · ${dateText(s.requestedOn)} · ${STATUS_CHIP[s.status]}</p>` : '') +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>İsim *</span><input name="requestedBy" value="${escapeHtml(fields.requestedBy)}" maxlength="100" autocomplete="off"${editable ? ' required' : ' readonly'}></label>` +
      `<label class="fld"><span>Tarih</span><input name="requestedOn" type="date" value="${fields.requestedOn}"${editable ? '' : ' disabled'}></label>` +
      '</div>' +
      `<label class="fld"><span>Açıklama</span><textarea name="note" rows="2" maxlength="500"${editable ? '' : ' disabled'}>${escapeHtml(fields.note)}</textarea></label>` +
      '<h4 class="sub">Kalemler</h4>' + linesTable() +
      (editable ? `<div class="dt-actions"><button type="button" class="icon-btn" data-act="add-line"${lines.length >= MAX_LINES ? ' disabled' : ''}>＋ Kalem ekle</button></div>` : '') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions">' +
      (s ? '<button type="button" class="icon-btn" data-act="view">Formu görüntüle/yazdır</button>' : '') +
      (editable && s?.status === 'bekliyor' ? '<button type="button" class="icon-btn" data-act="order">Sipariş verildi</button>' : '') +
      (editable && s?.status === 'verildi' ? '<button type="button" class="icon-btn" data-act="receive">Teslim alındı</button>' : '') +
      (editable && (s?.status === 'verildi' || s?.status === 'geldi') ? '<button type="button" class="icon-btn" data-act="back">Bir adım geri al</button>' : '') +
      (isAdminRole() && s ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
      '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (editable ? `<button type="submit" class="icon-btn btn-primary" data-act="save">${s ? 'Kaydet' : 'Fişi oluştur'}</button>` : '') +
      '</div></form>';
  }
  draw();

  const read = () => {
    const f = m.body.querySelector('form');
    fields.requestedBy = f.elements.requestedBy.value; fields.requestedOn = f.elements.requestedOn.value; fields.note = f.elements.note.value;
    lines.forEach((l, i) => { l.qty = f.elements[`qty${i}`].value; l.item = f.elements[`item${i}`].value; l.brand = f.elements[`brand${i}`].value; });
  };

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="view"]')) { openSupplyRequestForm(s); return; }
    if (ev.target.closest('[data-act="add-line"]')) {
      if (lines.length < MAX_LINES) { read(); lines.push({ qty: '', item: '', brand: '' }); error = null; draw(); }
      return;
    }
    const delLine = ev.target.closest('[data-act="del-line"]');
    if (delLine) { read(); lines.splice(Number(delLine.dataset.i), 1); error = null; draw(); return; }
    if (ev.target.closest('[data-act="order"]')) {
      post(`/api/planning/supply-requests/${s.id}/order`).then((r) => { s = r; onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="receive"]')) {
      post(`/api/planning/supply-requests/${s.id}/receive`).then((r) => { s = r; onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="back"]')) {
      post(`/api/planning/supply-requests/${s.id}/back`).then((r) => { s = r; onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${s.code}" numaralı sipariş fişi silinsin mi? Bu geri alınamaz.`)) return;
      del(`/api/planning/supply-requests/${s.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
    }
  });

  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    read();
    const f = ev.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    error = null;
    try {
      const body = {
        requestedBy: f.elements.requestedBy.value, requestedOn: f.elements.requestedOn.value || null, note: f.elements.note.value,
        lines: lines.filter((l) => l.qty.trim() !== '' || l.item.trim() !== '' || l.brand.trim() !== '').map((l) => ({ qty: l.qty, item: l.item, brand: l.brand })),
      };
      s = s ? await put(`/api/planning/supply-requests/${s.id}`, body) : await post('/api/planning/supply-requests', body);
      onDone(); // ilk olusturmadan sonra da diyalog acik kalir: s artik dolu, draw() "duzenle" goruntusune gecer
      draw();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== basilan form */

/** Kâğıt "SİPARİŞ FİŞİ"nin düzeninde tek kayıt (A4 dikey). @param {object} s */
function supplyRequestFormHtml(s) {
  const linesRows = s.lines.map((l) => `<tr><td class="num">${fmtNum(l.qty)}</td><td>${escapeHtml(l.item)}</td><td>${l.brand ? escapeHtml(l.brand) : '&nbsp;'}</td></tr>`).join('');
  return (
    '<div class="pl-form">' +
    `<div class="pl-f-head"><div class="pl-f-title">SİPARİŞ FİŞİ</div><div class="pl-f-no"><span class="pl-f-label">İSİM</span> ${escapeHtml(s.requestedBy)}<br>` +
    `<span class="pl-f-label">TARİH</span> ${dateText(s.requestedOn)}</div></div>` +
    '<table class="pl-lf-t"><thead><tr><th>Adet</th><th>Malın cinsi</th><th>Marka</th></tr></thead><tbody>' + linesRows + '</tbody></table>' +
    (s.note ? `<p>${escapeHtml(s.note)}</p>` : '') +
    `<p class="pl-f-foot">Durum: ${escapeHtml(STATUS_TEXT[s.status] ?? s.status)} · Sistemden basıldı ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p>` +
    '</div>'
  );
}

/** Tek bir sipariş fişini görüntüle ve yazdır (A4 dikey). @param {object} s */
function openSupplyRequestForm(s) {
  const m = openModal({ title: `Sipariş fişi · ${s.code}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    supplyRequestFormHtml(s);
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}
