/**
 * İŞ EMRİ FORMU penceresi: bugünkü kâğıt formun (Excel "İŞ EMRİ" sayfası) düzeni + varsa teknik resimler, TEK PDF'te.
 *
 * Form PDF olarak sunucuda üretilir (backend/planning/wo-form-pdf.js: sistemde bilinenler dolu, el ile yazılanlar boş) ve iş emrinin teknik resim
 * PDF'leriyle birleştirilir (ön sayfa = form, arka sayfalar = çizimler). Ekranda gösterilen de basılan da bu dosyadır; tarayıcı sayfaya gömülü PDF'i
 * `window.print()` ile basmadığı için yazdırma da PDF görüntüleyicisinden yapılır ve form ile resimler TEK işte çıkar (çift taraflı baskı uygun).
 *
 * Satıra tıklayınca açılan görünüm budur (listede "Düzenle" ayrı); Tezgah başından da herkes açabilir (izleyici ve operatör yalnız görür).
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { openModal } from './planning-common.js';
import { printUrl } from './planning-drawings.js';

/**
 * @param {string} no is emri numarasi
 * @param {{onEdit?: () => void}} [opts] onEdit verilirse (yonetici) pencerede "Düzenle…" dugmesi cikar
 */
export async function openWorkOrderForm(no, { onEdit = null } = {}) {
  const m = openModal({ title: `İş emri formu · ${no}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let w;
  try {
    w = await api(`/api/planning/work-orders/${encodeURIComponent(no)}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Form alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const url = printUrl(no);
  const drawings = w.drawings ?? [];
  const pages = drawings.reduce((s, d) => s + d.pages, 0);
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions">' +
    (onEdit ? '<button type="button" class="icon-btn" data-act="edit">Düzenle…</button>' : '') +
    `<a class="icon-btn" href="${url}" target="_blank" rel="noopener">Yeni sekmede aç</a>` +
    '<button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    '<p class="hint pl-form-actions">' +
    (drawings.length
      ? `İş emri formu + ${drawings.length} teknik resim PDF'i (${pages} sayfa) tek dosyada: <b>Yazdır</b> hepsini birlikte basar (form ön, resimler arka sayfalar).`
      : 'İş emri formu. Bu iş emrinde teknik resim yok; yönetici iş emrini düzenlerken PDF yükleyebilir.') +
    '</p>' +
    `<iframe class="pl-f-pdf" title="İş emri formu ve teknik resimler (PDF)" src="${url}#view=FitH&pagemode=none"></iframe>`;
  const frame = m.body.querySelector('iframe');
  m.body.querySelector('[data-act="print"]').addEventListener('click', () => {
    // PDF görüntüleyicisinin kendi yazdırma penceresi: form + resimler tek iş. Tarayıcı izin vermezse PDF yeni sekmede açılır (oradan yazdırılır).
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  });
  m.body.querySelector('[data-act="edit"]')?.addEventListener('click', () => { m.close(); onEdit(); });
}
