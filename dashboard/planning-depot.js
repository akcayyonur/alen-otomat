/**
 * İş emri ayrıntısındaki "Bitmiş ürün depo akışı" paneli (Mikro): iş emri bitince üretilen adet Merkez'den
 * Geçici depoya, paketlenince (paketleme formu toplamı) Geçici'den Merkez depoya aktarılır. GERÇEK AĞA HENÜZ
 * YAZILMADI (2026-11-03, aynı ağda değiliz) — `MIKRO_WRITE_ENABLED` ve bağlantı olmadan düğmeler 409 ile
 * "kapalı" der, iş emri bitirmeyi/paketlemeyi ETKİLEMEZ. Sahada test edilince bu not kaldırılmalı.
 */
import { escapeHtml } from './format.js';
import { chip, fmtNum } from './planning-common.js';

/** @param {object} w /api/planning/work-orders/:no yanıtı (`depot` alanıyla) */
export function depotPanelHtml(w) {
  const d = w.depot;
  if (!d) return '<section class="pl-prog" data-role="depot" hidden></section>';
  const blocked = !d.writeEnabled ? (d.configured ? 'Mikro yazma şu an kapalı (onay bekliyor ya da ağ dışı).' : 'MikroAPI yapılandırılmadı.') : null;

  const line = (label, h, act, btnLabel) => {
    const parts = [];
    if (h.sent > 0) parts.push(chip('ok', '✓', `${fmtNum(h.sent)} adet gönderildi`));
    if (h.pending > 0) {
      parts.push(chip('warn', '◔', `${fmtNum(h.pending)} adet bekliyor`));
      parts.push(`<button type="button" class="icon-btn icon-btn-sm" data-act="${act}"${blocked ? ` disabled title="${escapeHtml(blocked)}"` : ''}>${escapeHtml(btnLabel)}</button>`);
    }
    if (parts.length === 0) parts.push('<span class="is-null">—</span>');
    return `<div class="pl-kpi"><span class="pl-kpi-l">${escapeHtml(label)}</span><span class="pl-kpi-v">${parts.join(' ')}</span></div>`;
  };

  const lastError = [...d.bitis.history, ...d.paketleme.history].filter((x) => x.status === 'basarisiz').sort((a, b) => b.at - a.at)[0];
  return (
    '<section class="pl-prog" data-role="depot">' +
    '<h4 class="sub">Bitmiş ürün depo akışı (Mikro)</h4>' +
    '<p class="hint">İş emri bitince üretilen adet Merkez\'den Geçici depoya, paketlenince (paketleme formu toplamı) Geçici\'den Merkez depoya aktarılır — Depolar Arası Sevk Fişi.</p>' +
    '<div class="pl-kpis">' +
    line('Geçici depoya aktarım', d.bitis, 'depot-finish-send', 'Geçici depoya aktar…') +
    line('Merkez depoya sevk', d.paketleme, 'depot-pack-send', 'Merkeze sevk et…') +
    '</div>' +
    (lastError ? `<p class="notice notice-sim">Son deneme başarısız (${escapeHtml(lastError.kind === 'bitis' ? 'Geçici depoya aktarım' : 'Merkez depoya sevk')}): ${escapeHtml(lastError.error ?? '')}</p>` : '') +
    '</section>'
  );
}
