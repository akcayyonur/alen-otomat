/**
 * Planlama > Urunler: urun karti listesi, arama, duzenleme ve yeni urun.
 * Agirliklar kg saklanir, burada GRAM girilir/gosterilir. Elle duzenlenen kart, Excel iceri almasiyla ezilmez.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, cellText, fmtNum, gramText, dateTimeText, debounce, openModal, parseInput, gramToKg, chip } from './planning-common.js';

const PAGE = 100;
const SOURCE = Object.freeze({ elle: 'elle', 'csv-isemri': 'iş emri CSV', 'csv-siparis': 'sipariş CSV' });

/** @param {HTMLElement} host */
export function renderProducts(host) {
  const st = { q: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Stok kodu, ürün adı ya da müşteri kodu ara…" aria-label="Ürün ara">' +
    '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni ürün</button></div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>' +
    '<p class="pl-more" data-role="more" hidden><button type="button" class="icon-btn" data-act="more">Daha fazla göster</button></p>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q ? 'Eşleşen ürün yok.' : 'Henüz ürün kartı yok. Sağ üstteki "CSV içeri al" ile iş emirleri listesini ya da sipariş dosyasını yükleyin, ya da "Yeni ürün" ile elle ekleyin.')
      : `${fmtNum(st.total)} ürün${st.items.length < st.total ? ` (ilk ${fmtNum(st.items.length)} gösteriliyor)` : ''}`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Stok kodu</th><th>Ürün adı</th><th>Müşteri kodu</th><th>Hammadde</th>' +
      '<th class="num">Tam boy (mm)</th><th class="num">Net (g)</th><th class="num">Brüt (g)</th><th class="num">Planlanan (sn)</th>' +
      '<th class="num">Program</th><th>Kaynak</th></tr></thead><tbody>' +
      st.items.map((p) =>
        `<tr class="pl-row" data-code="${escapeHtml(p.stockCode)}" tabindex="0">` +
        `<td class="mono"><b>${escapeHtml(p.stockCode)}</b></td><td>${cellText(p.name)}</td><td class="mono">${cellText(p.customerCode)}</td>` +
        `<td class="mono">${cellText(p.material)}</td><td class="num">${fmtNum(p.lengthMm, 1)}</td><td class="num">${gramText(p.netKg)}</td>` +
        `<td class="num">${gramText(p.grossKg)}</td><td class="num">${fmtNum(p.plannedSec, 1)}</td>` +
        `<td class="num">${p.programCount > 0 ? fmtNum(p.programCount) : '<span class="is-null" title="Hiçbir program bu ürüne eşlenmemiş">—</span>'}</td>` +
        `<td>${p.edited ? chip('info', '✎', 'elle') : `<span class="hint" style="margin:0">${escapeHtml(SOURCE[p.source] ?? p.source)}</span>`}</td></tr>`).join('') +
      '</tbody></table>';
    $('more').hidden = st.items.length >= st.total;
  }

  async function load(reset) {
    const seq = ++st.seq;
    const offset = reset ? 0 : st.items.length;
    try {
      const r = await api(`/api/planning/products?${new URLSearchParams({ q: st.q, limit: PAGE, offset })}`);
      if (seq !== st.seq) return;
      st.total = r.total;
      st.items = reset ? r.items : [...st.items, ...r.items];
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Ürünler alınamadı: ${err.message}`;
    }
  }

  const search = debounce((value) => { st.q = value.trim(); load(true); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onclick = (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') return openProductDialog(null, () => load(true));
    if (act === 'more') return load(false);
    const row = ev.target.closest('.pl-row');
    if (row) openProductDialog(row.dataset.code, () => load(true));
  };
  host.onkeydown = (ev) => {
    if (ev.key !== 'Enter') return;
    const row = ev.target.closest?.('.pl-row');
    if (row) openProductDialog(row.dataset.code, () => load(true));
  };
  load(true);
}

/** @param {string|null} code null = yeni urun */
export async function openProductDialog(code, onSaved = () => {}) {
  const isNew = code === null;
  const m = openModal({ title: isNew ? 'Yeni ürün kartı' : `Ürün kartı · ${code}` });
  let p = null;
  if (!isNew) {
    m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
    try {
      p = await api(`/api/planning/products/${encodeURIComponent(code)}`);
    } catch (err) {
      m.body.innerHTML = `<p class="notice notice-sim">Ürün alınamadı: ${escapeHtml(err.message)}</p>`;
      return;
    }
  }
  const g = (kg) => (kg === null || kg === undefined ? '' : String(Number((kg * 1000).toFixed(4))).replace('.', ','));
  const v = (x) => (x === null || x === undefined ? '' : String(x).replace('.', ','));
  const field = (name, label, value, extra = '') =>
    `<label class="fld"><span>${escapeHtml(label)}</span><input name="${name}" value="${escapeHtml(value)}" autocomplete="off"${extra}></label>`;

  m.body.innerHTML =
    '<form autocomplete="off" data-role="form">' +
    (p?.edited ? '<p class="notice">Bu kart elle düzenlendi: CSV içeri alma bu kartın <b>dolu</b> alanlarını ezmez, yalnızca boş alanları doldurur.</p>' : '') +
    '<div class="fld-grid">' +
    field('stockCode', 'Stok kodu (Mikro)', p?.stockCode ?? '', isNew ? ' required maxlength="40" placeholder="ör. SR001.013"' : ' readonly') +
    `<label class="fld pl-wide"><span>Ürün adı</span><input name="name" value="${escapeHtml(p?.name ?? '')}" maxlength="200" autocomplete="off"></label>` +
    field('customerCode', 'Müşteri ürün kodu', p?.customerCode ?? '', ' maxlength="40"') +
    field('material', 'Hammadde', p?.material ?? '', ' maxlength="80" placeholder="ör. HM614.YU38.00XYU28.00"') +
    field('altMaterial', 'Alternatif hammadde', p?.altMaterial ?? '', ' maxlength="80"') +
    field('lengthMm', 'Tam boy (mm, teknik resimden)', v(p?.lengthMm), ' inputmode="decimal"') +
    field('netG', 'Net ağırlık (gram)', g(p?.netKg), ' inputmode="decimal"') +
    field('grossG', 'Brüt ağırlık (gram)', g(p?.grossKg), ' inputmode="decimal"') +
    field('plannedSec', 'Planlanan çevrim (sn)', v(p?.plannedSec), ' inputmode="decimal"') +
    '</div><p class="hint" data-role="dara"></p>' +
    `<label class="fld"><span>Not</span><input name="note" value="${escapeHtml(p?.note ?? '')}" maxlength="500" autocomplete="off"></label>` +
    (p ? `<p class="hint">Kaynak: ${escapeHtml(SOURCE[p.source] ?? p.source)} · son güncelleme ${escapeHtml(dateTimeText(p.updatedAt))}${p.updatedBy ? ` · ${escapeHtml(p.updatedBy)}` : ''}</p>` : '') +
    (p ? `<h4 class="sub">Bu ürünü üreten programlar</h4>${p.programs.length === 0
      ? '<p class="empty">Hiçbir program bu ürüne eşlenmemiş (Program eşleme sekmesinden bağlanır).</p>'
      : `<p>${p.programs.map((x) => `<span class="chip chip-none mono">${escapeHtml(x.name)}</span>`).join(' ')}</p>`}` : '') +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">${isNew ? 'Ürünü ekle' : 'Kaydet'}</button></div></form>`;

  const form = m.body.querySelector('form');
  const dara = () => {
    const n = parseInput(form.netG.value);
    const b = parseInput(form.grossG.value);
    m.body.querySelector('[data-role="dara"]').textContent = typeof n === 'number' && typeof b === 'number'
      ? (b >= n ? `Dara (talaş) = brüt − net = ${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(b - n)} g` : 'Net ağırlık brüt ağırlıktan büyük olamaz.')
      : '';
  };
  form.addEventListener('input', dara);
  dara();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    const body = {
      name: form.elements.name.value, customerCode: form.customerCode.value, material: form.material.value, altMaterial: form.altMaterial.value,
      lengthMm: parseInput(form.lengthMm.value), netKg: gramToKg(parseInput(form.netG.value)), grossKg: gramToKg(parseInput(form.grossG.value)),
      plannedSec: parseInput(form.plannedSec.value), note: form.note.value,
    };
    try {
      if (isNew) await post('/api/planning/products', { stockCode: form.stockCode.value.trim(), ...body });
      else await put(`/api/planning/products/${encodeURIComponent(code)}`, body);
      m.close();
      onSaved();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  form.querySelector(isNew ? '[name="stockCode"]' : '[name="name"]').focus();
}
