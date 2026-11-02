/**
 * Planlama > Fiyat çalışması: ürün kartı henüz açılmadan önceki ön çalışma.
 *
 * Admin bir teknik resim (PDF) yükler; "usta" (bu ekrana yazabilen rol) PDF'e bakıp HAMMADDE ve SÜRE
 * bilgisini girer. Bu kayıt `products` tablosuyla HİÇ BAĞLANMAZ: ürün kartları Mikro'da tutuluyor,
 * yönetici bu dolu kaydı görüp Mikro'da kendisi açar.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, fmtDec, dateTimeText, chip, openModal, canWrite, isAdminRole } from './planning-common.js';

const del = (path) => api(path, { method: 'DELETE' });
const put = (path, obj) => api(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const MAX_BYTES = 20 * 1024 * 1024;

const STATUS_CHIP = Object.freeze({
  bekliyor: ['warn', '◔', 'bekliyor'],
  dolduruldu: ['ok', '✓', 'dolduruldu'],
});

/** @param {HTMLElement} host */
export function renderPriceStudies(host) {
  const admin = isAdminRole();
  const yazabilir = canWrite('fiyat');
  const st = { status: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar">' +
    '<label class="fld-inline">Durum <select data-role="status"><option value="">Tümü</option><option value="bekliyor">Bekliyor</option><option value="dolduruldu">Dolduruldu</option></select></label>' +
    (admin ? '<button type="button" class="icon-btn btn-primary" data-act="new">Teknik resim yükle…</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (admin ? 'Henüz kayıt yok. "Teknik resim yükle…" ile bir çalışma açın.' : 'Henüz kayıt yok.')
      : `${fmtNum(st.total)} kayıt`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Teknik resim</th><th>Durum</th><th>Hammadde</th><th class="num">Süre (sn)</th><th>Yüklendi</th><th></th></tr></thead><tbody>' +
      st.items.map((p) =>
        `<tr data-id="${p.id}"><td class="trunc" title="${escapeHtml(p.title ?? p.drawingName)}"><b>${escapeHtml(p.title || p.drawingName)}</b></td>` +
        `<td>${chip(...STATUS_CHIP[p.status])}</td><td>${cellText(p.material)}</td><td class="num">${p.plannedSec == null ? cellText(null) : fmtDec(p.plannedSec, 1)}</td>` +
        `<td>${escapeHtml(dateTimeText(p.createdAt))}${p.createdBy ? ` · ${escapeHtml(p.createdBy)}` : ''}</td>` +
        `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="open" data-id="${p.id}">${yazabilir && p.status === 'bekliyor' ? 'Doldur…' : 'Aç'}</button>` +
        (admin ? ` <button type="button" class="icon-btn icon-btn-sm" data-act="del" data-id="${p.id}">Sil</button>` : '') + '</td></tr>').join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    try {
      const r = await api(`/api/planning/price-studies?${new URLSearchParams({ status: st.status })}`);
      if (seq !== st.seq) return;
      st.items = r.items;
      st.total = r.total;
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Alınamadı: ${err.message}`;
    }
  }

  host.onchange = (ev) => { if (ev.target.dataset?.role === 'status') { st.status = ev.target.value; load(); } };
  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'new') return openUploadDialog(() => load());
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'open') return openDetailDialog(id, () => load());
    if (btn.dataset.act === 'del') {
      if (!window.confirm('Bu fiyat çalışması silinsin mi?')) return;
      del(`/api/planning/price-studies/${id}`).then(load).catch((err) => { $('count').textContent = `Silinemedi: ${err.message}`; });
    }
  };
  load();
}

/** Admin: yeni çalışma (başlık + PDF). */
function openUploadDialog(onDone) {
  const m = openModal({ title: 'Teknik resim yükle (fiyat çalışması)' });
  m.body.innerHTML =
    '<form autocomplete="off" data-role="form">' +
    '<label class="fld"><span>Başlık / not (isteğe bağlı)</span><input name="title" maxlength="200" placeholder="ör. müşteri adı ya da ürün tanımı"></label>' +
    '<label class="fld"><span>Teknik resim (PDF)</span><input type="file" name="file" accept="application/pdf,.pdf" required></label>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">Yükle</button></div></form>';
  const form = m.body.querySelector('form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    err.hidden = true;
    const f = form.elements.file.files[0];
    if (!f) return;
    if (f.size > MAX_BYTES) { err.textContent = `Dosya çok büyük (en fazla ${Math.round(MAX_BYTES / 1048576)} MB).`; err.hidden = false; return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await api(`/api/planning/price-studies?${new URLSearchParams({ title: form.elements.title.value, name: f.name })}`, {
        method: 'POST', headers: { 'content-type': 'application/pdf' }, body: f,
      });
      m.close();
      onDone();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/** Ayrıntı: PDF görüntüleyici + (yazabilen rol) hammadde/süre/not formu. */
async function openDetailDialog(id, onDone) {
  const m = openModal({ title: 'Fiyat çalışması', wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let p;
  try {
    p = await api(`/api/planning/price-studies/${id}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const yazabilir = canWrite('fiyat') && p.status === 'bekliyor';
  const url = `/api/planning/price-studies/${id}/drawing.pdf`;
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><a class="icon-btn" href="' + url + '" target="_blank" rel="noopener">Yeni sekmede aç</a></div>' +
    `<iframe class="pl-f-pdf" title="Teknik resim (PDF)" src="${url}#view=FitH"></iframe>` +
    (p.status === 'dolduruldu'
      ? `<p class="hint">Dolduruldu: ${escapeHtml(p.createdBy ?? '')} yükledi, ${escapeHtml(p.filledBy ?? '')} doldurdu · hammadde <b>${escapeHtml(p.material ?? '—')}</b> · süre <b>${p.plannedSec ?? '—'} sn</b>${p.note ? ` · ${escapeHtml(p.note)}` : ''}</p>`
      : yazabilir
        ? '<form autocomplete="off" data-role="fill"><div class="fld-grid">' +
          '<label class="fld"><span>Hammadde</span><input name="material" maxlength="80" required placeholder="ör. HM614.YU23.00"></label>' +
          '<label class="fld"><span>Süre (sn)</span><input name="plannedSec" inputmode="decimal" required></label></div>' +
          '<label class="fld"><span>Not</span><input name="note" maxlength="500"></label>' +
          '<p class="notice notice-sim" data-role="err" hidden></p>' +
          '<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>'
        : '<p class="hint">Henüz doldurulmadı.</p>');
  m.body.querySelector('[data-role="fill"]')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const err = m.body.querySelector('[data-role="err"]');
    err.hidden = true;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await put(`/api/planning/price-studies/${id}/fill`, {
        material: form.elements.material.value, plannedSec: Number(form.elements.plannedSec.value.replace(',', '.')), note: form.elements.note.value,
      });
      m.close();
      onDone();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}
