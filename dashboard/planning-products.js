/**
 * Planlama > Urunler: urun karti listesi, arama, duzenleme ve yeni urun.
 * Agirliklar kg saklanir, burada GRAM girilir/gosterilir. Elle duzenlenen kart, Excel iceri almasiyla ezilmez.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, cellText, fmtNum, gramText, dateTimeText, debounce, openModal, parseInput, gramToKg, chip, sizeText, isAdminRole, truncCell } from './planning-common.js';
import { openMeasurePlanDialog } from './planning-measure.js';

const PAGE = 100;
const SOURCE = Object.freeze({ elle: 'elle', 'csv-isemri': 'iş emri CSV', 'csv-siparis': 'sipariş CSV' });

/** Klasörden eşlenen dosyanın geldiği klasörün adı (etiketler müşteri klasörlerinde durur); kök dizindeyse boş. */
const folderOf = (rel) => { const parts = String(rel ?? '').split(/[\\/]/); return parts.length > 1 ? parts[parts.length - 2] : ''; };

/** Kalıcı ölçü planının tek satırlık özeti: ürüne göre 3, 5 ... ölçü. */
const planSummary = (plan) => (plan?.length
  ? `${plan.length} ölçü: ${escapeHtml(plan.map((r) => r.label).join(' · '))}. Bu ürünün yeni iş emirleri bu ölçülerle gelir.`
  : 'Kalıcı ölçü planı yok: ölçü satırları her iş emrinde ayrı tanımlanır. Buradan tanımlarsanız bu ürünün yeni iş emirleri hazır gelir.');

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
      ? (st.q ? 'Eşleşen ürün yok.' : 'Henüz ürün kartı yok. Sağ üstteki "Excel içeri al…" ile iş emirleri listesini ya da sipariş dosyasını (.xlsx ya da CSV) yükleyin, ya da "Yeni ürün" ile elle ekleyin.')
      : `${fmtNum(st.total)} ürün${st.items.length < st.total ? ` (ilk ${fmtNum(st.items.length)} gösteriliyor)` : ''}`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Stok kodu</th><th>Ürün adı</th><th>Müşteri kodu</th><th>Hammadde</th>' +
      '<th class="num">Tam boy (mm)</th><th class="num">Net (g)</th><th class="num">Brüt (g)</th><th class="num">Planlanan (sn)</th>' +
      '<th class="num" title="Koli içi adet (standart)">Koli içi</th><th class="num">Ölçü</th><th class="num">Program</th><th class="num" title="Ürün kartına bağlı teknik resim dosyası">Resim</th><th class="num" title="Ürün kartına bağlı kutu etiketi dosyası">Etiket</th><th>Kaynak</th></tr></thead><tbody>' +
      st.items.map((p) =>
        `<tr class="pl-row" data-code="${escapeHtml(p.stockCode)}" tabindex="0">` +
        `<td class="mono"><b>${escapeHtml(p.stockCode)}</b></td><td class="trunc"${truncCell(p.name)}>${cellText(p.name)}</td><td class="mono">${cellText(p.customerCode)}</td>` +
        `<td class="mono trunc"${truncCell(p.material)}>${cellText(p.material)}</td><td class="num">${fmtNum(p.lengthMm, 1)}</td><td class="num">${gramText(p.netKg)}</td>` +
        `<td class="num">${gramText(p.grossKg)}</td><td class="num">${fmtNum(p.plannedSec, 1)}</td>` +
        `<td class="num">${p.boxQty ? fmtNum(p.boxQty) : '<span class="is-null" title="Henüz paketlenmedi: ilk koli kaydedilince öğrenilir">—</span>'}</td>` +
        `<td class="num">${p.measurePlan?.length > 0 ? fmtNum(p.measurePlan.length) : '<span class="is-null" title="Kalıcı ölçü planı tanımlı değil">—</span>'}</td>` +
        `<td class="num">${p.programCount > 0 ? fmtNum(p.programCount) : '<span class="is-null" title="Hiçbir program bu ürüne eşlenmemiş">—</span>'}</td>` +
        `<td class="num">${p.drawingCount > 0 ? fmtNum(p.drawingCount) : '<span class="is-null" title="Ürün kartına bağlı teknik resim yok">—</span>'}</td>` +
        `<td class="num">${p.stickerCount > 0 ? fmtNum(p.stickerCount) : '<span class="is-null" title="Ürün kartına bağlı etiket dosyası yok">—</span>'}</td>` +
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
    (p?.edited ? '<p class="notice">Bu kart elle düzenlendi: Excel/CSV içeri alma bu kartın <b>dolu</b> alanlarını ezmez, yalnızca boş alanları doldurur.</p>' : '') +
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
    field('boxQty', 'Koli içi adet (standart)', v(p?.boxQty), ' inputmode="numeric" placeholder="ilk koliden öğrenilir"') +
    '</div><p class="hint">Koli içi adet: paketleme ilk koliyi kaydedince burası kendiliğinden dolar ve bir sonraki paketlemede öneri olarak gelir; buradan değiştirebilirsiniz.</p><p class="hint" data-role="dara"></p>' +
    `<label class="fld"><span>Not</span><input name="note" value="${escapeHtml(p?.note ?? '')}" maxlength="500" autocomplete="off"></label>` +
    (p ? `<p class="hint">Kaynak: ${escapeHtml(SOURCE[p.source] ?? p.source)} · son güncelleme ${escapeHtml(dateTimeText(p.updatedAt))}${p.updatedBy ? ` · ${escapeHtml(p.updatedBy)}` : ''}</p>` : '') +
    (p ? '<h4 class="sub">Ölçü satırları (ölçü kontrol föyü)</h4>' +
      `<p class="hint" data-role="plan-summary">${planSummary(p.measurePlan)}</p>` +
      '<button type="button" class="icon-btn" data-act="measure-plan">Ölçü satırlarını tanımla / düzenle…</button>' : '') +
    (p ? '<h4 class="sub">Dosyalar: teknik resim ve etiket</h4><div data-role="files"></div>' : '') +
    (p ? `<h4 class="sub">Bu ürünü üreten programlar</h4>${p.programs.length === 0
      ? '<p class="empty">Hiçbir program bu ürüne eşlenmemiş (Program eşleme sekmesinden bağlanır).</p>'
      : `<p>${p.programs.map((x) => `<span class="chip chip-none mono">${escapeHtml(x.name)}</span>`).join(' ')}</p>`}` : '') +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">${isNew ? 'Ürünü ekle' : 'Kaydet'}</button></div></form>`;

  const form = m.body.querySelector('form');
  /** Ürün kartına bağlı dosyalar (klasörden eşlenen ya da elle eklenen); yönetici kaldırabilir. */
  const drawFiles = () => {
    const box = m.body.querySelector('[data-role="files"]');
    if (!box || !p) return;
    const KIND_LABEL = { cizim: 'Teknik resim', etiket: 'Etiket' };
    box.innerHTML = p.files.length === 0
      ? '<p class="empty">Bu ürün kartına bağlı dosya yok. Teknik resimler ve etiketler klasörden eşlenir (Ürün kartları › "Teknik resimleri eşle…" / "Etiketleri eşle…").</p>'
      : `<ul class="pl-list">${p.files.map((f) => `<li>${escapeHtml(KIND_LABEL[f.kind] ?? f.kind)}: <a href="/api/planning/product-files/${f.id}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a> ` +
        `<small class="hint">${f.kind === 'cizim' ? `${f.pages} sayfa · ` : ''}${escapeHtml(sizeText(f.size))} · ${f.source === 'klasor' ? `klasörden${folderOf(f.relPath) ? `: ${escapeHtml(folderOf(f.relPath))}` : ''}` : 'elle'}</small>` +
        `${isAdminRole() ? ` <button type="button" class="icon-btn icon-btn-sm" data-act="pf-del" data-id="${f.id}">Kaldır</button>` : ''}</li>`).join('')}</ul>`;
  };
  drawFiles();
  m.body.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act="pf-del"]');
    if (!b) return;
    const f = p.files.find((x) => x.id === Number(b.dataset.id));
    if (!window.confirm(`${f?.name ?? 'Bu dosya'} ürün kartından kaldırılsın mı? (Bu dosyayı zaten almış iş emirleri etkilenmez.)`)) return;
    try {
      await del(`/api/planning/product-files/${b.dataset.id}`);
      p = await api(`/api/planning/products/${encodeURIComponent(code)}`);
      drawFiles();
      onSaved();
    } catch (e) {
      const err = m.body.querySelector('[data-role="err"]');
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  form.querySelector('[data-act="measure-plan"]')?.addEventListener('click', () => {
    openMeasurePlanDialog({ stockCode: p.stockCode }, async () => {
      try {
        p = await api(`/api/planning/products/${encodeURIComponent(code)}`);
        form.querySelector('[data-role="plan-summary"]').innerHTML = planSummary(p.measurePlan);
      } catch { /* özet yenilenemedi: kayıt yapıldı */ }
      onSaved();
    });
  });
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
      plannedSec: parseInput(form.plannedSec.value), note: form.note.value, boxQty: parseInput(form.boxQty.value),
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
