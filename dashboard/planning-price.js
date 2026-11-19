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
    (admin ? '<p class="hint">Birden çok PDF\'i buraya sürükleyip bırakabilir ya da "Teknik resim yükle…" ile seçebilirsiniz.</p>' : '') +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  // Ekranin HER YERINE surukle-birak (2026-11-18, kullanici istegi: "yerinde dosyalari surukleyip birakma"):
  // ayri bir pencere acmaya gerek yok, PDF'leri dogrudan listenin uzerine birakinca toplu yukleme penceresi
  // bu dosyalarla acilir. Yalniz yonetici (admin disinda kimse yukleyemez).
  if (admin) {
    let dragDepth = 0;
    host.addEventListener('dragover', (ev) => { if ([...ev.dataTransfer.items].some((i) => i.kind === 'file')) ev.preventDefault(); });
    host.addEventListener('dragenter', (ev) => { if ([...ev.dataTransfer.items].some((i) => i.kind === 'file')) { ev.preventDefault(); dragDepth += 1; host.classList.add('pl-drop-over'); } });
    host.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) host.classList.remove('pl-drop-over'); });
    host.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dragDepth = 0;
      host.classList.remove('pl-drop-over');
      const files = [...ev.dataTransfer.files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      if (files.length === 0) { window.alert('Yalnız PDF dosyaları kabul edilir.'); return; }
      openUploadDialog(() => load(), files);
    });
  }

  function draw() {
    $('count').textContent = st.total === 0
      ? (admin ? 'Henüz kayıt yok. "Teknik resim yükle…" ile bir çalışma açın.' : 'Henüz kayıt yok.')
      : `${fmtNum(st.total)} kayıt`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Teknik resim</th><th>Durum</th><th>Hammadde</th><th class="num">Süre (sn)</th><th class="ctr">Not</th><th>Yüklendi</th><th></th></tr></thead><tbody>' +
      st.items.map((p) =>
        `<tr data-id="${p.id}"><td class="trunc" title="${escapeHtml(p.title ?? p.drawingName)}"><b>${escapeHtml(p.title || p.drawingName)}</b></td>` +
        `<td>${chip(...STATUS_CHIP[p.status])}</td><td>${cellText(p.material)}</td><td class="num">${p.plannedSec == null ? cellText(null) : fmtDec(p.plannedSec, 1)}</td>` +
        `<td class="ctr"${p.note ? ` title="${escapeHtml(p.note)}"` : ''}>${p.note ? '✓' : '<span class="is-null">—</span>'}</td>` +
        `<td>${escapeHtml(dateTimeText(p.createdAt))}${p.createdBy ? ` · ${escapeHtml(p.createdBy)}` : ''}</td>` +
        `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="open" data-id="${p.id}">${yazabilir ? (p.status === 'bekliyor' ? 'Doldur…' : 'Düzenle…') : 'Aç'}</button>` +
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

/** Dosya adından "makul" bir başlık türetir (uzantısız, alt çizgi/tire boşluğa çevrilir) — yalnız ÖNERİ, admin değiştirebilir. */
const titleFromName = (name) => name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
const sizeKb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Admin: toplu teknik resim yükleme (2026-11-18, kullanıcı isteği: "tek tek yükleyince çok uzun sürüyor").
 * Birden çok PDF seçilir (sürükle-bırak ya da dosya seçici, her ikisi de birden çok dosya kabul eder); her biri
 * KENDİ başlığıyla (öneri: dosya adından, admin değiştirebilir) LİSTEYE eklenir; "Hepsini yükle" sırayla gönderir.
 * Bir dosyanın başarısız olması diğerlerini DÜŞÜRMEZ (her satır bağımsız; başarısız olan "Yeniden dene" ile tek
 * başına tekrar denenir). `initialFiles` verilirse (ana ekrana sürükle-bırakılan dosyalar) liste onunla açılır.
 * @param {() => void} onDone @param {File[]} [initialFiles]
 */
function openUploadDialog(onDone, initialFiles = []) {
  const m = openModal({ title: 'Teknik resim yükle (fiyat çalışması)', wide: true });
  // st.rows: {file, title, status: 'bekliyor'|'yukleniyor'|'tamam'|'hata', error?: string}
  const st = { rows: [], busy: false };
  const addFiles = (files) => {
    for (const f of files) {
      if (f.size > MAX_BYTES) { st.rows.push({ file: f, title: titleFromName(f.name), status: 'hata', error: `Çok büyük (en fazla ${Math.round(MAX_BYTES / 1048576)} MB).` }); continue; }
      // ayni ad+boyut zaten listedeyse (ayni dosya iki kez suruklendi/secildi) tekrar eklenmez.
      if (st.rows.some((r) => r.file.name === f.name && r.file.size === f.size)) continue;
      st.rows.push({ file: f, title: titleFromName(f.name), status: 'bekliyor' });
    }
    draw();
  };

  m.body.innerHTML =
    '<p class="hint">PDF\'leri buraya sürükleyip bırakın ya da "Dosya seç…" ile birden çok PDF birden seçin; her biri kendi satırında, başlığını düzenleyip "Hepsini yükle" ile tek seferde gönderin.</p>' +
    '<div class="pl-drop" data-role="drop" tabindex="0" role="button" aria-label="PDF seçmek için tıklayın ya da buraya sürükleyin">' +
    '<span>PDF\'leri buraya sürükleyin</span><button type="button" class="icon-btn" data-act="pick">Dosya seç…</button>' +
    '<input type="file" accept="application/pdf,.pdf" multiple hidden data-role="file"></div>' +
    '<div data-role="rows"></div>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
    '<button type="button" class="icon-btn btn-primary" data-act="upload-all">Hepsini yükle</button></div>';
  const $ = (r) => m.body.querySelector(`[data-role="${r}"]`);
  const drop = $('drop');
  const fileInput = $('file');

  const statusText = (s) => ({ bekliyor: '◔ bekliyor', yukleniyor: '… yükleniyor', tamam: '✓ yüklendi', hata: '✕ hata' }[s.status]);
  function draw() {
    const rowsEl = $('rows');
    rowsEl.innerHTML = st.rows.length === 0 ? '' : '<table class="tbl tbl-pl"><thead><tr><th>Dosya</th><th>Başlık</th><th>Durum</th><th></th></tr></thead><tbody>' +
      st.rows.map((r, i) => `<tr data-row="${i}">` +
        `<td class="trunc" title="${escapeHtml(r.file.name)}">${escapeHtml(r.file.name)} <span class="hint" style="margin:0">(${sizeKb(r.file.size)})</span></td>` +
        `<td><input data-role="title" maxlength="200" value="${escapeHtml(r.title)}"${r.status === 'yukleniyor' || r.status === 'tamam' ? ' disabled' : ''}></td>` +
        `<td class="nowrap">${escapeHtml(statusText(r))}${r.status === 'hata' && r.error ? ` <span class="hint" style="margin:0">${escapeHtml(r.error)}</span>` : ''}</td>` +
        `<td class="nowrap">${r.status === 'hata' ? '<button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button> ' : ''}` +
        `${r.status !== 'yukleniyor' ? '<button type="button" class="icon-btn icon-btn-sm" data-act="remove">Kaldır</button>' : ''}</td></tr>`).join('') +
      '</tbody></table>';
    const done = st.rows.filter((r) => r.status === 'tamam').length;
    const failed = st.rows.filter((r) => r.status === 'hata').length;
    const uploadBtn = m.body.querySelector('[data-act="upload-all"]');
    uploadBtn.disabled = st.busy || st.rows.every((r) => r.status === 'tamam');
    uploadBtn.textContent = st.busy ? 'Yükleniyor…' : `Hepsini yükle (${st.rows.filter((r) => r.status === 'bekliyor' || r.status === 'hata').length})`;
    const err = $('err');
    if (!st.busy && st.rows.length > 0 && done + failed === st.rows.length) {
      err.hidden = failed === 0;
      if (failed > 0) { err.textContent = `${failed} dosya yüklenemedi; "Yeniden dene" ile tek tek tekrar deneyebilirsiniz.`; }
    } else err.hidden = true;
  }

  async function uploadRow(i) {
    const r = st.rows[i];
    r.status = 'yukleniyor';
    r.error = null;
    draw();
    try {
      await api(`/api/planning/price-studies?${new URLSearchParams({ title: r.title, name: r.file.name })}`, {
        method: 'POST', headers: { 'content-type': 'application/pdf' }, body: r.file,
      });
      r.status = 'tamam';
    } catch (e) {
      r.status = 'hata';
      r.error = e.message;
    }
    draw();
  }

  async function uploadAll() {
    st.busy = true;
    draw();
    for (let i = 0; i < st.rows.length; i += 1) {
      if (st.rows[i].status === 'bekliyor' || st.rows[i].status === 'hata') await uploadRow(i); // sırayla; biri hata verirse diğerleri devam eder
    }
    st.busy = false;
    draw();
    onDone(); // kısmen başarılı olsa bile listeyi tazele (başarılı olanlar hemen görünsün)
  }

  let dragDepth = 0;
  drop.addEventListener('dragover', (ev) => ev.preventDefault());
  drop.addEventListener('dragenter', (ev) => { ev.preventDefault(); dragDepth += 1; drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) drop.classList.remove('is-over'); });
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    drop.classList.remove('is-over');
    addFiles([...ev.dataTransfer.files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
  });
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-role="drop"]')) fileInput.click();
    else if (ev.target.closest('[data-act="close"]')) m.close();
    else if (ev.target.closest('[data-act="upload-all"]')) uploadAll();
    else if (ev.target.closest('[data-act="retry"]')) uploadRow(Number(ev.target.closest('[data-row]').dataset.row));
    else if (ev.target.closest('[data-act="remove"]')) { st.rows.splice(Number(ev.target.closest('[data-row]').dataset.row), 1); draw(); }
  });
  m.body.addEventListener('input', (ev) => {
    if (ev.target.dataset?.role !== 'title') return;
    st.rows[Number(ev.target.closest('[data-row]').dataset.row)].title = ev.target.value;
  });
  drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); } });

  addFiles(initialFiles);
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
  // Kaydedildikten SONRA da duzenlenebilir (2026-11-18, kullanici istegi: "kaydettikten sonra duzenlenebilsin").
  // Eskiden `p.status === 'bekliyor'` sartiyla formu bir KERE gosterip sonra salt metne donuyordu; artik yazma
  // yetkisi oldugu surece HER ZAMAN ayni form (doldurulmussa degerler ONCEDEN DOLU gelir). Backend zaten `fill()`'i
  // tekrar cagirmayi engellemiyordu (yalniz `filled_at/filled_by` en son duzenleyene gore guncellenir).
  const yazabilir = canWrite('fiyat');
  const url = `/api/planning/price-studies/${id}/drawing.pdf`;
  const decInput = (v) => (v == null ? '' : String(v).replace('.', ','));
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><a class="icon-btn" href="' + url + '" target="_blank" rel="noopener">Yeni sekmede aç</a></div>' +
    `<iframe class="pl-f-pdf" title="Teknik resim (PDF)" src="${url}#view=FitH"></iframe>` +
    (p.status === 'dolduruldu'
      ? `<p class="hint">${escapeHtml(p.createdBy ?? '')} yükledi, ${escapeHtml(p.filledBy ?? '')} doldurdu (${escapeHtml(dateTimeText(p.filledAt))}).</p>`
      : '') +
    (yazabilir
      ? '<form autocomplete="off" data-role="fill"><div class="fld-grid">' +
        `<label class="fld"><span>Hammadde</span><input name="material" maxlength="80" required placeholder="ör. HM614.YU23.00" value="${escapeHtml(p.material ?? '')}"></label>` +
        `<label class="fld"><span>Süre (sn)</span><input name="plannedSec" inputmode="decimal" required value="${escapeHtml(decInput(p.plannedSec))}"></label></div>` +
        `<label class="fld"><span>Not</span><input name="note" maxlength="500" value="${escapeHtml(p.note ?? '')}"></label>` +
        '<p class="notice notice-sim" data-role="err" hidden></p>' +
        `<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">${p.status === 'dolduruldu' ? 'Güncelle' : 'Kaydet'}</button></div></form>`
      : (p.status === 'bekliyor' ? '<p class="hint">Henüz doldurulmadı.</p>' : ''));
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
