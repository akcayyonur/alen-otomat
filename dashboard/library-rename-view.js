/**
 * "Program adini degistir" penceresi: kutuphanedeki bir programi AYNI musteri klasorunde yeniden adlandirir.
 * Surumler/icerik dokunulmaz, yalniz ad. Sunucuya yazma gerektirmeyen bir kutuphane kaydidir (tezgaha FTP
 * gitmez): "Yeni musteri klasoru" gibi tezgah kimligi onayi istemez, Kaydet yeterlidir.
 *
 * Tezgahtaki dosya eski adla kalir: rename'den sonra tezgahtaki dosya "kutuphanede yok" (eski ad), yeni ad
 * "tezgahta yok" gorunur - taranmis envanter kutuphane kaydini otomatik takip etmez. Bu, pencerede soylenir.
 */
import { escapeHtml } from './format.js';
import { post, folderLabel } from './lib-common.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/** Sunucudaki kuralin aynasi (sunucu yine kendisi denetler). Sorun yoksa null. */
export function programRenameProblem(raw, currentName) {
  const name = raw.trim();
  if (name === '') return null;
  if (!NAME_RE.test(name) || name === '.' || name === '..') {
    return 'Program adı geçersiz: İngilizce harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).';
  }
  if (/^zz(up|rb)/i.test(name)) return '"ZZUP" ve "ZZRB" ile başlayan adlar aktarım için ayrılmıştır.';
  if (name.toLowerCase() === currentName.toLowerCase()) return 'Bu zaten programın şu anki adı.';
  return null;
}

let dlg = null;
const rd = { program: null, name: '', busy: false, error: null, onDone: null };

const canSave = () => !rd.busy && rd.name.trim() !== '' && programRenameProblem(rd.name, rd.program.name) === null;

export function openRenameDialog({ program, onDone = null }) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('aria-labelledby', 'rename-title');
    document.body.append(dlg);
    dlg.addEventListener('cancel', (ev) => { if (rd.busy) ev.preventDefault(); });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg && !rd.busy) dlg.close(); });
    wire();
  }
  Object.assign(rd, { program, name: program.name, busy: false, error: null, onDone });
  render();
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('[data-key="name"]')?.select();
}

function render() {
  const problem = programRenameProblem(rd.name, rd.program.name);
  dlg.innerHTML =
    '<div class="modal-inner">' +
    `<header class="modal-head"><div><span class="eyebrow">${escapeHtml(folderLabel(rd.program.customer))}</span><h3 id="rename-title">Program adını değiştir</h3></div>` +
    `<button type="button" class="icon-btn" data-act="close"${rd.busy ? ' disabled' : ''}>Kapat</button></header>` +
    '<div class="modal-body">' +
    '<p class="hint">Yalnız kütüphane kaydının adı değişir; sürümler ve içerik aynen kalır. ' +
    `Tezgahta <span class="mono">${escapeHtml(rd.program.name)}</span> adıyla duran dosyaya dokunulmaz: yeniden göndermeden tezgahta eski adla görünmeye devam eder.</p>` +
    (rd.error ? `<p class="notice notice-sim">${escapeHtml(rd.error)}</p>` : '') +
    '<div class="fld-grid">' +
    '<label class="fld"><span>Yeni ad</span>' +
    `<input data-key="name" value="${escapeHtml(rd.name)}" maxlength="40" autocomplete="off" spellcheck="false" class="mono" aria-describedby="rename-name-msg"${rd.busy ? ' disabled' : ''}></label>` +
    '</div>' +
    `<p class="hint" id="rename-name-msg" data-role="name-msg" aria-live="polite">${problem ? `✕ ${escapeHtml(problem)}` : 'İngilizce harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).'}</p>` +
    `<div class="dt-actions"><button type="button" class="icon-btn" data-act="close"${rd.busy ? ' disabled' : ''}>Vazgeç</button>` +
    `<button type="button" class="icon-btn btn-primary" data-act="save"${canSave() ? '' : ' disabled'}>${rd.busy ? 'Kaydediliyor…' : 'Kaydet'}</button></div>` +
    '</div></div>';
}

function wire() {
  // Yazarken yeniden cizme (odak kaybolur): yalniz mesaji ve dugmeyi guncelle.
  dlg.addEventListener('input', (ev) => {
    if (ev.target.dataset?.key !== 'name') return;
    rd.name = ev.target.value;
    const problem = programRenameProblem(rd.name, rd.program.name);
    const msg = dlg.querySelector('[data-role="name-msg"]');
    if (msg) msg.textContent = problem ? `✕ ${problem}` : 'İngilizce harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).';
    const go = dlg.querySelector('[data-act="save"]');
    if (go) go.disabled = !canSave();
  });

  dlg.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && canSave()) dlg.querySelector('[data-act="save"]')?.click(); });

  dlg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') { if (!rd.busy) dlg.close(); return; }
    if (btn.dataset.act !== 'save' || !canSave()) return;
    rd.busy = true;
    rd.error = null;
    render();
    try {
      const result = await post(`/api/library/programs/${rd.program.id}/rename`, { name: rd.name.trim() });
      dlg.close();
      await rd.onDone?.(result);
    } catch (err) {
      rd.busy = false;
      rd.error = err.message;
      render();
    }
  });
}
