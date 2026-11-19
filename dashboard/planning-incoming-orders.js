/**
 * Planlama > Yeni siparişler: mail ile gelen sipariş PDF'i ya da e-posta gövdesindeki TABLO, TASLAK sipariş
 * satırına çevrilir (müşteri koduyla ürün kartına eşlenir; revizyonsa var olan `order_lines` ile karşılaştırılır).
 * "GÖSTER-ONAYLA" (bkz. CLAUDE.md §6 "Mail'den otomatik sipariş girişi"): hiçbir taslak kendiliğinden Mikro'ya
 * yazılmaz, onay yalnız BURADA durum değiştirir — Mikro'ya yazma AYRI, henüz yapılmamış bir iştir.
 *
 * Mail kutusu henüz TARANMIYOR (Outlook fabrika PC'sinde AÇILAMAZ; Graph API + özel kutu kararı bekliyor,
 * bkz. CLAUDE.md). Bu yüzden girdi şimdilik: PDF dosyası yükleme ya da e-posta tablosunun (gerçek biçimini
 * koruyarak, Ctrl+V ile) yapıştırılması. "Revizyon" seçilince aynı iki yol kullanılır; satırın revizyon olup
 * olmadığı sunucuda (vurgulu hücre ya da var olan siparişle fark) belirlenir.
 */
import { escapeHtml, dateTime } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, fmtDec, dateText, isoDate, openModal, chip, debounce, truncCell, put } from './planning-common.js';

const SOURCE_LABEL = Object.freeze({ pdf: 'PDF', 'email-table': 'E-posta tablosu' });
const KIND_LABEL = Object.freeze({ yeni: 'Yeni sipariş', revizyon: 'Revizyon' });
const STATUS_CHIP = Object.freeze({
  bekliyor: chip('warn', '◔', 'bekliyor'),
  onaylandi: chip('ok', '✓', 'onaylandı'),
  reddedildi: chip('bad', '✕', 'reddedildi'),
});
const REVISION_LABEL = Object.freeze({ iptal: 'İptal', tarih: 'Termin değişti', miktar: 'Adet değişti', bilinmiyor: 'Revizyon notu anlaşılamadı' });
const MAX_UPLOAD = 20 * 1024 * 1024;

/**
 * Düzenlenebilir bir fiyat girişinin BAŞLANGIÇ değeri: Türkçe virgüllü ondalık AMA binlik ayracı YOK —
 * `fmtDec`'in `Intl.NumberFormat` grupla biçimi ("1.500,50") burada KULLANILAMAZ, çünkü hem bu dosyadaki
 * hem Mikro gönderme penceresindeki mevcut kaydetme kodu metni SADECE ",". ile "." degistirip gonderiyor
 * ("1.500,50" -> "1.500.50" = NaN/yanlis sayi olurdu — gercek bir hata, bu fonksiyonla ONLENDI).
 */
const priceInputValue = (v) => (v == null ? '' : String(v).replace('.', ','));

function matchChip(line) {
  if (line.matchStatus === 'tam') return chip('ok', '✓', line.matchedStockCode ?? 'eşleşti');
  if (line.matchStatus === 'belirsiz') return chip('warn', '▲', `belirsiz (${fmtNum(line.candidateCount)} aday)`);
  return chip('bad', '✕', 'eşleşmedi');
}

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderIncomingOrders(host) {
  const st = { batches: [], error: null };
  host.innerHTML = '<p class="empty">Yükleniyor…</p>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    host.innerHTML =
      '<p class="hint">Mail ile gelen sipariş PDF\'i ya da e-posta tablosu, TASLAK satırlara çevrilir; hiçbir şey kendiliğinden Mikro\'ya yazılmaz. ' +
      'Her satır burada tek tek onaylanır ya da reddedilir (göster-onayla).</p>' +
      '<div class="pl-bar"><button type="button" class="icon-btn btn-primary" data-act="pdf">PDF yükle…</button>' +
      '<button type="button" class="icon-btn" data-act="paste">E-posta tablosunu yapıştır…</button></div>' +
      (st.error ? `<p class="notice notice-sim">Taslaklar alınamadı: ${escapeHtml(st.error)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button></p>` : '') +
      '<div data-role="list"></div>';
    $('list').innerHTML = st.batches.length === 0 && !st.error
      ? '<p class="empty">Henüz taslak yok. "PDF yükle…" ya da "E-posta tablosunu yapıştır…" ile başlayın.</p>'
      : '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Kaynak</th><th>Tür</th><th>Dosya</th><th>Müşteri (tahmin)</th>' +
        '<th class="num">Bekliyor</th><th class="num">Onaylandı</th><th class="num">Reddedildi</th><th>Oluşturuldu</th></tr></thead><tbody>' +
        st.batches.map((b) =>
          `<tr class="pl-row" data-id="${b.id}" tabindex="0"><td>${cellText(SOURCE_LABEL[b.source] ?? b.source)}</td><td>${cellText(KIND_LABEL[b.kind] ?? b.kind)}</td>` +
          `<td class="trunc"${truncCell(b.filename)}>${cellText(b.filename)}</td><td>${cellText(b.customerGuess)}</td>` +
          `<td class="num">${fmtNum(b.counts.bekliyor)}</td><td class="num">${fmtNum(b.counts.onaylandi)}</td><td class="num">${fmtNum(b.counts.reddedildi)}</td>` +
          `<td>${escapeHtml(dateTime(b.createdAt))}</td></tr>`).join('') +
        '</tbody></table></div>';
  }

  async function load() {
    try { st.batches = (await api('/api/planning/incoming-orders')).batches; st.error = null; } catch (err) { st.error = err.message; }
    draw();
  }

  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="pdf"]')) { openUploadDialog('pdf', load); return; }
    if (ev.target.closest('[data-act="paste"]')) { openUploadDialog('email-table', load); return; }
    const row = ev.target.closest('.pl-row');
    if (row) openBatchDialog(Number(row.dataset.id), load);
  };
  await load();
}

/* ============================================================================================== yukleme (PDF / yapistir) */

/** PDF dosyası yükleme ya da e-posta tablosunu (gerçek HTML'iyle) yapıştırma penceresi. @param {'pdf'|'email-table'} source */
function openUploadDialog(source, onDone) {
  const m = openModal({ title: source === 'pdf' ? 'Sipariş PDF\'i yükle' : 'E-posta tablosunu yapıştır' });
  let kind = 'yeni';
  let busy = false;
  let error = null;
  let pastedHtml = '';
  let pastedChars = 0;

  function draw() {
    m.body.innerHTML =
      '<div class="dt-actions" style="justify-content:flex-start;gap:16px">' +
      `<label class="chk"><input type="radio" name="kind" value="yeni"${kind === 'yeni' ? ' checked' : ''}> Yeni sipariş</label>` +
      `<label class="chk"><input type="radio" name="kind" value="revizyon"${kind === 'revizyon' ? ' checked' : ''}> Revizyon</label></div>` +
      (source === 'pdf'
        ? '<p class="hint">Siparişin geldiği PDF dosyasını seçin. Taranmış (fotokopi) sayfalar bu sürümde okunamaz — OCR henüz yazılmadı, bunlar elle girilmeli.</p>' +
          `<input type="file" accept=".pdf" data-role="file"${busy ? ' disabled' : ''}>`
        : '<p class="hint">Mail içindeki siparişleri gösteren tabloyu kopyalayıp (Outlook/OWA\'da tablonun üzerini seçip Ctrl+C) buraya <b>Ctrl+V</b> ile yapıştırın — ' +
          'düz metin değil, tablonun biçimini (revizyon hücresinin sarı vurgusu dahil) korur. <b>Henüz gerçek bir e-posta ile denenmedi</b>, biçim beklenenden farklıysa "tanınan başlık yok" uyarısı çıkar.</p>' +
          `<div class="pl-paste-area" contenteditable="true" data-role="paste" tabindex="0" aria-label="Tabloyu buraya yapıştırın">` +
          (pastedChars > 0 ? `✓ Tablo yapıştırıldı (${pastedChars} karakter). Değiştirmek için yeniden yapıştırın.` : '') + '</div>') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (source === 'email-table' ? `<button type="button" class="icon-btn btn-primary" data-act="go"${busy || pastedChars === 0 ? ' disabled' : ''}>İçeri al</button>` : '') +
      '</div>';
    if (source === 'email-table') {
      const area = m.body.querySelector('[data-role="paste"]');
      area?.addEventListener('paste', (ev) => {
        ev.preventDefault();
        const html = ev.clipboardData?.getData('text/html') ?? '';
        const plain = ev.clipboardData?.getData('text/plain') ?? '';
        pastedHtml = html || plain;
        pastedChars = pastedHtml.length;
        draw();
      });
    }
  }
  draw();

  async function go(data, headers) {
    busy = true; error = null; draw();
    try {
      const params = new URLSearchParams({ kind, ...(source === 'pdf' ? { filename: data.name ?? '' } : {}) });
      const batch = await api(`/api/planning/incoming-orders/${source}?${params}`,
        { method: 'POST', headers, body: source === 'pdf' ? await data.arrayBuffer() : data });
      m.close();
      openBatchDialog(batch.id, onDone); // sonucu hemen gostersin diye: liste yerine dogrudan taslak ayrintisina gecer
      return;
    } catch (e) {
      error = e.message;
    }
    busy = false; draw();
  }

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="go"]')) { if (pastedChars > 0) go(pastedHtml, { 'content-type': 'text/plain; charset=utf-8' }); }
  });
  m.body.addEventListener('change', (ev) => {
    if (ev.target.name === 'kind') { kind = ev.target.value; return; }
    if (ev.target.dataset?.role !== 'file') return;
    const file = ev.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD) { error = `Dosya çok büyük (${Math.round(file.size / 1048576)} MB; en fazla 20 MB).`; draw(); return; }
    go(file, { 'content-type': 'application/pdf' });
  });
}

/* ============================================================================================== taslak ayrintisi */

/** Bir taslağın (PDF/e-posta) çıkardığı satırları gösterir; satır başına onayla/reddet/ürün seç. */
async function openBatchDialog(id, onDone) {
  const m = openModal({ title: 'Taslak sipariş satırları', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let b;
  try { b = await api(`/api/planning/incoming-orders/${id}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  let error = null;

  function revisionCell(l) {
    if (!l.isRevision) return '<span class="is-null">—</span>';
    const parts = [REVISION_LABEL[l.revisionType] ?? l.revisionType];
    if (l.revisionRaw) parts.push(`"${l.revisionRaw}"`);
    if (l.existingLineId != null) parts.push(`eski: ${fmtNum(l.existingQty)} adet · ${dateText(l.existingDueDate).replace(/<[^>]+>/g, '')}`);
    return chip('warn', '↻', parts.join(' · '));
  }

  function actions(l) {
    const attr = `data-id="${l.id}"`;
    if (l.status === 'bekliyor') {
      const approveBtn = l.matchStatus === 'tam'
        ? `<button type="button" class="icon-btn icon-btn-sm" data-act="approve" ${attr}>Onayla</button>`
        : `<button type="button" class="icon-btn icon-btn-sm" data-act="pick" ${attr}>Ürün seç ve onayla…</button>`;
      // "Duzenle...": onaylamadan/reddetmeden ONCE cikarilan HER sey (adet/teslim/siparis no/fiyat) duzeltilebilir
      // (CLAUDE.md "her sey duzelenebilir olsun" — fiyat yanlis/bos cikarsa burada duzeltilir).
      return `${approveBtn} <button type="button" class="icon-btn icon-btn-sm" data-act="edit" ${attr}>Düzenle…</button> ` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="reject" ${attr}>Reddet</button>`;
    }
    if (l.status === 'onaylandi') return `<button type="button" class="icon-btn icon-btn-sm" data-act="mikro" ${attr}>Mikro'ya gönder…</button>`;
    return '';
  }

  function draw() {
    const approvedCount = b.lines.filter((l) => l.status === 'onaylandi').length;
    m.body.innerHTML =
      `<p class="pl-wohead"><b>${escapeHtml(SOURCE_LABEL[b.source] ?? b.source)}</b> · ${escapeHtml(KIND_LABEL[b.kind] ?? b.kind)}</p>` +
      `<p class="hint">${escapeHtml(b.filename ?? '(dosya adı yok)')} · ${escapeHtml(b.customerGuess ?? 'müşteri tahmin edilemedi')}` +
      (b.warning ? ` · <span class="is-attn">${escapeHtml(b.warning)}</span>` : '') + '</p>' +
      '<p class="hint">Çıkarılan hiçbir alan kesin değildir — onaylamadan önce "Düzenle…" ile düzeltilebilir.</p>' +
      (approvedCount > 0
        ? `<p class="pl-bar"><button type="button" class="icon-btn btn-primary" data-act="mikro-batch">Onaylı ${approvedCount} satırı TEK siparişte Mikro'ya gönder…</button></p>`
        : '') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (b.lines.length === 0 ? '<p class="empty">Satır çıkarılamadı.</p>' :
        '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th>#</th><th>Müşteri sip. no</th><th>Kod</th><th>Açıklama</th>' +
        '<th class="num">Adet</th><th class="num">Fiyat</th><th>Teslim</th><th>Ürün</th><th>Revizyon</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>' +
        b.lines.map((l) =>
          `<tr><td>${l.rowNo}</td><td class="mono">${cellText(l.custOrderNo)}</td><td class="mono">${cellText(l.rawCode)}</td>` +
          `<td class="trunc"${truncCell(l.rawDescription)}>${cellText(l.rawDescription)}</td><td class="num">${fmtNum(l.qty)}</td>` +
          `<td class="num">${l.price == null ? '<span class="is-null">—</span>' : fmtDec(l.price)}</td>` +
          `<td>${dateText(l.deliveryDate)}</td><td>${matchChip(l)}</td><td>${revisionCell(l)}</td><td>${STATUS_CHIP[l.status] ?? l.status}</td><td>${actions(l)}</td></tr>`).join('') +
        '</tbody></table></div>');
  }

  draw();

  async function run(fn) {
    try { await fn(); onDone(); } catch (e) { error = e.message; } // onDone(): disaridaki liste sayimlari (bekliyor/onaylandi) hemen tazelenir
    b = await api(`/api/planning/incoming-orders/${id}`);
    draw();
  }

  m.body.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const { act, id: lineId } = btn.dataset;
    if (act === 'approve') run(() => post(`/api/planning/incoming-orders/lines/${lineId}/approve`, {}));
    else if (act === 'reject') run(() => post(`/api/planning/incoming-orders/lines/${lineId}/reject`, {}));
    else if (act === 'pick') openProductPicker((stockCode) => run(() => post(`/api/planning/incoming-orders/lines/${lineId}/approve`, { stockCode })));
    else if (act === 'mikro') openMikroSendDialog(lineId, b.lines.find((x) => x.id === Number(lineId))?.price, () => run(() => Promise.resolve()));
    else if (act === 'mikro-batch') openBatchMikroSendDialog(id, b.lines.filter((l) => l.status === 'onaylandi'), () => run(() => Promise.resolve()));
    else if (act === 'edit') openLineEditDialog(b.lines.find((x) => x.id === Number(lineId)), () => run(() => Promise.resolve()));
  });
}

/* ============================================================================================ satiri duzenle (onaydan once) */

/** Bekleyen bir satırın çıkarılmış alanlarını (adet/teslim tarihi/müşteri sipariş no/fiyat) düzeltir. */
function openLineEditDialog(line, onSaved) {
  const m = openModal({ title: `Satır #${line.rowNo}'ı düzenle` });
  m.body.innerHTML =
    '<p class="hint">Bu, PDF/e-postadan çıkarılan bir TASLAK değerdir — kesinlik iddia etmez, onaylamadan önce düzeltin.</p>' +
    '<form autocomplete="off"><div class="fld-grid">' +
    `<label class="fld"><span>Müşteri sipariş no</span><input name="custOrderNo" maxlength="50" value="${escapeHtml(line.custOrderNo ?? '')}"></label>` +
    `<label class="fld"><span>Adet *</span><input name="qty" type="number" min="1" step="1" required value="${line.qty ?? ''}"></label>` +
    `<label class="fld"><span>Teslim tarihi</span><input name="deliveryDate" type="date" value="${isoDate(line.deliveryDate)}"></label>` +
    `<label class="fld"><span>Fiyat (birim, ops.)</span><input name="price" type="text" inputmode="decimal" placeholder="bilinmiyorsa boş bırakın" value="${escapeHtml(priceInputValue(line.price))}"></label></div>` +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>';
  const form = m.body.querySelector('form');
  form.elements.qty.focus();
  m.body.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true; btn.disabled = true;
    const e = form.elements;
    const priceTxt = e.price.value.trim();
    const body = {
      custOrderNo: e.custOrderNo.value.trim() || null,
      qty: e.qty.value,
      deliveryDate: e.deliveryDate.value || null,
      price: priceTxt === '' ? null : priceTxt.replace(',', '.'),
    };
    try {
      await put(`/api/planning/incoming-orders/lines/${line.id}`, body);
      m.close();
      onSaved();
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false; btn.disabled = false;
    }
  });
}

/* ========================================================================================= Mikro'ya gonder */

/**
 * Onaylanmış bir satırı gerçek Mikro siparişine (SiparisKaydetV2) çevirir — ARAŞTIRILDI, GERÇEK Mikro'ya karşı
 * HENÜZ DENENMEDİ (bkz. CLAUDE.md §6 "mikro-order.js"). Müşteri kodu önce ürünün kendi sipariş geçmişinden
 * ÇÖZÜLMEYE çalışılır (`mikro-customer`); bulunamazsa elle aranır (CARI_HESAPLAR). "Mikro'ya gönder" yalnız
 * `MIKRO_WRITE_ENABLED=1` iken gerçekten yazar — kapalıyken her zaman 409 `mikro-write-disabled` döner.
 */
function openMikroSendDialog(lineId, linePrice, onDone) {
  const m = openModal({ title: 'Mikro\'ya gönder' });
  // Fiyat, taslaktan cikarilan/duzeltilen deger ile ONCEDEN DOLAR (bos degilse) — kullanici yine de degistirebilir.
  const st = { customerCode: null, customerName: null, unitPrice: priceInputValue(linePrice), note: '', preview: null, busy: false, error: null, sent: null };

  function draw() {
    m.body.innerHTML =
      '<p class="hint">Bu, araştırılmış bir yazma yoludur — henüz gerçek Mikro\'ya karşı denenmedi. Önce "Önizle" ile gönderilecek içeriği kontrol edin.</p>' +
      `<label class="fld"><span>Müşteri</span>` +
      (st.customerCode
        ? `<div class="pl-bar"><span class="mono">${escapeHtml(st.customerCode)}</span> <span>${cellText(st.customerName)}</span> <button type="button" class="icon-btn icon-btn-sm" data-act="pick-customer">Değiştir…</button></div>`
        : '<div class="pl-bar"><span class="is-null">bulunamadı</span> <button type="button" class="icon-btn icon-btn-sm" data-act="pick-customer">Müşteri seç…</button></div>') +
      '</label>' +
      `<label class="fld"><span>Birim fiyat (ops.)</span><input type="text" inputmode="decimal" data-role="price" value="${escapeHtml(st.unitPrice)}" placeholder="bilinmiyorsa boş bırakın"></label>` +
      `<label class="fld"><span>Not (ops.)</span><input type="text" maxlength="200" data-role="note" value="${escapeHtml(st.note)}"></label>` +
      (st.error ? `<p class="notice notice-sim">${escapeHtml(st.error)}</p>` : '') +
      (st.preview
        ? (st.preview.writeEnabled
            ? '<p class="notice">Mikro\'ya gerçek yazma AÇIK: "Mikro\'ya gönder" gerçekten bir sipariş oluşturur.</p>'
            : '<p class="notice notice-sim">Mikro\'ya gerçek yazma şu an KAPALI: "Mikro\'ya gönder" yine de denenir ama 409 ile reddedilir, hiçbir şey gitmez.</p>') +
          '<p class="hint"><b>Gönderilecek gövde</b> (SiparisKaydetV2):</p><pre class="code-view">' + escapeHtml(JSON.stringify(st.preview.body, null, 2)) + '</pre>' +
          (st.preview.assumed?.length ? `<p class="hint">Hâlâ doğrulanmamış: ${st.preview.assumed.map((a) => escapeHtml(a)).join(' · ')}</p>` : '')
        : '') +
      (st.sent ? `<p class="notice${st.sent.ok ? '' : ' notice-sim'}">${escapeHtml(st.sent.text)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      `<button type="button" class="icon-btn" data-act="preview"${st.busy || !st.customerCode ? ' disabled' : ''}>Önizle</button>` +
      `<button type="button" class="icon-btn btn-primary" data-act="send"${st.busy || !st.customerCode ? ' disabled' : ''}>Mikro'ya gönder</button></div>`;
  }

  async function resolveCustomer() {
    try {
      const r = await api(`/api/planning/incoming-orders/lines/${lineId}/mikro-customer`);
      if (r.customer) { st.customerCode = r.customer.customerCode; st.customerName = r.customer.name; }
    } catch (err) { st.error = err.message; }
    draw();
  }

  function pickCustomer() {
    openCustomerPicker((code, name) => { st.customerCode = code; st.customerName = name; st.preview = null; st.sent = null; draw(); });
  }

  async function call(kind) {
    st.busy = true; st.error = null; draw();
    try {
      const body = { customerCode: st.customerCode, unitPriceValue: st.unitPrice.trim() === '' ? null : st.unitPrice.trim().replace(',', '.'), note: st.note.trim() || null };
      const r = await post(`/api/planning/incoming-orders/lines/${lineId}/mikro-${kind}`, body);
      if (kind === 'preview') st.preview = r;
      else { st.sent = { ok: true, text: 'Gönderildi.' }; onDone(); }
    } catch (err) {
      if (kind === 'send') st.sent = { ok: false, text: err.message };
      else st.error = err.message;
    }
    st.busy = false; draw();
  }

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="pick-customer"]')) { pickCustomer(); return; }
    if (ev.target.closest('[data-act="preview"]')) { call('preview'); return; }
    if (ev.target.closest('[data-act="send"]')) { call('send'); return; }
  });
  m.body.addEventListener('input', (ev) => {
    if (ev.target.dataset.role === 'price') st.unitPrice = ev.target.value;
    else if (ev.target.dataset.role === 'note') st.note = ev.target.value;
  });

  draw();
  resolveCustomer();
}

/** Mikro'da (CARI_HESAPLAR) müşteri arayıp seçen genel-amaçlı pencere — hem tek satır hem toplu gönderme kullanır. */
function openCustomerPicker(onPick) {
  const pm = openModal({ title: 'Müşteri seç' });
  pm.body.innerHTML = '<input type="search" class="pl-search" data-role="q" placeholder="Müşteri adı…" aria-label="Müşteri ara"><div data-role="res" class="pl-picker"><p class="empty">Aramaya başlayın.</p></div>';
  const q = pm.body.querySelector('[data-role="q"]');
  const res = pm.body.querySelector('[data-role="res"]');
  let seq = 0;
  const search = debounce(async () => {
    const my = ++seq;
    const txt = q.value.trim();
    if (txt === '') { res.innerHTML = '<p class="empty">Aramaya başlayın.</p>'; return; }
    try {
      const r = await api(`/api/planning/incoming-orders/mikro/customers?${new URLSearchParams({ q: txt, limit: 30 })}`);
      if (my !== seq) return;
      res.innerHTML = r.items.length === 0 ? '<p class="empty">Eşleşen müşteri yok.</p>' :
        '<table class="tbl"><tbody>' + r.items.map((c) => `<tr class="pl-row" data-code="${escapeHtml(c.customerCode)}" data-name="${escapeHtml(c.name)}" tabindex="0"><td class="mono">${escapeHtml(c.customerCode)}</td><td>${cellText(c.name)}</td></tr>`).join('') + '</tbody></table>';
    } catch (err) { if (my === seq) res.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`; }
  }, 250);
  q.addEventListener('input', search);
  res.addEventListener('click', (ev) => {
    const row = ev.target.closest('.pl-row');
    if (!row) return;
    pm.close();
    onPick(row.dataset.code, row.dataset.name);
  });
  q.focus();
}

/**
 * Taslağın TÜM onaylı satırlarını TEK Mikro siparişine (tek evrak, çok kalem) çevirir (2026-11-19, kullanıcı
 * isteği: "bunların hepsi tek sipariş içinde... tek bir siparişte mikroya yaz"). Satır başına fiyat zaten
 * onaylanırken sabitlendi (`approveLine` sonrası fiyat değişmez) — burada düzenlenmez, yalnız LİSTELENİR.
 * Müşteri önce ilk onaylı satırın ürününden ÇÖZÜLMEYE çalışılır; birden çok farklı müşteriye çıkarsa (aynı
 * evrakta tek müşteri olmalı) sunucu 409 `multiple-customers` ile reddeder, kullanıcı elle seçer.
 */
function openBatchMikroSendDialog(batchId, lines, onDone) {
  const m = openModal({ title: 'Tek siparişte Mikro\'ya gönder', wide: true });
  const st = { customerCode: null, customerName: null, note: '', preview: null, busy: false, error: null, sent: null };

  function draw() {
    m.body.innerHTML =
      '<p class="hint">Bu, araştırılmış bir yazma yoludur. Önce "Önizle" ile gönderilecek içeriği kontrol edin.</p>' +
      '<p class="hint"><b>Gönderilecek kalemler</b> (hepsi AYNI evrakta):</p>' +
      '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>#</th><th>Ürün</th><th class="num">Adet</th><th class="num">Fiyat</th><th>Teslim</th></tr></thead><tbody>' +
      lines.map((l) => `<tr><td>${l.rowNo}</td><td class="mono">${escapeHtml(l.matchedStockCode)}</td><td class="num">${fmtNum(l.qty)}</td>` +
        `<td class="num">${l.price == null ? '<span class="is-null">—</span>' : fmtDec(l.price)}</td><td>${dateText(l.deliveryDate)}</td></tr>`).join('') +
      '</tbody></table></div>' +
      `<label class="fld"><span>Müşteri</span>` +
      (st.customerCode
        ? `<div class="pl-bar"><span class="mono">${escapeHtml(st.customerCode)}</span> <span>${cellText(st.customerName)}</span> <button type="button" class="icon-btn icon-btn-sm" data-act="pick-customer">Değiştir…</button></div>`
        : '<div class="pl-bar"><span class="is-null">bulunamadı</span> <button type="button" class="icon-btn icon-btn-sm" data-act="pick-customer">Müşteri seç…</button></div>') +
      '</label>' +
      `<label class="fld"><span>Not (ops.)</span><input type="text" maxlength="200" data-role="note" value="${escapeHtml(st.note)}"></label>` +
      (st.error ? `<p class="notice notice-sim">${escapeHtml(st.error)}</p>` : '') +
      (st.preview
        ? (st.preview.writeEnabled
            ? '<p class="notice">Mikro\'ya gerçek yazma AÇIK: "Mikro\'ya gönder" gerçekten bir sipariş oluşturur.</p>'
            : '<p class="notice notice-sim">Mikro\'ya gerçek yazma şu an KAPALI: "Mikro\'ya gönder" yine de denenir ama 409 ile reddedilir, hiçbir şey gitmez.</p>') +
          '<p class="hint"><b>Gönderilecek gövde</b> (SiparisKaydetV2, tek evrak · ' + lines.length + ' kalem):</p><pre class="code-view">' + escapeHtml(JSON.stringify(st.preview.body, null, 2)) + '</pre>' +
          (st.preview.assumed?.length ? `<p class="hint">Hâlâ doğrulanmamış: ${st.preview.assumed.map((a) => escapeHtml(a)).join(' · ')}</p>` : '')
        : '') +
      (st.sent ? `<p class="notice${st.sent.ok ? '' : ' notice-sim'}">${escapeHtml(st.sent.text)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      `<button type="button" class="icon-btn" data-act="preview"${st.busy ? ' disabled' : ''}>Önizle</button>` +
      `<button type="button" class="icon-btn btn-primary" data-act="send"${st.busy ? ' disabled' : ''}>Mikro'ya gönder</button></div>`;
  }

  async function resolveCustomer() {
    try {
      const r = await api(`/api/planning/incoming-orders/${batchId}/mikro-customer`);
      if (r.customer) { st.customerCode = r.customer.customerCode; st.customerName = r.customer.name; }
    } catch (err) { st.error = err.message; }
    draw();
  }

  async function call(kind) {
    st.busy = true; st.error = null; draw();
    try {
      const body = { customerCode: st.customerCode, note: st.note.trim() || null };
      const r = await post(`/api/planning/incoming-orders/${batchId}/mikro-${kind}`, body);
      if (kind === 'preview') st.preview = r;
      else { st.sent = { ok: true, text: 'Gönderildi.' }; onDone(); }
    } catch (err) {
      if (kind === 'send') st.sent = { ok: false, text: err.message };
      else st.error = err.message;
    }
    st.busy = false; draw();
  }

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="pick-customer"]')) { openCustomerPicker((code, name) => { st.customerCode = code; st.customerName = name; st.preview = null; st.sent = null; draw(); }); return; }
    if (ev.target.closest('[data-act="preview"]')) { call('preview'); return; }
    if (ev.target.closest('[data-act="send"]')) { call('send'); return; }
  });
  m.body.addEventListener('input', (ev) => { if (ev.target.dataset.role === 'note') st.note = ev.target.value; });

  draw();
  resolveCustomer();
}

/** Satır için elle ürün seçme (eşleşmemiş/belirsiz satırlar); bu ekranın KENDİ dar arama ucu. */
function openProductPicker(onPick) {
  const m = openModal({ title: 'Hangi ürün?' });
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
      const r = await api(`/api/planning/incoming-orders/product-search?${new URLSearchParams({ q: text, limit: 30 })}`);
      if (my !== seq) return;
      res.innerHTML = r.items.length === 0 ? '<p class="empty">Eşleşen ürün yok.</p>' :
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
