/**
 * Planlama > Paketleme > PAKETLEME FORMU (EYS.FR.007): kagit formun dijital karsiligi. Her sey ALEN OTOMAT URUN KODU uzerinden: vardiya sayfasina urun satirlari girilir
 * (operator, urun, is emri, koli sayisi, koli ici adet, yarim koli adedi, %100 gorsel kontrol, hurda adedi); sayfa basliginda tarih, vardiya ve hava basinci vardir.
 *
 * Koli ici adet bir urunde genelde SABITTIR: ilk koli kaydedilince urun kartina "standart" olarak yazilir ve sonraki paketlemelerde ONERI olarak gelir; kutuya bazen 10-15 adet
 * fazla girer, bu yuzden satirdaki adet serbestce degistirilir (standart degismez) ve son paketlemelerde sik gorulen degerler de onerilir. Urunun kutu etiketi dosyasi
 * (Word) ekranda acilir. Formu A4 yatay yazdirir.
 *
 * Hesaplar sunucuda (backend/planning/packing.js); burasi yalniz gosterir. Gunluk akis: tarih/vardiya secili gelir, hava basincini girin, satirlari ekleyin.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, cellText, fmtNum, openModal, rememberedPerson, rememberPerson, debounce, printModal, sizeText, chip, truncCell } from './planning-common.js';

const REFRESH_MS = 30_000;
const SHIFTS = Object.freeze([['gunduz', 'Gündüz'], ['gece', 'Gece']]);
const FORM_NO = 'EYS.FR.007';
const FORM_DATE = '18.09.2024';

/** Alan metni -> sayi ya da null (bos); virgul ondalik/binlik toleransi sunucuda. */
const num = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : Number(s.replace(/\s/g, '').replace(',', '.')); };
const dayText = (key) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const ORDER_STATE = Object.freeze({ uretimde: 'üretimde', bitti: 'bitti', planlandi: 'bekliyor' });

/** @param {HTMLElement} host */
export async function renderPackingForm(host) {
  const token = Symbol('packing-form');
  host.__pkToken = token;
  const st = { day: null, shift: null, sheet: null, product: null, suggest: null, editing: null, seq: 0 };
  host.innerHTML =
    '<p class="hint">Kâğıt <b>Paketleme Formu</b>\'nun (' + FORM_NO + ') yerine: ürünü <b>Alen Otomat ürün koduyla</b> seçin, koli sayısını ve koli içi adedi girin. ' +
    'Koli içi adet o ürünün ilk kolisinden öğrenilir ve bir sonraki sefer <b>öneri</b> olarak gelir; kutuya bazen fazla girer, adedi değiştirebilirsiniz.</p>' +
    '<div class="pl-bar pk-head"><label class="fld-inline">Tarih <input type="date" data-role="day"></label>' +
    '<div class="seg" role="group" aria-label="Vardiya" data-role="shifts">' + SHIFTS.map(([id, label]) => `<button type="button" data-shift="${id}">${label}</button>`).join('') + '</div>' +
    '<label class="fld-inline">Hava basıncı (bar) <input data-role="air" inputmode="decimal" size="4" autocomplete="off" aria-label="Hava basınç gösterge değeri (bar)"></label>' +
    '<button type="button" class="icon-btn" data-act="now">Şimdiki vardiya</button>' +
    '<button type="button" class="icon-btn" data-act="print">Formu yazdır…</button></div>' +
    '<form class="pk-entry" data-role="entry" autocomplete="off">' +
    '<div class="fld-grid"><label class="fld"><span>Operatör ismi</span><input name="operator" maxlength="60" required></label>' +
    '<div class="fld pl-wide"><span>Ürün (Alen Otomat ürün kodu ya da ürün adı)</span>' +
    '<input type="search" data-role="product-q" placeholder="ör. SR002.013" aria-label="Ürün ara" autocomplete="off">' +
    '<div class="pk-results" data-role="results" hidden></div><div class="pk-picked" data-role="picked" hidden></div></div></div>' +
    '<div class="pk-suggest" data-role="suggest" hidden></div>' +
    '<div class="fld-grid pk-nums">' +
    '<label class="fld"><span>Koli sayısı</span><input name="boxes" inputmode="numeric" autocomplete="off"></label>' +
    '<label class="fld"><span>Koli içi adet</span><input name="boxQty" inputmode="numeric" autocomplete="off"></label>' +
    '<label class="fld"><span>Yarım koli adedi</span><input name="halfQty" inputmode="numeric" autocomplete="off"></label>' +
    '<label class="fld"><span>Hurda adedi</span><input name="scrapQty" inputmode="numeric" autocomplete="off"></label>' +
    '<label class="chk pk-chk"><input type="checkbox" name="visualCheck"> %100 görsel kontrol yapıldı</label>' +
    '<label class="fld"><span>Not (isteğe bağlı)</span><input name="note" maxlength="200" autocomplete="off"></label></div>' +
    '<p class="pk-total" data-role="total" aria-live="polite"></p>' +
    '<p class="notice notice-sim" data-role="err" hidden></p><p class="notice" data-role="msg" hidden></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="cancel" hidden>Vazgeç</button>' +
    '<button type="submit" class="icon-btn shop-btn btn-primary" data-role="save">Satırı ekle</button></div></form>' +
    '<h4 class="sub" data-role="sheet-title"></h4><div class="table-wrap table-wrap-tall" data-role="table"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  const form = $('entry');
  form.elements.operator.value = rememberedPerson();

  /* ---------------------------------------------------------------- sayfa */

  async function loadSheet() {
    const my = ++st.seq;
    try {
      const q = new URLSearchParams({ ...(st.day ? { day: st.day } : {}), ...(st.shift ? { shift: st.shift } : {}) });
      const s = await api(`/api/planning/packing/sheet${q.size ? `?${q}` : ''}`);
      if (my !== st.seq) return;
      st.sheet = s;
      st.day = s.day;
      st.shift = s.shift;
      drawSheet();
    } catch (e) {
      if (my === st.seq) $('table').innerHTML = `<p class="notice notice-sim">Sayfa alınamadı: ${escapeHtml(e.message)}</p>`;
    }
  }

  function drawSheet() {
    const s = st.sheet;
    $('day').value = s.day;
    for (const b of host.querySelectorAll('[data-shift]')) { const on = b.dataset.shift === s.shift; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); }
    if (document.activeElement !== $('air')) $('air').value = s.airBar == null ? '' : String(s.airBar).replace('.', ',');
    $('sheet-title').textContent = `${dayText(s.day)} · ${s.shiftLabel} vardiyası · ${fmtNum(s.totals.rows)} satır · ${fmtNum(s.totals.boxes)} koli · ${fmtNum(s.totals.pieces)} adet${s.totals.scrap > 0 ? ` · hurda ${fmtNum(s.totals.scrap)}` : ''}`;
    $('table').innerHTML = s.rows.length === 0 ? '<p class="empty">Bu vardiyada henüz paketleme satırı yok.</p>' :
      '<table class="tbl tbl-pl"><thead><tr><th>Operatör</th><th>Alen ürün kodu</th><th>Müşteri ürün kodu</th><th>Ürün tanımı</th><th>İş emri</th><th class="num">Koli</th><th class="num">Koli içi</th>' +
      '<th class="num">Yarım koli</th><th>%100 görsel</th><th class="num">Hurda</th><th class="num">Toplam adet</th><th></th></tr></thead><tbody>' +
      s.rows.map((r) =>
        `<tr data-id="${r.id}"><td class="trunc"${truncCell(r.operator)}>${cellText(r.operator)}</td><td class="mono"><b>${escapeHtml(r.stockCode)}</b></td><td class="mono">${cellText(r.customerCode)}</td><td class="trunc"${truncCell(r.productName)}>${cellText(r.productName)}</td>` +
        `<td class="mono">${cellText(r.woNo)}</td><td class="num">${fmtNum(r.boxes)}</td><td class="num">${fmtNum(r.boxQty)}</td><td class="num">${r.halfQty == null ? cellText(null) : fmtNum(r.halfQty)}</td>` +
        `<td>${r.visualCheck ? chip('ok', '✓', 'yapıldı') : '<span class="is-null">—</span>'}</td><td class="num">${r.scrapQty == null ? cellText(null) : fmtNum(r.scrapQty)}</td>` +
        `<td class="num"><b>${fmtNum(r.total)}</b></td><td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="edit">Düzenle</button> ` +
        '<button type="button" class="icon-btn icon-btn-sm" data-act="void">İptal…</button></td></tr>').join('') +
      `</tbody><tfoot><tr><th colspan="5">Toplam</th><th class="num">${fmtNum(s.totals.boxes)}</th><th colspan="3"></th><th class="num">${fmtNum(s.totals.scrap)}</th><th class="num">${fmtNum(s.totals.pieces)}</th><th></th></tr></tfoot></table>`;
  }

  /* ---------------------------------------------------------------- urun secimi ve oneri */

  const err = (msg) => { const e = $('err'); e.textContent = msg ?? ''; e.hidden = !msg; };
  const note = (msg) => { const e = $('msg'); e.textContent = msg ?? ''; e.hidden = !msg; };

  function drawPicked() {
    const p = st.product;
    $('picked').hidden = !p;
    $('product-q').hidden = !!p;
    $('results').hidden = true;
    if (!p) { $('suggest').hidden = true; return; }
    $('picked').innerHTML = `<b class="mono">${escapeHtml(p.stockCode)}</b> · ${cellText(p.name)}${p.customerCode ? ` · müşteri kodu <span class="mono">${escapeHtml(p.customerCode)}</span>` : ''}` +
      `${st.editing ? '' : ' <button type="button" class="icon-btn icon-btn-sm" data-act="change-product">Değiştir</button>'}`;
  }

  function drawSuggest(prefillWo = null) {
    const s = st.suggest;
    const box = $('suggest');
    box.hidden = !s;
    if (!s) return;
    const standard = s.boxQty == null
      ? 'Bu ürün için standart koli içi adet <b>henüz yok</b>: ilk koli kaydedilince ürün kartına yazılır ve sonra öneri olarak gelir.'
      : `Standart koli içi adet: <b>${fmtNum(s.boxQty)}</b> <span class="hint">(ürün kartında; kutuya bazen fazla girer, değiştirebilirsiniz)</span>`;
    const common = s.common.length > 1 || (s.common.length === 1 && s.common[0].boxQty !== s.boxQty)
      ? `<p class="hint">Son paketlemelerde: ${s.common.map((c) => `<button type="button" class="chip chip-none pk-chip" data-qty="${c.boxQty}">${fmtNum(c.boxQty)} × ${c.count}</button>`).join(' ')}</p>` : '';
    const orders = s.orders.length === 0
      ? '<p class="hint">Bu ürüne ait iş emri yok: iş emri bağlamadan da kaydedebilirsiniz.</p>'
      : '<label class="fld"><span>İş emri (isteğe bağlı)</span><select name="woNo"><option value="">— bağlı değil —</option>' +
        s.orders.map((o) => `<option value="${escapeHtml(o.no)}"${(prefillWo ?? (s.orders.filter((x) => x.status === 'uretimde').length === 1 ? s.orders.find((x) => x.status === 'uretimde').no : null)) === o.no ? ' selected' : ''}>` +
          `${escapeHtml(o.no)} · ${ORDER_STATE[o.status] ?? o.status} · hedef ${fmtNum(o.targetQty)}${o.machineId ? ` · ${escapeHtml(o.machineId)}` : ''}</option>`).join('') + '</select></label>';
    const stickers = s.stickers.length === 0
      ? '<p class="hint">Kutu etiketi dosyası yok (Ürün kartları › "Etiketleri eşle…" ile klasörden bağlanır).</p>'
      : `<p class="hint">Kutu etiketi: ${s.stickers.map((f) => `<a href="/api/planning/product-files/${f.id}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a> <small>(${f.folder ? `${escapeHtml(f.folder)} · ` : ''}${escapeHtml(sizeText(f.size))})</small>`).join(' · ')}</p>`;
    box.innerHTML = `<p>${standard}</p>${common}${orders}${stickers}`;
  }

  async function pick(p, { woNo = null, keepQty = false } = {}) {
    st.product = p;
    st.suggest = null;
    drawPicked();
    try {
      st.suggest = await api(`/api/planning/packing/suggest?${new URLSearchParams({ stockCode: p.stockCode })}`);
      drawSuggest(woNo);
      if (!keepQty && !form.elements.boxQty.value && st.suggest.boxQty != null) form.elements.boxQty.value = String(st.suggest.boxQty);
      updateTotal();
    } catch (e) { err(e.message); }
  }

  const searchProducts = debounce(async (q) => {
    const box = $('results');
    if (q.length < 2) { box.hidden = true; return; }
    try {
      const r = await api(`/api/planning/programs/product-search?${new URLSearchParams({ q, limit: 8 })}`);
      box.innerHTML = r.items.length === 0 ? '<p class="hint">Eşleşen ürün yok.</p>' :
        r.items.map((x) => `<button type="button" class="pk-result" data-code="${escapeHtml(x.stockCode)}"><b class="mono">${escapeHtml(x.stockCode)}</b> ${cellText(x.name)}` +
          `${x.customerCode ? ` <span class="hint mono">${escapeHtml(x.customerCode)}</span>` : ''}</button>`).join('');
      box.hidden = false;
      box._items = r.items;
    } catch { box.hidden = true; }
  }, 220);

  function updateTotal() {
    const b = num(form.elements.boxes.value) ?? 0;
    const q = num(form.elements.boxQty.value) ?? 0;
    const h = num(form.elements.halfQty.value) ?? 0;
    const total = b * q + h;
    $('total').textContent = total > 0 || b > 0
      ? `Toplam: ${fmtNum(b)} × ${fmtNum(q)}${h ? ` + ${fmtNum(h)}` : ''} = ${fmtNum(total)} adet`
      : '';
  }

  function resetEntry({ keepOperator = true } = {}) {
    const op = form.elements.operator.value;
    form.reset();
    form.elements.operator.value = keepOperator ? op : '';
    st.product = null;
    st.suggest = null;
    st.editing = null;
    $('product-q').value = '';
    $('save').textContent = 'Satırı ekle';
    host.querySelector('[data-act="cancel"]').hidden = true;
    drawPicked();
    updateTotal();
  }

  /* ---------------------------------------------------------------- olaylar */

  host.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset?.role === 'product-q') searchProducts(t.value.trim());
    else if (t.closest?.('.pk-nums')) updateTotal();
  });
  host.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.dataset?.role === 'day') { st.day = t.value || null; loadSheet(); }
    else if (t.dataset?.role === 'air') {
      try { st.sheet = { ...st.sheet, ...(await put('/api/planning/packing/sheet/air', { day: st.day, shift: st.shift, airBar: t.value })) }; drawSheet(); note(null); } catch (e) { err(e.message); }
    }
  });
  host.addEventListener('click', async (ev) => {
    const el = ev.target.closest('button, a');
    if (!el || el.tagName === 'A') return;
    if (el.dataset.shift) { st.shift = el.dataset.shift; return loadSheet(); }
    if (el.classList.contains('pk-result')) { const item = $('results')._items.find((x) => x.stockCode === el.dataset.code); if (item) pick(item); return; }
    if (el.classList.contains('pk-chip')) { form.elements.boxQty.value = el.dataset.qty; updateTotal(); return; }
    const act = el.dataset.act;
    if (act === 'now') { st.day = null; st.shift = null; return loadSheet(); }
    if (act === 'print') return openPrint(st.sheet);
    if (act === 'change-product') { st.product = null; st.suggest = null; drawPicked(); $('product-q').focus(); return; }
    if (act === 'cancel') { resetEntry(); err(null); note(null); return; }
    const id = Number(el.closest('tr')?.dataset.id);
    if (act === 'edit' && id) {
      const r = st.sheet.rows.find((x) => x.id === id);
      if (!r) return;
      err(null); note(null);
      st.editing = id;
      const e = form.elements;
      e.operator.value = r.operator; e.boxes.value = r.boxes || ''; e.boxQty.value = r.boxQty || ''; e.halfQty.value = r.halfQty ?? ''; e.scrapQty.value = r.scrapQty ?? '';
      e.visualCheck.checked = r.visualCheck; e.note.value = r.note ?? '';
      $('save').textContent = 'Satırı güncelle';
      host.querySelector('[data-act="cancel"]').hidden = false;
      await pick({ stockCode: r.stockCode, name: r.productName, customerCode: r.customerCode }, { woNo: r.woNo, keepQty: true });
      updateTotal();
      form.scrollIntoView({ block: 'nearest' });
    } else if (act === 'void' && id) {
      const r = st.sheet.rows.find((x) => x.id === id);
      if (!window.confirm(`${r?.stockCode ?? 'Bu'} satırı iptal edilsin mi? (Kayıt silinmez, sayfada ve toplamda görünmez.)`)) return;
      const reason = window.prompt('İptal nedeni (isteğe bağlı):', '') ?? '';
      try { await del(`/api/planning/packing/rows/${id}?${new URLSearchParams({ reason })}`); await loadSheet(); } catch (e) { err(e.message); }
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err(null); note(null);
    if (!st.product) { err('Önce ürünü seçin.'); return; }
    const e = form.elements;
    const body = {
      day: st.day, shift: st.shift, stockCode: st.product.stockCode, operator: e.operator.value, woNo: e.woNo?.value ?? '',
      boxes: num(e.boxes.value), boxQty: num(e.boxQty.value), halfQty: num(e.halfQty.value), scrapQty: num(e.scrapQty.value), visualCheck: e.visualCheck.checked, note: e.note.value,
    };
    rememberPerson(body.operator);
    const btn = $('save');
    btn.disabled = true;
    try {
      if (st.editing) {
        await put(`/api/planning/packing/rows/${st.editing}`, body);
        note('Satır güncellendi.');
      } else {
        const r = await post('/api/planning/packing/rows', body);
        note(`${r.stockCode} · ${fmtNum(r.total)} adet kaydedildi.${r.learned ? ` Bu ürün için standart koli içi adet ${fmtNum(r.standardBoxQty)} olarak ürün kartına yazıldı (Ürün kartından değiştirilebilir).` : ''}`);
      }
      resetEntry();
      await loadSheet();
      $('product-q').focus();
    } catch (e2) { err(e2.message); } finally { btn.disabled = false; }
  });

  await loadSheet();
  const timer = setInterval(() => {
    if (host.__pkToken !== token || !host.isConnected) { clearInterval(timer); return; }
    loadSheet();
  }, REFRESH_MS);
}

/* ================================================================== yazdir */

/** Kagit formun duzeninde A4 yatay: baslik (hava basinci, tarih, vardiya), satirlar ve elle doldurulacak bos satirlar. */
function openPrint(s) {
  const m = openModal({ title: 'Yazdır · Paketleme formu', wide: true });
  m.dlg.classList.add('pl-form-dlg');
  const blank = Math.max(0, 14 - s.rows.length);
  const cells = (r) => [r.operator, r.stockCode, r.customerCode, r.productName, r.woNo, r.boxes || '', r.boxQty || '', r.halfQty == null ? '' : `+${r.halfQty}`, r.visualCheck ? '✓' : '', r.scrapQty ?? '']
    .map((c) => `<td>${c == null ? '' : escapeHtml(String(c))}</td>`).join('');
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    '<p class="hint pl-form-actions">A4 yatay. Boş satırlar elle doldurmak içindir.</p>' +
    '<div class="pl-pk"><div class="pl-pk-head"><div class="pl-pk-title">PAKETLEME FORMU</div>' +
    `<div class="pl-pk-meta"><div><span>TARİH:</span> <b>${escapeHtml(dayText(s.day))}</b></div><div><span>VARDİYA:</span> <b>${escapeHtml(s.shiftLabel)}</b></div></div></div>` +
    `<p class="pl-pk-air">HAVA BASINÇ GÖSTERGE DEĞERİ: <b>${s.airBar == null ? '' : escapeHtml(String(s.airBar).replace('.', ','))}</b> Bar</p>` +
    '<table class="pl-pk-t"><thead><tr><th>OPERATÖR İSMİ</th><th>ALEN OTOMAT ÜRÜN KODU</th><th>MÜŞTERİ ÜRÜN KODU</th><th>ÜRÜN TANIMI</th><th>İŞ EMRİ NO</th><th>KOLİ SAYISI</th>' +
    '<th>KOLİ İÇİ ADET</th><th>YARIM KOLİ ADETİ</th><th>%100 GÖRSEL KONT.</th><th>HURDA ADETİ</th></tr></thead><tbody>' +
    s.rows.map((r) => `<tr>${cells(r)}</tr>`).join('') + Array.from({ length: blank }, () => `<tr>${'<td></td>'.repeat(10)}</tr>`).join('') + '</tbody></table>' +
    `<p class="pl-pk-foot">${FORM_NO} · yayın tar. ${FORM_DATE} · toplam ${fmtNum(s.totals.pieces)} adet, ${fmtNum(s.totals.boxes)} koli · Sistemden basıldı ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p></div>`;
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}
