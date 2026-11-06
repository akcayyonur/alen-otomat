/**
 * İş emri ayrıntısındaki "Bitmiş ürün depo akışı" paneli (Mikro): iş emri bitince üretilen adet Geçici depoda
 * GİRİŞ virmanıyla oluşur (ofisin gerçek Mikro kaydıyla doğrulandı, 2026-11-04 — Merkez'den transfer DEĞİL),
 * paketlenince (paketleme formu toplamı) Geçici'den Merkez depoya Depolar Arası Sevk Fişiyle aktarılır.
 *
 * "Merkez depoya sevk" artık paketleme satırı eklenince/düzenlenince OTOMATİK denenir (kullanıcı kararı,
 * 2026-11-04 — bkz. `planning.js` `addPackingRow`/`updatePackingRow`); buradaki "Merkeze sevk et…" düğmesi hâlâ
 * duruyor, yalnız ELLE YENİDEN DENEME içindir (otomatik deneme başarısız/Mikro kapalıysa). "Geçici depoya aktar…"
 * (iş emri bitince) ve "Farkı temizle…" (kalan fark) BİLEREK otomatikleşmedi: ikisi de admin'in bir ŞEYİ
 * kesinleştirdiği anlar — üretimin GERÇEKTEN bittiği, paketlemenin GERÇEKTEN bittiği — sistem bunu kendiliğinden
 * bilemez (bkz. `backend/planning/product-depot.js` başındaki uzun not).
 */
import { escapeHtml } from './format.js';
import { chip, fmtNum } from './planning-common.js';

/** @param {object} w /api/planning/work-orders/:no yanıtı (`depot` alanıyla) */
export function depotPanelHtml(w) {
  const d = w.depot;
  if (!d) return '<section class="pl-prog" data-role="depot" hidden></section>';
  const blocked = !d.flowEnabled ? 'Bitmiş ürün depo akışı şu an kapalı (fabrika PC\'si/paketleme sahada kurulana kadar).'
    : !d.writeEnabled ? (d.configured ? 'Mikro yazma şu an kapalı (onay bekliyor ya da ağ dışı).' : 'MikroAPI yapılandırılmadı.')
    : null;

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

  const t = d.temizle;
  const clearedTotal = t?.history.filter((x) => x.status === 'basarili').reduce((s, x) => s + x.qty, 0) ?? 0;
  const clearParts = [];
  if (clearedTotal > 0) clearParts.push(chip('none', '−', `${fmtNum(clearedTotal)} adet temizlendi`));
  if (t?.remaining > 0) {
    clearParts.push(chip('warn', '◔', `${fmtNum(t.remaining)} adet (paketlenmeyecek fark)`));
    if (t.canClear) clearParts.push(`<button type="button" class="icon-btn icon-btn-sm" data-act="depot-clear-ask"${blocked ? ` disabled title="${escapeHtml(blocked)}"` : ''}>Farkı temizle…</button>`);
  }
  const clearLine = clearParts.length
    ? `<div class="pl-kpi"><span class="pl-kpi-l">Geçici'de kalan</span><span class="pl-kpi-v">${clearParts.join(' ')}</span></div>` : '';
  const confirmBox = t?.canClear
    ? '<div data-role="depot-clear-box" hidden>' +
      `<p class="notice notice-sim"><b>${fmtNum(t.remaining)} adet</b> bu iş emrinde üretilen ama hiç paketlenmeyecek fark olarak Geçici depodan GERİ ALINAMAZ şekilde düşülecek (stok virman, çıkan). ` +
      'Yalnız bu iş emrinin paketlemesi TAMAMEN bittiyse onaylayın — sonradan buraya yeni paketleme satırı eklenirse Geçici depo bakiyesi yanlış olur, sistem bunu engellemez.</p>' +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="depot-clear-no">Vazgeç</button>' +
      '<button type="button" class="icon-btn btn-danger" data-act="depot-clear-yes">Evet, temizle</button></div></div>'
    : '';

  const KIND_LABEL = { bitis: 'Geçici depoya aktarım', paketleme: 'Merkez depoya sevk', temizle: 'Kalan farkı temizleme' };
  const lastError = [...d.bitis.history, ...d.paketleme.history, ...(t?.history ?? [])].filter((x) => x.status === 'basarisiz').sort((a, b) => b.at - a.at)[0];
  return (
    '<section class="pl-prog" data-role="depot">' +
    '<h4 class="sub">Bitmiş ürün depo akışı (Mikro)</h4>' +
    '<p class="hint">İş emri bitince üretilen adet Geçici depoda GİRİŞ virmanıyla oluşur, paketlenince (paketleme formu toplamı) Geçici\'den Merkez depoya Depolar Arası Sevk Fişiyle aktarılır.</p>' +
    '<div class="pl-kpis">' +
    line('Geçici depoya aktarım', d.bitis, 'depot-finish-send', 'Geçici depoya aktar…') +
    line('Merkez depoya sevk', d.paketleme, 'depot-pack-send', 'Merkeze sevk et…') +
    clearLine +
    '</div>' + confirmBox +
    (lastError ? `<p class="notice notice-sim">Son deneme başarısız (${escapeHtml(KIND_LABEL[lastError.kind] ?? lastError.kind)}): ${escapeHtml(lastError.error ?? '')}</p>` : '') +
    '</section>'
  );
}
