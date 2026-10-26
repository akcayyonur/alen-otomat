/**
 * Planlama > Ürün kartları > "Teknik resimleri eşle…" ve "Etiketleri eşle…" (yalnız yönetici): iki AYRI klasör, her birinde dosyalar Alen Otomat ürün koduna (SR002.013) göre
 * ürün kartlarına bağlanır. Teknik resim klasörü (.pdf): yeni iş emri ürünün resimlerini kendisi alır, tek tek PDF yüklemek gerekmez. Etiket klasörü (Word .docx / .doc ya da PDF):
 * paketleme ekranı ürünün kutu etiketi dosyasını gösterir. Varsayılan olarak yalnız resmi / etiketi OLMAYAN ürünler eşlenir; "yeni sürümleri de güncelle" klasörden eşlenmiş
 * dosyaları (içerik değiştiyse) yenisiyle değiştirir. Hesaplar sunucuda (backend/planning/doc-folder.js); burası yalnız gösterir.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, openModal } from './planning-common.js';

const nf = new Intl.NumberFormat('tr-TR');
const n = (v) => nf.format(v ?? 0);

const KIND = Object.freeze({
  cizim: {
    url: '/api/planning/drawing-folder', title: 'Teknik resimleri eşle', noun: 'teknik resim', plural: 'teknik resmi',
    intro: 'Teknik resim <b>PDF</b> dosyalarını bu klasöre koyun (alt klasör olabilir). Dosya adında <b>Alen Otomat ürün kodu</b> (<span class="mono">SR002.013 DAIKIN.pdf</span>, ' +
      '<span class="mono">SR002-013.pdf</span>, klasör adı <span class="mono">SR002.013</span>) ya da kartlardaki <b>müşteri ürün kodu</b> olmalı. <b>Eşle</b>, teknik resmi OLMAYAN ürün kartlarına dosyaları bağlar; ' +
      'bundan sonra o ürünün iş emri açılınca resimler kendiliğinden gelir (bekleyen iş emirlerine de bağlanır). Resmi olan ürüne dokunulmaz.',
    placeholder: 'C:\\CNC-Telemetri\\data\\teknik-resim',
  },
  etiket: {
    url: '/api/planning/sticker-folder', title: 'Etiketleri eşle', noun: 'etiket', plural: 'etiketi',
    intro: 'Kutu etiketi dosyalarını (<b>Word .docx / .doc</b> ya da PDF) bu klasöre koyun (alt klasör olabilir). Ürün kodu dosya adında (<span class="mono">SR002.013 etiket.docx</span> ya da müşteri kodu: <span class="mono">601037010525.doc</span>; müşteri klasörlerine ayrılmış olabilir) ' +
      'ya da <b>Word dosyasının içinde</b> yazıyorsa bulunur. <b>Eşle</b>, etiketi OLMAYAN ürün kartlarına dosyaları bağlar; paketleme ekranı seçilen ürünün etiket dosyasını gösterir. Etiketi olan ürüne dokunulmaz.',
    placeholder: 'C:\\CNC-Telemetri\\data\\etiket',
  },
});

/** En fazla 60 kayıt gelir (sunucu keser). */
const list = (title, items, fmt, total = items.length) => (items.length === 0 ? '' :
  `<h4 class="sub">${escapeHtml(title)} (${n(total)})</h4><ul class="pl-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}${total > items.length ? `<li class="hint">… ve ${n(total - items.length)} tane daha</li>` : ''}</ul>`);

/** Eşlemenin yolu: Alen ürün kodu varsayılandır, yalnız diğer yollar belirtilir. */
const VIA_NOTE = Object.freeze({ 'müşteri kodu': 'müşteri koduyla', 'dosya içi': 'dosyanın içindeki koddan' });
const viaNote = (via = []) => { const t = via.filter((v) => VIA_NOTE[v]).map((v) => VIA_NOTE[v]); return t.length ? ` <small>· ${escapeHtml(t.join(', '))}</small>` : ''; };

function resultHtml(r, c) {
  let head;
  if (r.scanned === 0) head = `<div class="notice notice-sim"><b>Klasörde dosya yok.</b> ${c.noun[0].toUpperCase()}${c.noun.slice(1)} dosyalarını şu klasöre koyun: <span class="mono">${escapeHtml(r.dir)}</span></div>`;
  else if (r.products === 0 && r.updated === 0) head = `<div class="notice"><b>Yeni eşleme yok.</b> ${n(r.scanned)} dosya tarandı; ${n(r.alreadyHad)} üründe ${c.noun} zaten var.${r.unchanged ? ` ${n(r.unchanged)} üründe klasördeki dosya değişmemiş.` : ''}</div>`;
  else head = `<div class="notice"><b>${n(r.products)} ürün kartına ${c.noun} bağlandı</b> (${n(r.scanned)} dosya tarandı${r.updated ? `, ${n(r.updated)} ürün yeni sürümle güncellendi` : ''}${r.orders ? `, ${n(r.orders)} bekleyen iş emrine de bağlandı` : ''}).</div>`;
  return head +
    list('Bağlananlar', r.attached, (a) => `<b class="mono">${escapeHtml(a.stockCode)}</b> — ${escapeHtml(a.files.join(', '))}${a.updated ? ' <small>(güncellendi)</small>' : ''}${viaNote(a.via)}${a.orders ? ` <small>· ${n(a.orders)} iş emrine bağlandı</small>` : ''}`, r.products) +
    list('Eşleşmeyen dosyalar', r.unmatched, (u) => `<span class="mono">${escapeHtml(u.name)}</span> — ${escapeHtml(u.reason)}`, r.unmatchedTotal) +
    list('Kabul edilmeyen dosyalar', r.rejected, (u) => `<span class="mono">${escapeHtml(u.name)}</span> — ${escapeHtml(u.error)}`) +
    list(`Hâlâ ${c.plural} olmayan ürünler`, r.missing.sample, (code) => `<span class="mono">${escapeHtml(code)}</span>`, r.missing.total) +
    (r.truncated ? '<p class="notice notice-sim">Klasör çok büyük: ilk 20.000 girdi tarandı.</p>' : '');
}

/**
 * @param {'cizim'|'etiket'} kind
 * @param {{onDone?: () => void}} [opts] onDone: eşleme yapılınca (ürün listesi tazelensin)
 */
export function openFolderDialog(kind, { onDone = () => {} } = {}) {
  const c = KIND[kind];
  const m = openModal({ title: c.title, wide: true });

  async function draw(message = '') {
    let st;
    try { st = await api(c.url); } catch (e) { m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p>`; return; }
    m.body.innerHTML =
      `<p class="hint">${c.intro}</p>` +
      '<p class="hint"><b>Önemli:</b> sunucu bir Windows görevi olarak çalışır; ağ paylaşımı (<span class="mono">\\\\sunucu\\paylasim</span>) ona kapalı olabilir. Mümkünse <b>yerel bir klasör</b> kullanın.</p>' +
      `${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}` +
      '<div class="pl-bar"><label class="fld-inline" style="flex:1">Klasör yolu ' +
      `<input type="text" data-role="dir" value="${escapeHtml(st.dir ?? '')}" spellcheck="false" autocomplete="off" style="width:100%" placeholder="${escapeHtml(st.defaultDir ?? c.placeholder)}"></label>` +
      '<button type="button" class="icon-btn" data-act="save">Kaydet</button>' +
      `${st.isDefault ? '' : '<button type="button" class="icon-btn" data-act="default">Varsayılana dön</button>'}</div>` +
      `<p class="hint">Varsayılan klasör: <span class="mono">${escapeHtml(st.defaultDir ?? '—')}</span>${st.isDefault ? ' (şu an bu kullanılıyor)' : ''}</p>` +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      (!st.exists ? '<p class="notice notice-sim">Klasör bulunamadı.</p>'
        : `<p><b>${n(st.files)}</b> dosya · <b>${n(st.without)}</b> / ${n(st.products)} ürün kartında ${c.noun} yok${st.truncated ? ' · klasör çok büyük, ilk 20.000 girdi' : ''}` +
          `${st.last ? ` <span class="hint">· son eşleme ${escapeHtml(new Date(st.last.at).toLocaleString('tr-TR', { hour12: false }))}${st.last.by ? ` (${escapeHtml(st.last.by)})` : ''}</span>` : ''}</p>`) +
      '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="match"' + (st.exists ? '' : ' disabled') + '>Eşle</button>' +
      `<button type="button" class="icon-btn" data-act="update" title="Klasörden eşlenmiş ${c.noun} dosyaları değiştiyse (yeni revizyon) yenisiyle değiştirir; elle eklenenlere dokunulmaz"${st.exists ? '' : ' disabled'}>Yeni sürümleri de güncelle</button></div>`;

    const err = m.body.querySelector('[data-role="err"]');
    const save = async (value) => {
      try { await put(`${c.url}/dir`, { dir: value }); await draw('Klasör kaydedildi.'); } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    m.body.querySelector('[data-act="save"]').addEventListener('click', () => save(m.body.querySelector('[data-role="dir"]').value));
    m.body.querySelector('[data-act="default"]')?.addEventListener('click', () => save(''));
    for (const act of ['match', 'update']) {
      m.body.querySelector(`[data-act="${act}"]`).addEventListener('click', () => run(act === 'update'));
    }
  }

  async function run(update) {
    m.body.innerHTML = '<p class="hint">Klasör taranıyor ve dosyalar eşleniyor…</p>';
    try {
      const r = await post(`${c.url}/match`, { update });
      m.body.innerHTML = resultHtml(r, c) + '<div class="dt-actions"><button type="button" class="icon-btn" data-act="back">Klasör ayarına dön</button></div>';
      m.body.querySelector('[data-act="back"]').addEventListener('click', () => draw());
      onDone();
    } catch (e) {
      m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p><div class="dt-actions"><button type="button" class="icon-btn" data-act="back">Geri</button></div>`;
      m.body.querySelector('[data-act="back"]').addEventListener('click', () => draw());
    }
  }

  draw();
}
