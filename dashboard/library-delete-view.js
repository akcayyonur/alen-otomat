/**
 * "Kütüphaneden sil" penceresi. GERİ DÖNÜŞSÜZ: programlar tüm sürümleriyle kütüphaneden silinir.
 *
 *   - Tezgahlardaki dosyalara DOKUNULMAZ; ama kütüphane kopyası gidince tornadan silerken "kütüphanede kopyası var"
 *     güvencesi kalmaz. Pencere hangi tezgahlarda kopyası olduğunu gösterir.
 *   - Onay: tek programda programın ADINI, birden çok programda program SAYISINI yazmak (sunucu da denetler).
 *   - Silinenler "Kütüphaneden silinenler" kaydına yazılır (kim, ne zaman, kaç sürüm, sürüm SHA-256'ları).
 */
import { escapeHtml, num } from './format.js';
import { post, announce, programLabel, userName, byLocked } from './lib-common.js';

const LIST_MAX = 12;

let dlg = null;
const ld = {};

/**
 * @param {{programs: {id: number, customer: string, name: string, versionCount: number}[],
 *          holders?: Map<number, string[]>, onDone?: (result: object) => void}} opts
 *   holders: program kimliği -> kopyası olan tezgahlar (matristen)
 */
export function openLibraryDelete({ programs, holders = new Map(), onDone = null }) {
  if (programs.length === 0) return;
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('aria-labelledby', 'libdel-title');
    document.body.append(dlg);
    wire();
  }
  for (const k of Object.keys(ld)) delete ld[k];
  Object.assign(ld, { programs, holders, onDone, confirm: '', by: userName.get(), busy: false, error: null, result: null });
  render();
  if (!dlg.open) dlg.showModal();
}

const expected = () => (ld.programs.length === 1 ? ld.programs[0].name : String(ld.programs.length));
const canGo = () => ld.confirm === expected() && ld.by.trim() !== '' && !ld.busy;
const versionTotal = () => ld.programs.reduce((n, p) => n + (p.versionCount ?? 1), 0);

function render() {
  const n = ld.programs.length;
  const onMachines = ld.programs.filter((p) => (ld.holders.get(p.id) ?? []).length > 0).length;
  const list = ld.programs.slice(0, LIST_MAX).map((p) => {
    const h = ld.holders.get(p.id) ?? [];
    return `<li><span class="mono"><b>${escapeHtml(programLabel(p.customer, p.name))}</b></span> · ${num(p.versionCount ?? 1)} sürüm` +
      `${h.length ? ` · tezgahlarda: <span class="mono">${escapeHtml(h.join(', '))}</span>` : ' · hiçbir tezgahta görünmüyor'}</li>`;
  }).join('') + (n > LIST_MAX ? `<li class="hint">… ve ${num(n - LIST_MAX)} program daha</li>` : '');

  dlg.innerHTML =
    '<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">Kütüphane · geri alınamaz</span>' +
    '<h3 id="libdel-title">Kütüphaneden program sil</h3></div>' +
    `<button type="button" class="icon-btn" data-act="close"${ld.busy ? ' disabled' : ''}>Kapat</button></header><div class="modal-body">` +
    (ld.result
      ? `<div class="result result-ok"><span class="result-ic" aria-hidden="true">✓</span><div><b>${num(ld.result.programs)} program (${num(ld.result.versions)} sürüm) kütüphaneden silindi.</b>` +
        '<p>Tezgahlardaki dosyalara dokunulmadı. Kayıt "Kütüphaneden silinenler" listesine yazıldı.</p></div></div>' +
        '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>'
      : `<p class="notice notice-sim"><b>${num(n)} program</b> (${num(versionTotal())} sürüm) kütüphaneden <b>silinecek</b>. Bu geri alınamaz. ` +
        'Tezgahlardaki dosyalar silinmez; ama kütüphane yedeği kalmaz.</p>' +
        (onMachines > 0
          ? `<p class="notice"><b>${num(onMachines)} programın tezgahlarda kopyası var.</b> Bu kopya kütüphaneden gidince, o dosyaları sonradan tornadan silerken ` +
            '"kütüphanede yedeği var" güvencesi olmaz (silinen dosya geri getirilemez).</p>' : '') +
        `<ul class="checks libdel-list">${list}</ul>` +
        (ld.error ? `<p class="notice notice-sim">${escapeHtml(ld.error)}</p>` : '') +
        '<div class="confirm-box">' +
        `<label class="fld"><span>Adınız (kayıt için, zorunlu)</span><input data-key="by" value="${escapeHtml(ld.by)}" maxlength="40" placeholder="ör. Ayşe"${byLocked()}${ld.busy ? ' disabled' : ''}></label>` +
        `<label class="fld"><span>${n === 1 ? 'Silmek için program adını yazın' : 'Silmek için program sayısını yazın'}: <b class="mono">${escapeHtml(expected())}</b></span>` +
        `<input data-key="confirm" value="${escapeHtml(ld.confirm)}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(expected())}" class="mono"${ld.busy ? ' disabled' : ''}></label>` +
        '<div class="dt-actions"><button type="button" class="icon-btn btn-danger" data-act="delete"' + (canGo() ? '' : ' disabled') + '>' +
        `${ld.busy ? 'Siliniyor…' : `Kütüphaneden sil (${num(n)})`}</button>` +
        '<button type="button" class="icon-btn" data-act="close"' + (ld.busy ? ' disabled' : '') + '>Vazgeç</button></div></div>') +
    '</div></div>';
}

function wire() {
  dlg.addEventListener('cancel', (ev) => { if (ld.busy) ev.preventDefault(); });
  // Yazarken yeniden cizme (odak kaybolur): yalniz durumu guncelle ve dugmeyi ac/kapat.
  dlg.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.key;
    if (key !== 'confirm' && key !== 'by') return;
    ld[key] = ev.target.value;
    if (key === 'by') userName.set(ld.by.trim());
    const go = dlg.querySelector('[data-act="delete"]');
    if (go) go.disabled = !canGo();
  });
  dlg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === 'close') { if (!ld.busy) dlg.close(); return; }
    if (btn.dataset.act !== 'delete' || !canGo()) return;
    ld.busy = true;
    ld.error = null;
    render();
    try {
      ld.result = await post('/api/library/programs/delete', { ids: ld.programs.map((p) => p.id), confirm: ld.confirm, by: ld.by.trim() });
      announce();
      ld.onDone?.(ld.result);
    } catch (err) {
      ld.error = `Silme isteği başarısız: ${err.message}`;
    }
    ld.busy = false;
    render();
  });
}
