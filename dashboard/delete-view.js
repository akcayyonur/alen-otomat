/**
 * "Tornadan program sil" penceresi (FTP DELE). GERİ DÖNÜŞSÜZ: sunucu tüm kuralları kendisi de zorlar.
 *
 *   - Önce ÖN KONTROL (tornaya yalnız okuma): çalışan program, sistem dosyası, kök dizin, kütüphanede kopya var mı.
 *   - Uyarılar (kök dizin, kütüphane kopyası yok, canlı veri yok) tek tek onaylanır.
 *   - Onay: silinecek PROGRAMIN ADINI yazmak (yanlış dosyayı silmeyi önler).
 *   - Silme sonrası dosyanın listeden kalktığı doğrulanır; her deneme denetim kaydına yazılır.
 * Silinen dosyanın kütüphanede aynı içerikli kopyası varsa oradan yeniden gönderilebilir.
 */
import { escapeHtml } from './format.js';
import { post, announce, stepsTable, TRANSFER_STATUS, userName, byLocked } from './lib-common.js';

const CHECK_ICON = Object.freeze({ ok: '✓', info: 'ℹ', warn: '▲', block: '✕' });

let dlg = null;
const dd = {};

const fileLabel = (customer, name) => `${customer === '' ? '' : `${customer}\\`}${name}`;

/** @param {{machineId: string, customer: string, name: string, onDone?: () => void}} opts */
export async function openDeleteDialog({ machineId, customer, name, onDone = null }) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('aria-labelledby', 'delete-title');
    document.body.append(dlg);
    wire();
  }
  for (const k of Object.keys(dd)) delete dd[k];
  Object.assign(dd, {
    machineId, customer, name, onDone, pre: null, acks: new Set(), confirm: '', by: userName.get(), busy: false, error: null, result: null, loading: true,
  });
  render();
  if (!dlg.open) dlg.showModal();
  try {
    dd.pre = await post(`/api/machines/${encodeURIComponent(machineId)}/programs/delete-precheck`, { customer, name });
  } catch (err) {
    dd.error = `Ön kontrol yapılamadı: ${err.message}`;
  }
  dd.loading = false;
  render();
}

/** Silinebilir mi (istemci tarafi): engel yok ve istenen tum uyarilar onaylandi. Sunucu yine kendisi denetler. */
function deletable() {
  const p = dd.pre;
  return !!p && !p.checks.some((c) => c.level === 'block') && p.needsAck.every((a) => dd.acks.has(a));
}
const targetName = () => dd.pre?.name ?? dd.name;
const canGo = () => deletable() && dd.confirm === targetName() && dd.by.trim() !== '' && !dd.busy;

function checksHtml() {
  return '<h4 class="sub">Ön kontrol sonucu</h4><ul class="checks">' +
    dd.pre.checks.map((c) => `<li class="check check-${c.level}"><span class="check-ic" aria-hidden="true">${CHECK_ICON[c.level] ?? '·'}</span>` +
      `<div><b>${escapeHtml(c.title)}</b>${c.detail ? `<p>${escapeHtml(c.detail)}</p>` : ''}` +
      `${c.level === 'warn' && c.ack ? `<label class="chk"><input type="checkbox" data-ack="${escapeHtml(c.ack)}"${dd.acks.has(c.ack) ? ' checked' : ''}${dd.busy ? ' disabled' : ''}> ` +
        `${c.ack === 'no-backup' ? 'Kütüphanede kopyası olmadan sil (geri alınamaz)' : 'Anladım, yine de silmek istiyorum'}</label>` : ''}</div></li>`).join('') + '</ul>';
}

function resultHtml() {
  const t = dd.result;
  const s = TRANSFER_STATUS[t.status] ?? { icon: '·', label: t.status, cls: 'none' };
  const headline = {
    basarili: 'Program tornadan silindi ve listeden kalktığı doğrulandı.',
    reddedildi: 'Silinmedi: ön kontrol engeline takıldı. Tornadan hiçbir şey silinmedi.',
    basarisiz: 'Silme başarısız oldu. Dosya tornada duruyor olabilir; tezgah panelinden kontrol edin.',
    dogrulanamadi: 'Tezgah silindi dedi ama dosya hâlâ listede görünüyor: tezgah panelinden elle kontrol edin.',
  }[t.status] ?? t.status;
  return `<div class="result result-${s.cls}"><span class="result-ic" aria-hidden="true">${s.icon}</span><div><b>${escapeHtml(headline)}</b>` +
    `${t.error ? `<p>${escapeHtml(t.error)}</p>` : ''}` +
    `${t.status === 'basarili' ? '<p>Kütüphanede kopyası varsa oradan yeniden gönderebilirsiniz.</p>' : ''}</div></div>` +
    stepsTable(t.steps) +
    `<p class="hint">Kayıt no ${t.id} · ${escapeHtml(t.requestedBy ?? '')}${t.shaVerified ? ` · silinen içeriğin SHA-256 ${escapeHtml(t.shaVerified.slice(0, 16))}…` : ''}</p>` +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>';
}

function render() {
  const label = fileLabel(dd.pre?.customer ?? dd.customer, targetName());
  dlg.innerHTML =
    '<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">Tornaya yazma · geri alınamaz</span>' +
    '<h3 id="delete-title">Tornadan program sil</h3></div>' +
    `<button type="button" class="icon-btn" data-act="close"${dd.busy ? ' disabled' : ''}>Kapat</button></header><div class="modal-body">` +
    `<p class="notice notice-sim"><b>${escapeHtml(dd.machineId)}</b> tezgahındaki <b class="mono">${escapeHtml(label)}</b> dosyası <b>silinecek</b>. ` +
    'Bu geri alınamaz. Klasör silinmez, yalnızca bu tek dosya. Program silinirken çalışan program korunur.</p>' +
    (dd.error ? `<p class="notice notice-sim">${escapeHtml(dd.error)}</p>` : '') +
    (dd.result ? resultHtml() :
      dd.loading ? '<p class="empty">Ön kontrol yapılıyor… (tornaya yalnızca okuma)</p>' :
        !dd.pre ? '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button></div>' :
          checksHtml() +
          (dd.pre.checks.some((c) => c.level === 'block')
            ? '<p class="notice notice-sim"><b>Silinemez.</b> Yukarıdaki ✕ ile işaretli engeli giderin.</p>'
            : '<div class="confirm-box">' +
              `<label class="fld"><span>Adınız (kayıt için, zorunlu)</span><input data-key="by" value="${escapeHtml(dd.by)}" maxlength="40" placeholder="ör. Ayşe"${byLocked()}${dd.busy ? ' disabled' : ''}></label>` +
              `<label class="fld"><span>Silmek için program adını yazın: <b class="mono">${escapeHtml(targetName())}</b></span>` +
              `<input data-key="confirm" value="${escapeHtml(dd.confirm)}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(targetName())}" class="mono"${dd.busy ? ' disabled' : ''}></label>` +
              `<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="delete"${canGo() ? '' : ' disabled'}>` +
              `${dd.busy ? 'Siliniyor…' : 'Tornadan sil'}</button></div>` +
              (dd.pre.needsAck.length > 0 && !dd.pre.needsAck.every((a) => dd.acks.has(a)) ? '<p class="hint">Sarı (▲) uyarıları onaylamadan silinemez.</p>' : '') +
              '</div>')) +
    '</div></div>';
}

function wire() {
  dlg.addEventListener('cancel', (ev) => { if (dd.busy) ev.preventDefault(); });
  dlg.addEventListener('change', (ev) => {
    const a = ev.target.dataset?.ack;
    if (!a) return;
    if (ev.target.checked) dd.acks.add(a); else dd.acks.delete(a);
    render();
  });
  // Yazarken yeniden cizme (odak kaybolur): yalniz durumu guncelle ve dugmeyi ac/kapat.
  dlg.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.key;
    if (key !== 'confirm' && key !== 'by') return;
    dd[key] = ev.target.value;
    if (key === 'by') userName.set(dd.by.trim());
    const go = dlg.querySelector('[data-act="delete"]');
    if (go) go.disabled = !canGo();
  });
  dlg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === 'close') { if (!dd.busy) dlg.close(); return; }
    if (btn.dataset.act !== 'delete' || !canGo()) return;
    dd.busy = true;
    dd.error = null;
    render();
    try {
      dd.result = await post(`/api/machines/${encodeURIComponent(dd.machineId)}/programs/delete`, {
        customer: dd.pre.customer ?? dd.customer, name: targetName(), confirm: dd.confirm, by: dd.by.trim(), acks: [...dd.acks],
      });
      announce();
      dd.onDone?.();
    } catch (err) {
      dd.error = `Silme isteği başarısız: ${err.message}`;
    }
    dd.busy = false;
    render();
  });
}

