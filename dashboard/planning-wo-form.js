/**
 * Yazdirilabilir IS EMRI formu: bugunku kagit formun (Excel "IS EMRI" sayfasi) duzeni. El ile yazilan alanlar (uretim gramaji, gercek sure,
 * planlama yetkilisi, alttaki TARIH/VARDIYA/ADET tablosu) bos birakilir; sistemde bilinenler dolu gelir.
 * Yazdirma: tarayicinin yazdir penceresi (A4, dikey). Ekranda "kagit" gorunumu icin her temada beyaz zemin.
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { openModal, fmtDec } from './planning-common.js';

const g = (kg) => (kg === null || kg === undefined ? '' : fmtDec(kg * 1000, 2));
const d = (ms) => (ms ? new Date(ms).toLocaleDateString('tr-TR') : '');
const dayShort = (key) => { const [y, m, dd] = key.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('tr-TR'); };

/** @param {object} w /api/planning/work-orders/:no yaniti */
export function formHtml(w) {
  const cell = (label, value, cls = '') => `<div class="pl-f-cell ${cls}"><span class="pl-f-label">${label}</span><span class="pl-f-val">${value === '' || value == null ? '&nbsp;' : escapeHtml(value)}</span></div>`;
  // Alt tablo (TARIH | VARDIYA | ADET x 3 grup x 8 satir): uretime baslamis is emrinde vardiya adetleri telemetriden dolar (sutun sutun: once soldaki grup),
  // geri kalan bos kalir (el ile yazilir).
  const slots = (w.progress?.shifts ?? []).slice(0, 24);
  const slotCells = (row) => [0, 1, 2].map((g) => {
    const s = slots[g * 8 + row];
    return s ? `<td>${escapeHtml(dayShort(s.date))}</td><td>${escapeHtml(s.label)}</td><td>${escapeHtml(String(s.qty))}</td>` : '<td></td><td></td><td></td>';
  }).join('');
  const rows = (n) => Array.from({ length: n }, (_, i) => `<tr>${slotCells(i)}</tr>`).join('');
  return (
    '<div class="pl-form">' +
    `<div class="pl-f-head"><div class="pl-f-title">İŞ EMRİ</div><div class="pl-f-no"><div><span class="pl-f-label">İŞ EMRİ NO:</span> <b>${escapeHtml(w.no)}</b></div>` +
    `<div><span class="pl-f-label">TARİH:</span> <b>${escapeHtml(d(w.createdAt))}</b></div></div></div>` +
    '<div class="pl-f-grid">' +
    cell('MAMUL ADI :', w.productName) + cell('TERMİN SÜRESİ:', d(w.dueDate), 'pl-f-due') +
    cell('ALEN OTOMAT ÜRÜN KODU', w.stockCode) + cell('SİPARİŞ NO', w.custOrderNo) +
    cell('MÜŞTERİ ÜRÜN KODU', w.customerCode) + cell('HEDEF ADET', `${w.targetQty.toLocaleString('tr-TR')} AD`) +
    cell('HAMMADDE ADI', w.usedMaterial ?? w.material) + cell('ALTERNATİF HAMMADDE ADI :', w.altMaterial) +
    cell('NET GRAMAJ (gr) (MALİYET)', g(w.netKg ?? null) ? `${g(w.netKg)} GR` : '') + cell('NET GRAMAJ (gr) (ÜRETİM)', w.measuredNetKg == null ? '' : `${g(w.measuredNetKg)} gr`) +
    cell('BRÜT GRAMAJ (gr)', g(w.grossKg) ? `${g(w.grossKg)} GR` : '') +
    cell('ÜRETİM SÜRESİ (sn) (MALİYET) SAAT', w.plannedSec ? `${fmtDec(w.plannedSec, 1)} SN${w.plannedHours ? ` · ${fmtDec(w.plannedHours, 2)} SAAT` : ''}` : '') + cell('ÜRETİM SÜRESİ (sn) (ÜRETİM)', '') +
    cell('GKK RAPOR NO', w.gkkReportNo) + cell('İLK ONAY RAPOR NO', w.firstApprovalNo) +
    cell('TEZGAH NO', w.machineNumber ?? w.machineId) +
    cell('KULLANILAN TOPLAM HAMMADDE (Kg) (Boy)', w.rawKg === null && w.bars === null ? '' : `${w.rawKg === null ? '—' : fmtDec(w.rawKg, 2)} KG · ${w.bars === null ? '—' : fmtDec(w.bars, 2)} BOY`, 'pl-f-wide') +
    `<div class="pl-f-cell pl-f-wide"><span class="pl-f-label">AÇIKLAMA</span><span class="pl-f-val">${w.note ? escapeHtml(w.note) : '&nbsp;'}</span></div>` +
    '<div class="pl-f-cell pl-f-wide pl-f-sign"><span class="pl-f-label">ÜRETİM PLANLAMA YETKİLİSİ</span><span class="pl-f-val">&nbsp;</span></div>' +
    '</div>' +
    '<table class="pl-f-table"><thead><tr>' + '<th>TARİH</th><th>VARDİYA</th><th>ADET</th>'.repeat(3) + `</tr></thead><tbody>${rows(8)}</tbody></table>` +
    `<p class="pl-f-foot">${w.status === 'iptal' ? 'İPTAL EDİLDİ · ' : ''}${slots.length ? 'Vardiya adetleri telemetriden (tezgah sayacı) · ' : ''}Sistemden üretildi · ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p>` +
    '</div>'
  );
}

/** @param {string} no is emri numarasi */
export async function openWorkOrderForm(no) {
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
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    formHtml(w);
  m.body.querySelector('[data-act="print"]').addEventListener('click', () => {
    document.body.classList.add('pl-printing');
    const done = () => { document.body.classList.remove('pl-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  });
}

