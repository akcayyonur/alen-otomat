/**
 * İş emrinin TEKNİK RESİM PDF'leri. Yönetici iş emrini düzenlerken PDF yükler (en çok 8, her biri en çok 20 MB); iş emri formu açılınca
 * formun ARKA SAYFASINDA hepsi tek PDF olarak alt alta (sayfa sayfa, yükleme sırasıyla) görünür. Birleştirme sunucuda yapılır
 * (GET /api/planning/work-orders/:no/drawings.pdf); çizimler sayfada olduğu gibi, yeniden çizilmeden taşınır.
 *
 * Aynı ürünün sonraki iş emirleri çizimleri otomatik alır (dosya kopyalanmaz). Baskı: ön sayfa (form) tarayıcıdan basılır; PDF tarayıcının
 * kendi PDF görüntüleyicisinde açılır ("Çizimleri aç / yazdır"), oradan arka sayfa olarak basılır (çift taraflı).
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { sizeText } from './planning-common.js';

const MAX_FILES = 8;
const MAX_BYTES = 20 * 1024 * 1024;

export const drawingsUrl = (no) => `/api/planning/work-orders/${encodeURIComponent(no)}/drawings.pdf`;

/** Düzenle penceresindeki bölüm (yönetici). @param {{no: string, drawings?: object[], status: string}} w */
export function drawingsEditorHtml(w) {
  const list = w.drawings ?? [];
  const ro = w.status === 'iptal';
  return (
    '<section class="dr-box" data-role="drawings"><h4 class="sub">Teknik resimler (PDF) · iş emri formunun arka sayfası</h4>' +
    (list.length === 0
      ? '<p class="hint">Henüz PDF yok. Teknik resim PDF\'lerini yükleyin; form açılınca hepsi arka sayfada alt alta birleşik görünür. Aynı ürünün sonraki iş emirleri bu çizimleri otomatik alır.</p>'
      : `<ol class="dr-list">${list.map((d) =>
        `<li><span class="dr-name">${escapeHtml(d.name)}</span> <small class="hint">${d.pages} sayfa · ${escapeHtml(sizeText(d.size))}</small>` +
        (ro ? '' : ` <button type="button" class="icon-btn icon-btn-sm" data-act="dr-del" data-id="${d.id}" aria-label="${escapeHtml(d.name)} dosyasını kaldır">Kaldır</button>`) + '</li>').join('')}</ol>` +
        `<p class="hint"><a href="${drawingsUrl(w.no)}" target="_blank" rel="noopener">Birleşik PDF'i aç</a> · toplam ${list.reduce((s, d) => s + d.pages, 0)} sayfa</p>`) +
    (ro ? '' : list.length >= MAX_FILES
      ? `<p class="hint">En çok ${MAX_FILES} PDF eklenebilir.</p>`
      : '<label class="dr-up"><span class="icon-btn">PDF yükle…</span><input type="file" accept="application/pdf,.pdf" multiple data-role="dr-file" aria-label="Teknik resim PDF dosyaları"></label>') +
    '<p class="notice notice-sim" data-role="dr-err" hidden></p></section>'
  );
}

/**
 * Bölümü bağlar: yükleme ve kaldırma. @param {HTMLElement} root bölümün bulunduğu kap @param {{no: string, drawings?: object[], status: string}} w
 * @param {(list: object[]) => void} onChange sunucudan gelen yeni liste (çağıran w.drawings'i günceller ve bölümü yeniden çizer)
 */
export function wireDrawings(root, w, onChange) {
  const box = root.querySelector('[data-role="drawings"]');
  if (!box) return;
  const err = (msg) => { const e = box.querySelector('[data-role="dr-err"]'); e.textContent = msg ?? ''; e.hidden = !msg; };
  box.addEventListener('change', async (ev) => {
    const input = ev.target.closest('[data-role="dr-file"]');
    if (!input) return;
    const files = [...input.files];
    input.value = '';
    err(null);
    let list = null;
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { err(`${f.name}: PDF değil.`); break; }
      if (f.size > MAX_BYTES) { err(`${f.name}: çok büyük (${sizeText(f.size)}; en fazla ${sizeText(MAX_BYTES)}).`); break; }
      box.querySelector('.dr-up').classList.add('is-busy');
      try {
        list = (await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}/drawings?${new URLSearchParams({ name: f.name })}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: f })).drawings;
        w.drawings = list; // sıradaki dosyanın "en çok 8" denetimi sunucuda; liste yenilenince çizilir
      } catch (e) {
        err(`${f.name}: ${e.message}`);
        break;
      }
    }
    if (list) onChange(list);
  });
  box.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act="dr-del"]');
    if (!b) return;
    const d = (w.drawings ?? []).find((x) => x.id === Number(b.dataset.id));
    if (!window.confirm(`${d?.name ?? 'Bu PDF'} bu iş emrinden kaldırılsın mı?`)) return;
    try {
      onChange((await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}/drawings/${b.dataset.id}`, { method: 'DELETE' })).drawings);
    } catch (e) { err(e.message); }
  });
}

/** İş emri formu + teknik resimler TEK PDF'te (ön sayfa = form, arka sayfalar = çizimler; ekranda gösterilen ve basılan dosya). */
export const printUrl = (no) => `/api/planning/work-orders/${encodeURIComponent(no)}/print.pdf`;
