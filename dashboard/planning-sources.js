/**
 * Planlama > KAYNAK KLASORU (yalniz yonetici): Mikro'nun (ve GKK / ilk onay formlarinin) Excel dosyalari sabit bir klasore konur; "Kaynak dosyadan yenile"
 * klasoru okur, DEGISEN dosyalari bulur ve uygulamayi gunceller: yeni siparis satiri, degisen kalan miktar, yeni/degisen urun karti, yeni GKK kaydi.
 * Her seferinde dosya yuklemek gerekmez. Hesaplar sunucuda (backend/planning/sources.js); burasi yalniz gosterir.
 *
 * Ekrandaki baslik satiri (showSourceStatus) hangi dosyanin degistigini yenilemeden soyler; yenileme sonucu "ne degisti" listeleriyle gosterilir.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, openModal, chip, dateTimeText, fmtNum } from './planning-common.js';

const nf = new Intl.NumberFormat('tr-TR');
const n = (v) => nf.format(v ?? 0);
const kb = (bytes) => (bytes < 1024 ? `${n(bytes)} bayt` : `${n(Math.round(bytes / 1024))} KB`);

/** Dosya durumu rozetleri: ikon + etiket (renk tek basina anlam tasimaz). */
const STATE = Object.freeze({
  yeni: ['info', '●', 'yeni'], degisti: ['info', '●', 'değişmiş olabilir'], ayni: ['none', '✓', 'güncel'],
  islendi: ['ok', '✓', 'işlendi'], degismedi: ['none', '—', 'değişmedi'], atlandi: ['info', 'ℹ', 'tanınmadı, atlandı'], okunamadi: ['bad', '▲', 'okunamadı'],
});
const stateChip = (s) => chip(...(STATE[s] ?? ['none', '?', s]));

/** Yolun son klasor adi (tam yol cok uzun ve teknik gorunuyor; tamami title'da kalir). */
const shortPath = (p) => { const parts = String(p).split(/[\\/]/).filter(Boolean); return parts.length ? `…\\${parts[parts.length - 1]}` : p; };

/** Basliktaki durum satiri (kisa) ve yenile dugmesinin etiketi. Tam yol/zaman title'a gider. */
function statusText(st) {
  if (!st.dir) return { short: '"Kaynak klasörü…" ile bir klasör belirleyin.', full: '' };
  if (!st.exists) return { short: `Kaynak klasörü bulunamadı: ${shortPath(st.dir)}`, full: st.dir };
  const last = st.last ? `son yenileme: ${dateTimeText(st.last.at)}${st.last.by ? ` (${st.last.by})` : ''}` : '';
  const parts = [shortPath(st.dir), `${n(st.files.length)} dosya`];
  parts.push(st.files.length === 0 ? 'Mikro dosyasını buraya koyun' : st.pending > 0 ? `${n(st.pending)} değişiklik var` : 'hepsi güncel');
  return { short: parts.join(' · '), full: [st.dir, last].filter(Boolean).join(' · ') };
}

/**
 * Basliktaki durum satirini ve dugme etiketini gunceller. @param {HTMLElement} host planlama kabugu @returns {Promise<object|null>}
 */
export async function showSourceStatus(host) {
  const line = host.querySelector('[data-role="source-status"]');
  const btn = host.querySelector('[data-act="refresh"]');
  if (!line) return null;
  try {
    const st = await api('/api/planning/sources');
    const txt = statusText(st);
    line.textContent = txt.short;
    if (txt.full) line.title = txt.full; else line.removeAttribute('title');
    line.classList.toggle('is-attn', st.pending > 0);
    if (btn) btn.textContent = st.pending > 0 ? `Kaynak dosyadan yenile (${st.pending} değişiklik)` : 'Kaynak dosyadan yenile';
    return st;
  } catch (err) {
    line.textContent = `Kaynak klasörü durumu alınamadı: ${err.message}`;
    return null;
  }
}

/* ---------------------------------------------------------------- sonuc */

/** En fazla 40 kayit gelir (sunucu keser); toplam daha buyukse "... ve N daha" yazilir. */
function listBlock(title, items, total, fmt) {
  if (!total) return '';
  const more = total - items.length;
  return `<h4 class="sub">${escapeHtml(title)} (${n(total)})</h4><ul class="pl-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}` +
    `${more > 0 ? `<li class="hint">… ve ${n(more)} kayıt daha</li>` : ''}</ul>`;
}

const lineText = (x) => `<span class="mono">${escapeHtml(x.docNo)}</span> · ${escapeHtml(x.stockCode)} · ${fmtNum(x.qty)} adet${x.remaining == null ? '' : ` · kalan ${fmtNum(x.remaining)}`}`;
const productText = (x) => `<b>${escapeHtml(x.stockCode)}</b>${x.fields?.length ? ` — ${escapeHtml(x.fields.join(', '))}` : ''}`;

function refreshResultHtml(r) {
  const t = r.totals;
  const c = r.changes;
  const changed = t.lines.added + t.lines.updated + t.products.added + t.products.updated + t.gkk.added + t.gkk.updated + t.approvals.added + t.approvals.updated
    + t.stock.added + t.stock.updated + t.stock.removed;
  const checked = r.files.length;
  let head;
  if (checked === 0) head = `<div class="notice notice-sim"><b>Klasörde Excel/CSV dosyası yok.</b> Mikro dosyasını şu klasöre koyun ya da kopyalayın: <span class="mono">${escapeHtml(r.dir)}</span></div>`;
  else if (r.processed === 0 && r.failed === 0) head = `<div class="notice"><b>Güncel:</b> ${n(checked)} dosya kontrol edildi, değişiklik yok.</div>`;
  else if (changed === 0 && r.failed === 0) head = `<div class="notice"><b>${n(r.processed)} dosya işlendi</b>, ama uygulamadaki kayıtlarda değişiklik çıkmadı.</div>`;
  else head = `<div class="notice"><b>${n(r.processed)} dosya işlendi.</b> ${[
    t.lines.added + t.lines.updated > 0 ? `Siparişler: <b>${n(t.lines.added)}</b> yeni satır, <b>${n(t.lines.updated)}</b> güncellendi.` : '',
    t.products.added + t.products.updated > 0 ? `Ürün kartları: <b>${n(t.products.added)}</b> yeni, <b>${n(t.products.updated)}</b> güncellendi.` : '',
    t.gkk.added + t.gkk.updated > 0 ? `GKK rapor no: <b>${n(t.gkk.added)}</b> yeni, <b>${n(t.gkk.updated)}</b> güncellendi.` : '',
    t.approvals.added + t.approvals.updated > 0 ? `İlk onay: <b>${n(t.approvals.added)}</b> yeni, <b>${n(t.approvals.updated)}</b> güncellendi.` : '',
    t.stock.added + t.stock.updated + t.stock.removed > 0 ? `Hammadde depo stoğu: <b>${n(t.stock.added + t.stock.updated)}</b> kod güncellendi${t.stock.removed > 0 ? `, <b>${n(t.stock.removed)}</b> kod kalktı` : ''}.` : '',
  ].filter(Boolean).join(' ')}</div>`;

  const files = checked === 0 ? '' :
    '<h4 class="sub">Dosyalar</h4><table class="tbl tbl-pl"><thead><tr><th>Dosya</th><th>Durum</th><th>Ayrıntı</th></tr></thead><tbody>' +
    r.files.map((f) => {
      const sheets = f.parts.map((p) => `${p.sheet ? `${escapeHtml(p.sheet)}: ` : ''}${n(p.added)} yeni, ${n(p.updated)} güncellendi`).join(' · ');
      const skipped = f.skippedSheets?.length ? ` · atlanan sayfa: ${escapeHtml(f.skippedSheets.map((s) => s.name).join(', '))}` : '';
      return `<tr><td>${escapeHtml(f.name)}</td><td>${stateChip(f.state)}</td><td>${f.error ? `<span class="hint">${escapeHtml(f.error)}</span>` : `${sheets}${skipped}`}</td></tr>`;
    }).join('') + '</tbody></table>';

  const protectedBlock = t.products.protected > 0
    ? `<h4 class="sub">Elle düzenlenmiş kartlarda Mikro farkı — dokunulmadı (${n(t.products.protected)})</h4>` +
      `<p class="hint">Bu kartlar elle düzenlendiği için Mikro'daki değişiklik uygulanmadı. Gerekirse ürün kartından kendiniz güncelleyin.</p><ul class="pl-list">${c.products.protected.map((x) => `<li>${productText(x)}</li>`).join('')}</ul>`
    : '';
  const warnings = r.files.flatMap((f) => f.parts.flatMap((p) => p.warnings.map((w) => `${f.name}: ${w}`))).slice(0, 10);
  const warnBlock = warnings.length > 0
    ? `<h4 class="sub">Uyarılar</h4><ul class="checks">${warnings.map((w) => `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(w)}</div></li>`).join('')}</ul>`
    : '';
  return (
    head + files +
    listBlock('Yeni sipariş satırları', c.lines.added, t.lines.added, lineText) +
    listBlock('Güncellenen sipariş satırları (kalan miktar, termin ...)', c.lines.updated, t.lines.updated, lineText) +
    listBlock('Yeni ürün kartları', c.products.added, t.products.added, productText) +
    listBlock('Güncellenen ürün kartları (Mikro\'da değişen alanlar)', c.products.updated, t.products.updated, productText) +
    protectedBlock +
    listBlock('Yeni GKK rapor numaraları', c.gkk.added, t.gkk.added, (x) => `<span class="mono">${escapeHtml(x.reportNo)}</span> · ${escapeHtml(x.material ?? '')}`) +
    listBlock('Güncellenen GKK kayıtları', c.gkk.updated, t.gkk.updated, (x) => `<span class="mono">${escapeHtml(x.reportNo)}</span> · ${escapeHtml(x.material ?? '')}`) +
    listBlock('Yeni ilk onay kayıtları', c.approvals.added, t.approvals.added, (x) => `<span class="mono">${escapeHtml(x.code)}</span>${x.stockCode ? ` · ${escapeHtml(x.stockCode)}` : ''}`) +
    warnBlock
  );
}

/**
 * Klasoru okur, degisenleri uygular ve sonucu bir pencerede gosterir.
 * @param {{onDone?: () => void, force?: boolean}} [opts] onDone: pencere acildiktan ve veri degistikten sonra listeler tazelensin
 */
export async function runRefresh({ onDone = () => {}, force = false } = {}) {
  const m = openModal({ title: force ? 'Kaynak dosyalar zorla yeniden işleniyor' : 'Kaynak dosyadan yenileme', wide: true });
  m.body.innerHTML = '<p class="hint">Kaynak klasörü okunuyor…</p>';
  try {
    const r = await post('/api/planning/sources/refresh', { force });
    m.body.innerHTML =
      refreshResultHtml(r) +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="force">Dosyaları zorla yeniden işle</button></div>' +
      '<p class="hint">Zorla yeniden işleme, değişmemiş dosyaları da baştan okur; kayıtlar zaten güncelse hiçbir şey değişmez. Mikro\'dan kalkan sipariş satırları uygulamada KALIR (gizlenmez).</p>';
    m.body.querySelector('[data-act="force"]').addEventListener('click', () => { m.close(); runRefresh({ onDone, force: true }); });
    onDone();
  } catch (e) {
    m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p>` +
      (e.code === 'no-dir' ? '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="open-dir">Kaynak klasörü…</button></div>' : '');
    m.body.querySelector('[data-act="open-dir"]')?.addEventListener('click', () => { m.close(); openSourcesDialog({ onDone }); });
  }
}

/* ---------------------------------------------------------------- klasor ayari */

/** Klasor yolunu gosterir/ayarlar ve dosyalarin durumunu listeler. */
export function openSourcesDialog({ onDone = () => {} } = {}) {
  const m = openModal({ title: 'Kaynak klasörü', wide: true });
  const $ = (r) => m.body.querySelector(`[data-role="${r}"]`);

  async function draw(message = '') {
    let st;
    try { st = await api('/api/planning/sources'); } catch (e) { m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p>`; return; }
    m.body.innerHTML =
      '<p class="hint">Mikro\'nun otomatik güncellediği Excel dosyasını (ve isterseniz GKK / ilk onay formlarını) <b>bu klasöre</b> koyun ya da Mikro\'nun dosyayı buraya yazmasını sağlayın. ' +
      '<b>Kaynak dosyadan yenile</b> klasördeki değişen dosyaları bulup uygulamayı günceller; dosya türü içerikten tanınır, tanınmayanlar atlanır. ' +
      'Yalnız <b>.xlsx</b> ve <b>.csv</b> okunur; <span class="mono">~$</span> ile başlayan Excel kilit dosyaları yok sayılır.</p>' +
      '<p class="hint"><b>Önemli:</b> sunucu bir Windows görevi olarak çalışır; ağ paylaşımı (<span class="mono">\\\\sunucu\\paylasim</span>) ona kapalı olabilir. Mümkünse <b>yerel bir klasör</b> kullanın ve dosyayı oraya kopyalayın.</p>' +
      `${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}` +
      '<div class="pl-bar"><label class="fld-inline" style="flex:1">Klasör yolu ' +
      `<input type="text" data-role="dir" value="${escapeHtml(st.dir ?? '')}" spellcheck="false" autocomplete="off" style="width:100%" placeholder="${escapeHtml(st.defaultDir ?? 'C:\\CNC-Telemetri\\data\\kaynak')}"></label>` +
      '<button type="button" class="icon-btn btn-primary" data-act="save">Kaydet</button>' +
      `${st.isDefault ? '' : '<button type="button" class="icon-btn" data-act="default">Varsayılana dön</button>'}</div>` +
      `<p class="hint">Varsayılan klasör: <span class="mono">${escapeHtml(st.defaultDir ?? '—')}</span>${st.isDefault ? ' (şu an bu kullanılıyor)' : ''}</p>` +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      (!st.exists ? '<p class="notice notice-sim">Klasör bulunamadı.</p>'
        : st.files.length === 0 ? '<p class="empty">Klasörde henüz Excel/CSV dosyası yok.</p>'
        : '<table class="tbl tbl-pl"><thead><tr><th>Dosya</th><th class="num">Boyut</th><th>Değiştirilme</th><th>Son işlenme</th><th>Durum</th></tr></thead><tbody>' +
          st.files.map((f) => `<tr><td>${escapeHtml(f.name)}</td><td class="num">${kb(f.size)}</td><td>${escapeHtml(dateTimeText(f.mtimeMs))}</td>` +
            `<td>${f.importedAt ? escapeHtml(dateTimeText(f.importedAt)) : '<span class="is-null">—</span>'}</td><td>${stateChip(f.state)}</td></tr>`).join('') + '</tbody></table>') +
      '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="refresh-now"' + (st.exists ? '' : ' disabled') + '>Kaynak dosyadan yenile</button></div>';

    const err = $('err');
    const save = async (value) => {
      try {
        await put('/api/planning/sources/dir', { dir: value });
        onDone();
        await draw('Klasör kaydedildi.');
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    m.body.querySelector('[data-act="save"]').addEventListener('click', () => save($('dir').value));
    m.body.querySelector('[data-act="default"]')?.addEventListener('click', () => save(''));
    m.body.querySelector('[data-act="refresh-now"]').addEventListener('click', () => { m.close(); runRefresh({ onDone }); });
  }
  draw();
}
