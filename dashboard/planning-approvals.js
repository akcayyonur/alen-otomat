/**
 * Planlama > İlk onay raporu: İlk Baskı Onay / Numune Takip Listesi (EYS.FR.013) — ilk onay raporunun KENDİSİ.
 *
 * İlk parça yapılıp ölçülünce usta tezgah başında bir iş emri için numara alır (İ26-1281); kayıt ürün kodu, GK kodu, iş emri no, tarih, operatör ve
 * CNC no'yu taşır ve iş emrinin "ilk onay rapor no" alanı kendiliğinden yazılır. Herkes okur; numarayı usta/yönetici alır; elle kayıt, düzeltme ve
 * silme yöneticiye özel. Listeyi kâğıt formun düzeninde yazdırabilirsiniz.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, cellText, fmtNum, dateText, debounce, openModal, isoDate, planningRole, rememberedPerson, rememberPerson, openListPrint, woStatusChip, truncCell } from './planning-common.js';
import { openFormDialog } from './auth-view.js';
import { openGkkPicker } from './planning-gkk.js';

const plainDate = (ms) => (ms ? new Date(ms).toLocaleDateString('tr-TR') : '');

/** @param {HTMLElement} host */
export function renderApprovals(host) {
  const role = planningRole();
  const admin = role === 'admin';
  const st = { q: '', year: '', items: [], total: 0, next: null, years: [], seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search pl-search-big" data-role="q" placeholder="Kod, ürün kodu, GK kodu, iş emri no ya da operatör ara…" aria-label="İlk onay ara" autocomplete="off">' +
    '<label class="fld-inline">Yıl <select data-role="year"><option value="">Tümü</option></select></label>' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (admin ? '<button type="button" class="icon-btn" data-act="seq">Numara tabanı…</button><button type="button" class="icon-btn" data-act="manual">Elle kayıt…</button>' : '') +
    (role !== 'viewer' ? '<button type="button" class="icon-btn btn-primary" data-act="from-wo">İş emrinden numara al…</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').innerHTML = st.total === 0
      ? (st.q || st.year ? 'Eşleşen kayıt yok.' : `Henüz kayıt yok.${role !== 'viewer' ? ' İlk parça ölçülünce "İş emrinden numara al…" ile ilk numarayı alın.' : ''}`)
      : `${fmtNum(st.total)} kayıt · sıradaki kod <b class="mono">${escapeHtml(st.next?.code ?? '—')}</b>`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>İlk baskı onay kodu</th><th>Ürün kodu</th><th>GK- kodu</th><th>İş emri no</th><th>Tarih</th><th>Operatör</th><th class="num">CNC no</th>' + (admin ? '<th></th>' : '') + '</tr></thead><tbody>' +
      st.items.map((a) =>
        `<tr><td class="mono pl-gk-no"><b>${escapeHtml(a.code)}</b></td><td class="mono"><b>${cellText(a.stockCode)}</b></td><td class="mono">${cellText(a.gkCode)}</td>` +
        `<td class="mono">${cellText(a.woNo)}</td><td>${dateText(a.approvedOn)}</td><td>${cellText(a.operator)}</td><td class="num">${a.cncNo ?? cellText(null)}</td>` +
        (admin ? `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="edit" data-id="${a.id}">Düzenle</button> <button type="button" class="icon-btn icon-btn-sm" data-act="delete" data-id="${a.id}">Sil</button></td>` : '') + '</tr>').join('') +
      '</tbody></table>';
    const ySel = $('year');
    ySel.innerHTML = '<option value="">Tümü</option>' + st.years.map((y) => `<option value="${y}"${String(y) === st.year ? ' selected' : ''}>${y}</option>`).join('');
  }

  async function load() {
    const seq = ++st.seq;
    try {
      const r = await api(`/api/planning/first-approvals?${new URLSearchParams({ q: st.q, limit: 1000, ...(st.year ? { year: st.year } : {}) })}`);
      if (seq !== st.seq) return;
      Object.assign(st, { items: r.items, total: r.total, next: r.next, years: r.years });
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Alınamadı: ${err.message}`;
    }
  }

  const search = debounce((v) => { st.q = v.trim(); load(); }, 200);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => { if (ev.target.dataset?.role === 'year') { st.year = ev.target.value; load(); } };
  host.onclick = async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const item = st.items.find((x) => x.id === Number(b.dataset.id));
    const act = b.dataset.act;
    if (act === 'from-wo') openApprovalFromWo(load);
    else if (act === 'manual') openApprovalForm(null, load);
    else if (act === 'edit' && item) openApprovalForm(item, load);
    else if (act === 'delete' && item) {
      if (!window.confirm(`${item.code} kaydı silinsin mi?${item.woNo ? ` ${item.woNo} numaralı iş emrindeki ilk onay rapor no alanı da boşalır.` : ''} Bu işlem geri alınamaz.`)) return;
      try { await del(`/api/planning/first-approvals/${item.id}`); load(); } catch (e) { window.alert(e.message); }
    } else if (act === 'print') {
      openListPrint({
        title: 'İLK BASKI ONAY / NUMUNE TAKİP LİSTESİ', formNo: 'EYS.FR.013',
        heads: ['İLK BASKI ONAY KODU', 'ÜRÜN KODU', 'GK- KODU', 'İŞ EMRİ NO', 'TARİH', 'OPERATÖR', 'CNC NO'],
        rows: [...st.items].reverse().map((a) => [a.code, a.stockCode ?? '', a.gkCode ?? '', a.woNo ?? '', plainDate(a.approvedOn), a.operator ?? '', a.cncNo ?? '']),
        note: st.q || st.year ? `Süzgeç: ${[st.q && `"${st.q}"`, st.year].filter(Boolean).join(' · ')}` : '',
      });
    } else if (act === 'seq') {
      openFormDialog({
        title: 'İlk onay kodu tabanı',
        intro: 'Kâğıt listede verilmiş ama burada kaydı olmayan kodlar varsa, en son verilen kodu yazın: yeni kodlar ondan devam eder. Küçültülemez. (EYS.FR.013 CSV\'sini içeri almak bunu kendiliğinden ayarlar.)',
        fields: [{ name: 'last', label: 'En son verilen ilk onay kodu', hint: `ör. ${st.next ? st.next.code.replace(/\d+$/, String(Math.max(1, st.next.seq - 1)).padStart(3, '0')) : 'İ26-1280'}` }],
        submitLabel: 'Ayarla',
        onSubmit: async (v) => { await put('/api/planning/first-approvals/sequence', { last: v.last }); load(); },
      });
    }
  };
  load();
}

/* ============================================================ iş emrinden numara al */

/**
 * Bir iş emri için ilk onay numarası alır (usta tezgah başında; yönetici de). Daha önce numara verilmişse uyarır ve onay ister.
 * @param {string} woNo @param {(a: object) => void} [onDone]
 */
export async function createFirstApproval(woNo, onDone = () => {}) {
  const m = openModal({ title: `İlk onay numarası al · ${woNo}` });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let w;
  try { w = await api(`/api/planning/work-orders/${encodeURIComponent(woNo)}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  if (w.status === 'iptal') { m.body.innerHTML = '<p class="notice notice-sim">İptal edilmiş iş emri için ilk onay alınamaz.</p>'; return; }
  const have = w.approvals ?? [];
  m.body.innerHTML =
    `<p class="pl-wohead"><b class="mono">${escapeHtml(w.no)}</b> · ${escapeHtml(w.stockCode)} ${escapeHtml(w.productName ?? '')} · ${escapeHtml(w.machineId ?? 'tezgah atanmadı')}</p>` +
    '<div class="pl-snap">' +
    `<span>Ürün kodu <b class="mono">${escapeHtml(w.stockCode)}</b></span><span>GK kodu <b class="mono">${cellText(w.gkkReportNo)}</b></span><span>CNC no <b>${w.machineNumber ?? '—'}</b></span></div>` +
    (w.gkkReportNo ? '' : '<p class="hint">Bu iş emrinde GKK rapor no yok: numara yine alınır, GK kodu boş kalır (sonra yönetici düzeltebilir).</p>') +
    (have.length ? `<p class="notice notice-sim"><b>Bu iş emri için zaten ilk onay numarası verilmiş:</b> ${have.map((a) => `<span class="mono">${escapeHtml(a.code)}</span>`).join(', ')}. Yeni bir numara yalnız ilk ürün yeniden onaylanıyorsa alınır (ör. takım/ayar değişimi).</p>` : '') +
    '<form autocomplete="off"><label class="fld"><span>Operatör (isteğe bağlı)</span><input name="person" maxlength="60" autocomplete="off"></label>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">${have.length ? 'Yine de yeni numara al' : 'Numarayı al'}</button></div></form>`;
  const form = m.body.querySelector('form');
  form.elements.person.value = rememberedPerson();
  form.elements.person.focus();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    rememberPerson(form.elements.person.value);
    try {
      const a = await post('/api/planning/first-approvals', { woNo, person: form.elements.person.value, ...(have.length ? { again: true } : {}) });
      m.body.innerHTML =
        '<div class="notice"><b>İlk onay numarası alındı</b></div>' +
        `<p class="pl-bigcode">${escapeHtml(a.code)}</p>` +
        `<p class="hint">Ürün <span class="mono">${escapeHtml(a.stockCode ?? '')}</span> · GK <span class="mono">${escapeHtml(a.gkCode ?? '—')}</span> · iş emri <span class="mono">${escapeHtml(a.woNo ?? '')}</span> · CNC ${a.cncNo ?? '—'} · ${escapeHtml(plainDate(a.approvedOn))}${a.operator ? ` · ${escapeHtml(a.operator)}` : ''}. ` +
        'İş emrinin "ilk onay rapor no" alanına yazıldı; ölçüm raporuna/numuneye bu kodu yazın.</p>' +
        '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="close">Tamam</button></div>';
      onDone(a);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/** Aktif iş emirleri arasından seç, numarayı al. */
function openApprovalFromWo(onDone) {
  const m = openModal({ title: 'İlk onay numarası: iş emri seç', wide: true });
  m.body.innerHTML =
    '<p class="hint">İlk ürün üretilip ölçüldükten sonra, o ürünün iş emrini seçin. Üretimdeki iş emirleri üstte.</p>' +
    '<input type="search" class="pl-search pl-search-big" data-role="q" placeholder="İş emri no, ürün ya da tezgah…" aria-label="İş emri ara" autocomplete="off">' +
    '<div class="table-wrap pl-pick" data-role="list"></div>';
  const list = m.body.querySelector('[data-role="list"]');
  let seq = 0;
  async function load() {
    const my = ++seq;
    const q = m.body.querySelector('[data-role="q"]').value.trim();
    try {
      const r = await api(`/api/planning/work-orders?${new URLSearchParams({ status: 'aktif', q, limit: 60 })}`);
      if (my !== seq) return;
      list.innerHTML = r.items.length === 0 ? '<p class="empty">Aktif iş emri yok.</p>' :
        '<table class="tbl tbl-pl"><thead><tr><th>İş emri</th><th>Ürün</th><th>Tezgah</th><th>Durum</th><th></th></tr></thead><tbody>' +
        r.items.map((w) => `<tr class="pl-row" data-no="${escapeHtml(w.no)}" tabindex="0"><td class="mono"><b>${escapeHtml(w.no)}</b></td><td class="trunc"${truncCell(w.productName)}><span class="mono">${escapeHtml(w.stockCode)}</span> ${cellText(w.productName)}</td>` +
          `<td class="mono">${cellText(w.machineId)}</td><td>${woStatusChip(w.status)}</td><td>${w.firstApprovalNo ? `<span class="hint">${escapeHtml(w.firstApprovalNo)}</span>` : ''}</td></tr>`).join('') + '</tbody></table>';
    } catch (err) {
      if (my === seq) list.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }
  const search = debounce(load, 200);
  m.body.addEventListener('input', (ev) => { if (ev.target.dataset?.role === 'q') search(); });
  const pick = (ev) => {
    const row = ev.target.closest('.pl-row');
    if (!row) return;
    m.close();
    createFirstApproval(row.dataset.no, onDone);
  };
  list.addEventListener('click', pick);
  list.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(ev); });
  m.body.querySelector('[data-role="q"]').focus();
  load();
}

/* ======================================================================= elle kayıt / düzenleme (yönetici) */

async function openApprovalForm(item, onSaved) {
  const m = openModal({ title: item ? `İlk onay kaydı · ${item.code}` : 'Elle ilk onay kaydı', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let machines = [];
  try { machines = (await api('/api/planning/summary')).machines; } catch { /* tezgah listesi olmadan da çalışır */ }
  const f = (name, label, value, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${name}" autocomplete="off" value="${escapeHtml(value ?? '')}"${extra}></label>`;
  m.body.innerHTML =
    '<form autocomplete="off"><div class="fld-grid">' +
    f('stockCode', 'Ürün kodu *', item?.stockCode, ' maxlength="40" required') +
    `<label class="fld"><span>GK- kodu</span><span class="fld-row"><input name="gkCode" maxlength="40" autocomplete="off" value="${escapeHtml(item?.gkCode ?? '')}"><button type="button" class="icon-btn icon-btn-sm" data-act="pick-gk">Listeden seç…</button></span></label>` +
    f('woNo', 'İş emri no', item?.woNo, ' maxlength="10" inputmode="numeric"') +
    `<label class="fld"><span>Tarih</span><input name="approvedOn" type="date" value="${escapeHtml(isoDate(item?.approvedOn ?? Date.now()))}"></label>` +
    f('operator', 'Operatör', item?.operator, ' maxlength="60"') +
    `<label class="fld"><span>CNC no (tezgah)</span><select name="machineId"><option value="">—</option>${machines.map((x) => `<option value="${escapeHtml(x.id)}"${x.id === item?.machineId ? ' selected' : ''}>${escapeHtml(x.id)}</option>`).join('')}</select></label>` +
    `<label class="fld pl-wide"><span>Not</span><input name="note" maxlength="200" value="${escapeHtml(item?.note ?? '')}"></label></div>` +
    (item ? '' : '<p class="hint">Kodu sistem verir (sıradaki kod). Usta tezgah başında iş emrinden numara alıyorsa bu formu kullanmayın.</p>') +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">${item ? 'Kaydet' : 'Kodu ver ve kaydet'}</button></div></form>`;
  const form = m.body.querySelector('form');
  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="pick-gk"]')) openGkkPicker({ stockCode: form.elements.stockCode.value, current: form.elements.gkCode.value, onPick: (no) => { form.elements.gkCode.value = no; } });
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    const e = form.elements;
    const body = { stockCode: e.stockCode.value, gkCode: e.gkCode.value, woNo: e.woNo.value, approvedOn: e.approvedOn.value || null, operator: e.operator.value, machineId: e.machineId.value, note: e.note.value };
    try {
      if (item) await put(`/api/planning/first-approvals/${item.id}`, body);
      else await post('/api/planning/first-approvals', { ...body, person: body.operator });
      m.close();
      onSaved();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}
