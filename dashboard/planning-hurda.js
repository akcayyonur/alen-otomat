/**
 * Planlama > Hurda girişi: Karantina Alanı Giriş-Çıkış Formu (EYS.FR.043) + Tashih Sonrası Tekrar Kontrol
 * Formu (EYS.FR.049). Paketlemedeki hurdadan (ayrı ekran) FARKLI: ÜRETİM sırasında fark edilen hurda/uygunsuz
 * parça karantinaya çekilir. `products` tablosuyla HİÇ BAĞLANMAZ (Numune Takip ile aynı ilke).
 *
 * Akış: "Yeni giriş kaydı aç" → ürün tanımı, ürün tanıtım form no, uygunsuzluk tanımı, giriş tarihi/personeli →
 * kayıt "açık" olarak listede durur → giriş ile çıkış arasında "Tashih ekle…" ile sıfır ya da daha fazla
 * düzeltme denemesi kaydedilir (EYS.FR.049) → "Çıkış yap…" ile kayıt kapanır (çıkış nedeni/tarihi/personeli).
 *
 * Kayıt ayrıca kalite biriminin fiilen tuttuğu HURDA ÜRÜN TAKİP LİSTESİ'nin (EYS.LS.018) alanlarını da taşır
 * (müşteri, müşteri/Alen ürün kodu, tespit yeri, yapılacak işlem, parti/hurda miktarı, kalitesizlik maliyeti,
 * açıklama — `backend/planning/quarantine.js`'teki genişletme, 2026-11-05); hepsi isteğe bağlıdır.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import {
  put, del, cellText, fmtNum, dateText, debounce, openModal, chip, canWrite, isAdminRole, printModal, openListPrint, truncCell, isoDate,
} from './planning-common.js';

const STATUS_CHIP = Object.freeze({
  acik: chip('warn', '◔', 'karantinada (açık)'),
  kapali: chip('ok', '✓', 'çıkış yapıldı'),
});
const rowClass = (status) => (status === 'kapali' ? ' pl-done' : ' pl-waiting');
const decInput = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

/* ============================================================================================== liste */

/** Hurda girişi sekmesi: "Kayıtlar" (varsayılan) ve "Hurda deposu" (Mikro Karantina->Hurda transferleri) görünümleri arasında geçiş. @param {HTMLElement} host */
export async function renderQuarantine(host) {
  host.innerHTML =
    '<div class="seg pl-tabs" role="group" aria-label="Hurda girişi görünümü" data-role="views">' +
    '<button type="button" data-view="kayitlar">Kayıtlar</button><button type="button" data-view="hurda-deposu">Hurda deposu</button></div>' +
    '<div data-role="slot"></div>';
  const show = (view) => {
    for (const b of host.querySelectorAll('[data-view]')) { const on = b.dataset.view === view; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); }
    const body = document.createElement('div');
    host.querySelector('[data-role="slot"]').replaceChildren(body);
    return view === 'hurda-deposu' ? renderHurdaDeposu(body) : renderQuarantineList(body);
  };
  host.querySelector('[data-role="views"]').addEventListener('click', (ev) => { const b = ev.target.closest('[data-view]'); if (b) show(b.dataset.view); });
  await show('kayitlar');
}

/** "Hurda deposu" (Mikro KARANTİNA DEPO dep_no=5 -> HURDA DEPO dep_no=3): tashih sonucu hurdaya aktarılanların dökümü. @param {HTMLElement} host */
async function renderHurdaDeposu(host) {
  host.innerHTML = '<p class="hint">Tashih sonucu hurda çıkıp Mikro\'da Karantina depodan Hurda depoya (dep_no=3) gerçekten aktarılmış kayıtlar — iş emrine bağlı karantina kayıtları için otomatik gönderilir.</p>' +
    '<p class="hint" data-role="count"></p><div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  try {
    const { items } = await api('/api/planning/quarantine/hurda-deposu');
    $('count').textContent = items.length === 0 ? 'Henüz hurda depoya aktarım yok.' : `${fmtNum(items.length)} aktarım`;
    $('list').innerHTML = items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Tarih</th><th>Karantina kaydı</th><th>Ürün</th><th>İş emri</th><th class="num">Adet</th><th>Mikro evrak</th></tr></thead><tbody>' +
      items.map((x) => `<tr><td>${dateText(x.at)}</td><td class="mono">H${String(x.quarantineId).padStart(6, '0')}</td>` +
        `<td class="trunc"${truncCell(x.stockCode)}>${cellText(x.stockCode)}</td><td class="mono">${cellText(x.woNo)}</td>` +
        `<td class="num">${fmtNum(x.qty)}</td><td class="mono">${cellText(x.evrakSira != null ? `${x.evrakSeri ? `${x.evrakSeri}-` : ''}${x.evrakSira}` : null)}</td></tr>`).join('') +
      '</tbody></table>';
  } catch (err) {
    $('count').textContent = `Hurda deposu alınamadı: ${err.message}`;
  }
}

/** @param {HTMLElement} host */
async function renderQuarantineList(host) {
  const canEdit = canWrite('hurda');
  const st = { q: '', status: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Kod, ürün tanımı, form no, uygunsuzluk ara…" aria-label="Hurda girişi ara">' +
    '<label class="fld-inline">Durum <select data-role="status"><option value="">Tümü</option><option value="acik">Karantinada (açık)</option><option value="kapali">Çıkış yapıldı</option></select></label>' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni giriş kaydı aç</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q || st.status ? 'Eşleşen karantina kaydı yok.' : `Henüz hurda girişi yok.${canEdit ? ' "Yeni giriş kaydı aç" ile başlayın.' : ''}`)
      : `${fmtNum(st.total)} karantina kaydı`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kod</th><th>Giriş tarihi</th><th>Ürün tanımı</th><th>Müşteri</th><th>Form no</th><th>Uygunsuzluk tanımı</th><th>Giriş yapan</th><th>Tashih</th><th>Durum</th></tr></thead><tbody>' +
      st.items.map((q) =>
        `<tr class="pl-row${rowClass(q.status)}" data-id="${q.id}" tabindex="0"><td class="mono"><b>${escapeHtml(q.code)}</b></td><td>${dateText(q.enteredOn)}</td>` +
        `<td class="trunc"${truncCell(q.productLabel)}>${cellText(q.productLabel)}</td><td class="trunc"${truncCell(q.customer)}>${cellText(q.customer)}</td><td class="mono">${cellText(q.cardNo)}</td>` +
        `<td class="trunc"${truncCell(q.issue)}>${cellText(q.issue)}</td><td class="trunc"${truncCell(q.enteredBy)}>${cellText(q.enteredBy)}</td>` +
        `<td>${q.correctionCount > 0 ? fmtNum(q.correctionCount) : '<span class="is-null">—</span>'}</td><td>${STATUS_CHIP[q.status] ?? q.status}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/quarantine?${new URLSearchParams({ q: st.q, status: st.status, limit: 300 })}`);
      if (seq !== st.seq) return;
      st.total = r.total; st.items = r.items;
      draw();
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Karantina kayıtları alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => { if (ev.target.dataset?.role === 'status') { st.status = ev.target.value; load(); } };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="new"]')) { openQuarantineDialog(null, load); return; }
    if (ev.target.closest('[data-act="print"]')) {
      openListPrint({
        title: 'Karantina Alanı Giriş-Çıkış Formu Listesi', formNo: 'EYS.FR.043',
        heads: ['Kod', 'Giriş tarihi', 'Ürün tanımı', 'Müşteri', 'Form no', 'Uygunsuzluk tanımı', 'Giriş yapan', 'Durum'],
        rows: st.items.map((q) => [q.code, dateText(q.enteredOn).replace(/<[^>]+>/g, ''), q.productLabel, q.customer, q.cardNo,
          q.issue, q.enteredBy, { acik: 'Karantinada (açık)', kapali: 'Çıkış yapıldı' }[q.status] ?? q.status]),
      });
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (row) openQuarantineDialog(Number(row.dataset.id), load);
  };
  await load();
}

/* ============================================================================================== form / duzenle */

/**
 * Hurda girişi detay/düzenle penceresi: yeni (id=null) ya da var olan kayıt. Tashih ekleme ve çıkış yapma
 * aynı pencerede, "Çıkış yap…"/"Tashih ekle…" ile açılan küçük alt formlarla (ayrı modal AÇILMAZ).
 * @param {number|null} id @param {() => void} [onDone]
 */
export async function openQuarantineDialog(id, onDone = () => {}) {
  const editable = canWrite('hurda');
  const m = openModal({ title: id ? 'Karantina kaydı' : 'Yeni giriş kaydı', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let q = null;
  if (id) {
    try { q = await api(`/api/planning/quarantine/${id}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  }
  let error = null;
  let mode = null; // null | 'exit' | 'correction'
  let woNo = q ? q.woNo : null; // iliskili is emri (secici ile doldurulur): karantina miktari netlesince Mikro Karantina deposuna GIRIS'i otomatik tetikler
  const autoFill = {}; // is emri secilince BOS alanlara onerilen degerler (henuz kaydedilmedi): draw() her seferinde TUM HTML'i yeniden kurdugu icin dogrudan DOM mutasyonu kalici olmaz, v() buradan okur

  const v = (key) => (Object.hasOwn(autoFill, key) ? autoFill[key] : (q ? q[key] : null));
  const txt = (key, label, max, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" value="${escapeHtml(v(key) ?? '')}" maxlength="${max}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;
  const num = (key, label) => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" value="${decInput(v(key))}" inputmode="decimal" autocomplete="off"${editable ? '' : ' readonly'}></label>`;
  const ta = (key, label, max, rows = 2) => `<label class="fld"><span>${escapeHtml(label)}</span><textarea name="${key}" rows="${rows}" maxlength="${max}"${editable ? '' : ' disabled'}>${escapeHtml(v(key) ?? '')}</textarea></label>`;
  const dt = (key, label) => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" type="date" value="${isoDate(v(key))}"${editable ? '' : ' disabled'}></label>`;

  function correctionsTable() {
    if (!q || q.corrections.length === 0) return '<p class="hint">Henüz tashih kaydı yok.</p>';
    return (
      '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Tarih</th><th>Operatör</th><th>Tanım</th><th>Adet</th><th>O.K.</th><th>Hurda</th><th>Adam×saat</th><th>Açıklama</th>' +
      (isAdminRole() ? '<th></th>' : '') + '</tr></thead><tbody>' +
      q.corrections.map((c) =>
        `<tr><td>${dateText(c.doneOn)}</td><td>${cellText(c.operator)}</td><td class="trunc"${truncCell(c.description)}>${cellText(c.description)}</td>` +
        `<td>${fmtNum(c.qty)}</td><td>${c.okQty == null ? '<span class="is-null">—</span>' : fmtNum(c.okQty)}</td><td>${c.scrapQty == null ? '<span class="is-null">—</span>' : fmtNum(c.scrapQty)}</td>` +
        `<td>${c.manHours == null ? '<span class="is-null">—</span>' : fmtNum(c.manHours, 1)}</td><td class="trunc"${truncCell(c.note)}>${cellText(c.note)}</td>` +
        (isAdminRole() ? `<td><button type="button" class="icon-btn icon-btn-sm" data-act="del-corr" data-cid="${c.id}">Sil</button></td>` : '') + '</tr>').join('') +
      '</tbody></table></div>' +
      (q.corrections.length > 1
        ? `<p class="hint-meta">Toplam: ${fmtNum(q.totals.qty)} adet tashih edildi · ${fmtNum(q.totals.okQty)} O.K. · ${fmtNum(q.totals.scrapQty)} hurda · ${fmtNum(q.totals.manHours, 1)} adam×saat</p>` : '')
    );
  }

  /** Mikro Karantina deposu (GİRİŞ/OK/Hurda) özeti: yalnız bir iş emrine bağlı kayıtlarda anlamlı. */
  function depotBlock() {
    if (!q || !q.woNo || !q.depot) return '';
    const d = q.depot;
    const row = (label, h) => {
      const parts = [];
      if (h.sent > 0) parts.push(chip('ok', '✓', `${fmtNum(h.sent)} adet gönderildi`));
      if (h.pending > 0) parts.push(chip('warn', '◔', `${fmtNum(h.pending)} adet bekliyor`));
      if (parts.length === 0) parts.push('<span class="is-null">—</span>');
      return `<div class="pl-kpi"><span class="pl-kpi-l">${escapeHtml(label)}</span><span class="pl-kpi-v">${parts.join(' ')}</span></div>`;
    };
    const lastGirisError = d.giris.history.filter((x) => x.status === 'basarisiz').sort((a, b) => b.at - a.at)[0];
    return (
      '<h4 class="sub">Mikro karantina deposu</h4><div class="pl-kpis">' +
      row('Karantina girişi', d.giris) +
      (d.ok.sent > 0 ? `<div class="pl-kpi"><span class="pl-kpi-l">Geçici'ye aktarılan (OK)</span><span class="pl-kpi-v">${chip('ok', '✓', `${fmtNum(d.ok.sent)} adet`)}</span></div>` : '') +
      (d.hurda.sent > 0 ? `<div class="pl-kpi"><span class="pl-kpi-l">Hurda depoya aktarılan</span><span class="pl-kpi-v">${chip('bad', '✕', `${fmtNum(d.hurda.sent)} adet`)}</span></div>` : '') +
      '</div>' +
      (lastGirisError && d.giris.pending > 0
        ? `<p class="notice notice-sim">Karantina girişi başarısız oldu: ${escapeHtml(lastGirisError.error ?? '')} ` +
          `${editable ? '<button type="button" class="icon-btn icon-btn-sm" data-act="depot-retry-giris">Yeniden dene…</button>' : ''}</p>`
        : '')
    );
  }

  function draw() {
    m.body.innerHTML =
      (q ? `<p class="pl-wohead"><b class="mono">${escapeHtml(q.code)}</b> · ${dateText(q.enteredOn)} · ${STATUS_CHIP[q.status]}</p>` : '') +
      '<form autocomplete="off"><h4 class="sub">Karantina giriş bilgileri</h4><div class="fld-grid">' +
      `<label class="fld"><span>İş emri</span><span class="fld-row"><input value="${escapeHtml(woNo ?? '')}" readonly placeholder="(bağlı değil)">` +
      (editable ? `<button type="button" class="icon-btn icon-btn-sm" data-act="pick-wo">${woNo ? 'Değiştir…' : 'Seç…'}</button>` : '') +
      (editable && woNo ? '<button type="button" class="icon-btn icon-btn-sm" data-act="unlink-wo">Bağlantıyı kaldır</button>' : '') + '</span></label>' +
      txt('productLabel', 'Ürün tanımı (stok kodu/tanımı) *', 200, ' required') + txt('cardNo', 'Ürün tanıtım form numarası', 40) +
      txt('issue', 'Uygunsuzluk tanımı *', 500, ' required') + dt('enteredOn', 'Giriş tarihi') + txt('enteredBy', 'Giriş yapan personel *', 100, ' required') +
      '</div>' +
      '<h4 class="sub">Ürün ve miktar bilgileri (EYS.LS.018, hepsi isteğe bağlı)</h4><div class="fld-grid">' +
      txt('customer', 'Müşteri', 120) + txt('customerCode', 'Müşteri ürün kodu', 60) +
      txt('stockCode', 'Alen ürün kodu', 40) + txt('detectedAt', 'Uygunsuzluk tespit yeri', 60) +
      num('batchQty', 'Parti miktarı') + num('scrapQty', 'Hurda miktarı') + num('qualityCostTl', 'Kalitesizlik maliyeti (TL)') +
      '</div>' +
      (woNo ? '<p class="hint">Parti miktarı bilinmiyorsa boş bırakılabilir; kasa tartılınca buraya girilip kaydedilince Mikro Karantina deposuna GİRİŞ otomatik gönderilir.</p>' : '') +
      ta('action', 'Yapılacak işlem', 500) + ta('note', 'Açıklama', 1000) +
      depotBlock() +
      (q && q.status === 'kapali'
        ? '<h4 class="sub">Çıkış bilgileri</h4><div class="fld-grid">' + txt('exitReason', 'Çıkış nedeni', 300) + dt('exitedOn', 'Çıkış tarihi') + txt('exitedBy', 'Çıkış yapan personel', 100) + '</div>'
        : '') +
      (q ? '<h4 class="sub">Tashih (EYS.FR.049)</h4>' + correctionsTable() : '') +
      (mode === 'correction'
        ? '<h4 class="sub">Tashih ekle</h4><div class="fld-grid">' +
          `<label class="fld"><span>Tarih</span><input name="cDoneOn" type="date" value="${isoDate(Date.now())}"></label>` +
          '<label class="fld"><span>Tashih yapan operatör *</span><input name="cOperator" maxlength="100" autocomplete="off" required></label>' +
          '<label class="fld"><span>Tashih edilen adet *</span><input name="cQty" inputmode="numeric" required></label>' +
          '<label class="fld"><span>O.K. adedi</span><input name="cOkQty" inputmode="numeric"></label>' +
          '<label class="fld"><span>Hurda adedi</span><input name="cScrapQty" inputmode="numeric"></label>' +
          '<label class="fld"><span>Sarf edilen adam×saat</span><input name="cManHours" inputmode="decimal"></label>' +
          '</div><label class="fld"><span>Yapılan tashihin tanımı *</span><textarea name="cDescription" rows="2" maxlength="500" required></textarea></label>' +
          '<label class="fld"><span>Açıklama</span><textarea name="cNote" rows="2" maxlength="500"></textarea></label>' +
          '<div class="dt-actions"><button type="button" class="icon-btn" data-act="corr-cancel">Vazgeç</button>' +
          '<button type="submit" class="icon-btn btn-primary" data-act="corr-save">Tashihi kaydet</button></div>'
        : '') +
      (mode === 'exit'
        ? '<h4 class="sub">Çıkış yap</h4><div class="fld-grid">' +
          '<label class="fld"><span>Çıkış nedeni *</span><input name="eReason" maxlength="300" autocomplete="off" required></label>' +
          `<label class="fld"><span>Çıkış tarihi</span><input name="eDate" type="date" value="${isoDate(Date.now())}"></label>` +
          '<label class="fld"><span>Çıkış yapan personel *</span><input name="ePerson" maxlength="100" autocomplete="off" required></label>' +
          '</div><div class="dt-actions"><button type="button" class="icon-btn" data-act="exit-cancel">Vazgeç</button>' +
          '<button type="submit" class="icon-btn btn-primary" data-act="exit-save">Çıkışı kaydet</button></div>'
        : '') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (mode === null
        ? '<div class="dt-actions">' +
          (q ? '<button type="button" class="icon-btn" data-act="view">Formu görüntüle/yazdır</button>' : '') +
          (editable && q && q.status === 'acik' ? '<button type="button" class="icon-btn" data-act="add-corr">Tashih ekle…</button>' : '') +
          (editable && q && q.status === 'acik' ? '<button type="button" class="icon-btn" data-act="exit">Çıkış yap…</button>' : '') +
          (editable && q && q.status === 'kapali' ? '<button type="button" class="icon-btn" data-act="reopen">Girişi geri al</button>' : '') +
          (isAdminRole() && q ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
          '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
          (editable ? `<button type="submit" class="icon-btn btn-primary" data-act="save">${q ? 'Kaydet' : 'Giriş kaydını oluştur'}</button>` : '') +
          '</div>'
        : '') +
      '</form>';
  }
  draw();

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="view"]')) { openQuarantineForm(q); return; }
    if (ev.target.closest('[data-act="add-corr"]')) { mode = 'correction'; error = null; draw(); return; }
    if (ev.target.closest('[data-act="corr-cancel"]')) { mode = null; error = null; draw(); return; }
    if (ev.target.closest('[data-act="exit"]')) { mode = 'exit'; error = null; draw(); return; }
    if (ev.target.closest('[data-act="exit-cancel"]')) { mode = null; error = null; draw(); return; }
    if (ev.target.closest('[data-act="pick-wo"]')) {
      openWorkOrderPicker((picked) => {
        woNo = picked.no;
        if (!v('productLabel')) autoFill.productLabel = `${picked.stockCode} ${picked.productName ?? ''}`.trim();
        if (!v('stockCode')) autoFill.stockCode = picked.stockCode;
        if (!v('customerCode') && picked.customerCode) autoFill.customerCode = picked.customerCode;
        draw();
      });
      return;
    }
    if (ev.target.closest('[data-act="unlink-wo"]')) { woNo = null; draw(); return; }
    if (ev.target.closest('[data-act="depot-retry-giris"]')) {
      post(`/api/planning/quarantine/${q.id}/depot/retry-giris`).then((r) => { q = r; draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="reopen"]')) {
      post(`/api/planning/quarantine/${q.id}/reopen`).then((r) => { q = r; onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    const delCorr = ev.target.closest('[data-act="del-corr"]');
    if (delCorr) {
      if (!window.confirm('Bu tashih kaydı silinsin mi?')) return;
      del(`/api/planning/quarantine/corrections/${delCorr.dataset.cid}`).then((r) => { q = r; draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${q.code}" numaralı karantina kaydı silinsin mi? Bu geri alınamaz.`)) return;
      del(`/api/planning/quarantine/${q.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
    }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    error = null;
    try {
      if (mode === 'correction') {
        q = await post(`/api/planning/quarantine/${q.id}/corrections`, {
          doneOn: f.elements.cDoneOn.value || null, operator: f.elements.cOperator.value, description: f.elements.cDescription.value,
          qty: f.elements.cQty.value, okQty: f.elements.cOkQty.value || null, scrapQty: f.elements.cScrapQty.value || null,
          manHours: f.elements.cManHours.value || null, note: f.elements.cNote.value,
        });
        mode = null;
      } else if (mode === 'exit') {
        q = await post(`/api/planning/quarantine/${q.id}/exit`, { exitReason: f.elements.eReason.value, exitedOn: f.elements.eDate.value || null, exitedBy: f.elements.ePerson.value });
        mode = null;
      } else {
        const body = {
          woNo: woNo ?? '', productLabel: f.elements.productLabel.value, cardNo: f.elements.cardNo.value, issue: f.elements.issue.value,
          customer: f.elements.customer.value, customerCode: f.elements.customerCode.value, stockCode: f.elements.stockCode.value,
          detectedAt: f.elements.detectedAt.value, action: f.elements.action.value,
          batchQty: f.elements.batchQty.value || null, scrapQty: f.elements.scrapQty.value || null, qualityCostTl: f.elements.qualityCostTl.value || null,
          note: f.elements.note.value,
          enteredOn: f.elements.enteredOn.value || null, enteredBy: f.elements.enteredBy.value,
        };
        q = q ? await put(`/api/planning/quarantine/${q.id}`, body) : await post('/api/planning/quarantine', body);
      }
      onDone(); // ilk olusturmadan sonra da diyalog acik kalir: q artik dolu, draw() "duzenle" goruntusune gecer
      draw();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== is emri secici */

/** Karantina kaydını bir iş emrine bağlamak için arama/seç penceresi (planning-shop.js'teki "Başka iş emri başlat…" seçicisiyle AYNI desen). @param {(w: object) => void} onPick */
function openWorkOrderPicker(onPick) {
  const m = openModal({ title: 'Karantinaya çekilen ürünün iş emri', wide: true });
  m.body.innerHTML =
    '<p class="hint">Üretimdeki ya da yakın zamanda bitmiş iş emirleri aranır.</p>' +
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="İş emri no, ürün ya da müşteri sipariş no…" aria-label="İş emri ara" autocomplete="off"></div>' +
    '<div class="table-wrap" data-role="list"></div>';
  const list = m.body.querySelector('[data-role="list"]');
  let seq = 0;
  let items = []; // picker'in secimi DOM'dan degil (cellText DASH'i ayirt etmek gerekir), bu dizinin KENDISINDEN okur
  async function load() {
    const my = ++seq;
    const q = m.body.querySelector('[data-role="q"]').value.trim();
    try {
      const r = await api(`/api/planning/work-orders?${new URLSearchParams({ status: 'uretimde-bitti', q, limit: 50 })}`);
      if (my !== seq) return;
      items = r.items;
      list.innerHTML = items.length === 0 ? '<p class="empty">Eşleşen iş emri yok.</p>' :
        '<table class="tbl tbl-pl"><thead><tr><th>İş emri no</th><th>Ürün kodu</th><th>Ürün adı</th><th>Müşteri kodu</th><th>Tezgah</th><th>Durum</th></tr></thead><tbody>' + items.map((w) =>
          `<tr class="pl-row" data-no="${escapeHtml(w.no)}" tabindex="0"><td class="mono"><b>${escapeHtml(w.no)}</b></td><td class="mono">${escapeHtml(w.stockCode)}</td>` +
          `<td class="trunc"${truncCell(w.productName)}>${cellText(w.productName)}</td><td class="mono">${cellText(w.customerCode)}</td><td class="mono">${escapeHtml(w.machineId)}</td>` +
          `<td>${w.status === 'uretimde' ? chip('info', '▶', 'üretimde') : chip('ok', '✓', 'bitti')}</td></tr>`).join('') + '</tbody></table>';
    } catch (err) {
      list.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }
  const search = debounce(load, 250);
  m.body.addEventListener('input', (ev) => { if (ev.target.dataset?.role === 'q') search(); });
  const pick = (ev) => {
    const row = ev.target.closest('.pl-row');
    if (!row) return;
    const w = items.find((x) => x.no === row.dataset.no);
    if (!w) return;
    m.close();
    onPick(w);
  };
  list.addEventListener('click', pick);
  list.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(ev); });
  m.body.querySelector('[data-role="q"]').focus();
  load();
}

/* ============================================================================================== basilan form */

/** Kâğıt formların düzeninde (A4 dikey) tek kayıt: giriş-çıkış (EYS.FR.043) + tashih tablosu (EYS.FR.049). @param {object} q */
function quarantineFormHtml(q) {
  const row = (label, value, cls = '') => `<tr><th scope="row">${escapeHtml(label)}</th><td class="${cls}">${value === '' || value == null ? '&nbsp;' : escapeHtml(String(value))}</td></tr>`;
  const sec = (label) => `<tr class="pl-nf-sec"><th colspan="2">${escapeHtml(label)}</th></tr>`;
  const corrTable = q.corrections.length === 0 ? '<p>&nbsp;</p>' :
    '<table class="pl-nf-t"><thead><tr><th>Tarih</th><th>Operatör</th><th>Tanım</th><th>Adet</th><th>O.K.</th><th>Hurda</th><th>Adam×saat</th></tr></thead><tbody>' +
    q.corrections.map((c) => `<tr><td>${dateText(c.doneOn)}</td><td>${escapeHtml(c.operator)}</td><td>${escapeHtml(c.description)}</td><td>${fmtNum(c.qty)}</td>` +
      `<td>${c.okQty ?? ''}</td><td>${c.scrapQty ?? ''}</td><td>${decInput(c.manHours)}</td></tr>`).join('') + '</tbody></table>';
  return (
    '<div class="pl-form">' +
    `<div class="pl-f-head"><div class="pl-f-title">KARANTİNA ALANI GİRİŞ-ÇIKIŞ FORMU</div><div class="pl-f-no"><span class="pl-f-label">KOD</span> ${escapeHtml(q.code)}<br>` +
    `<span class="pl-f-label">GİRİŞ TARİHİ</span> ${dateText(q.enteredOn)}</div></div>` +
    '<table class="pl-nf-t"><tbody>' +
    sec('Giriş bilgileri') +
    row('ÜRÜN TANIMI (STOK KODU/TANIMI)', q.productLabel) + row('ÜRÜN TANITIM FORM NUMARASI', q.cardNo) +
    row('UYGUNSUZLUK TANIMI', q.issue, 'pl-nf-note') + row('GİRİŞ YAPAN PERSONEL', q.enteredBy) +
    sec('Ürün ve miktar bilgileri (EYS.LS.018)') +
    row('MÜŞTERİ', q.customer) + row('MÜŞTERİ ÜRÜN KODU', q.customerCode) +
    row('ALEN ÜRÜN KODU', q.stockCode) + row('UYGUNSUZLUK TESPİT YERİ', q.detectedAt) +
    row('YAPILACAK İŞLEM', q.action, 'pl-nf-note') +
    row('PARTİ MİKTARI', q.batchQty == null ? null : fmtNum(q.batchQty)) + row('HURDA MİKTARI', q.scrapQty == null ? null : fmtNum(q.scrapQty)) +
    row('KALİTESİZLİK MALİYETİ (TL)', q.qualityCostTl == null ? null : fmtNum(q.qualityCostTl, 2)) +
    row('AÇIKLAMA', q.note, 'pl-nf-note') +
    sec('Çıkış bilgileri') +
    row('ÇIKIŞ NEDENİ', q.status === 'kapali' ? q.exitReason : null, 'pl-nf-note') +
    row('ÇIKIŞ TARİHİ', q.status === 'kapali' ? dateText(q.exitedOn) : null) + row('ÇIKIŞ YAPAN PERSONEL', q.status === 'kapali' ? q.exitedBy : null) +
    '</tbody></table>' +
    '<h4 class="sub">Tashih Sonrası Tekrar Kontrol (EYS.FR.049)</h4>' + corrTable +
    `<p class="pl-f-foot">EYS.FR.043 / EYS.FR.049 · Sistemden basıldı ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p>` +
    '</div>'
  );
}

/** Tek bir karantina kaydını görüntüle ve yazdır (A4 dikey). @param {object} q */
function openQuarantineForm(q) {
  const m = openModal({ title: `Karantina kaydı · ${q.code}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    quarantineFormHtml(q);
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}
