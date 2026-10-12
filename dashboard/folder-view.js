/**
 * "Yeni musteri klasoru" penceresi: secilen tezgahin NcFiles kokunde YENI, bos bir klasor acar (FTP MKD).
 *
 * Kurallar (sunucuda da zorlanir, burasi yalniz kullaniciyi yonlendirir):
 *  - Var olan hicbir klasor/dosya degismez; klasor SILME yoktur.
 *  - Ad dar tutulur: yalniz Ingilizce harf, rakam, _ - . (Turkce karakter yok).
 *  - Gonderme ile ayni onay: tezgahin kimligini yazmak. Her islem denetim kaydina yazilir.
 */
import { escapeHtml } from './format.js';
import { api, post, userName, announce, stepsTable, TRANSFER_STATUS, byLocked } from './lib-common.js';

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Sunucudaki kuralin aynasi (sunucu yine kendisi denetler). Sorun yoksa null. */
export function folderNameProblem(raw, known = []) {
  const name = raw.trim();
  if (name === '') return null;
  if (!NAME_RE.test(name) || name.endsWith('.')) {
    return 'Yalnızca İngilizce harf, rakam, "_", "-" ve "." kullanılabilir (en fazla 40 karakter; harf/rakam/"_" ile başlar, "." ile bitmez). Türkçe karakter kullanmayın (ör. Ş yerine S).';
  }
  if (RESERVED.test(name)) return `"${name}" Windows'un ayrılmış bir adıdır; başka bir ad seçin.`;
  if (/^zz(up|rb)/i.test(name)) return '"ZZUP" ve "ZZRB" ile başlayan adlar aktarım için ayrılmıştır.';
  if (known.some((k) => k.toLowerCase() === name.toLowerCase())) return `"${name}" klasörü tezgahta zaten var (büyük/küçük harf fark etmez).`;
  return null;
}

let dlg = null;
const fd = {
  machineId: null, machines: [], transferEnabled: true, known: [], name: '', by: '', confirm: '',
  busy: false, error: null, result: null, onDone: null,
};

const machine = () => fd.machines.find((m) => m.id === fd.machineId) ?? null;
/** Yazmayi engelleyen neden (ozellik kapali / bu kontrolcu modelinde yazma dogrulanmadi) ya da null. */
function blockedReason() {
  if (!fd.transferEnabled) return 'Tezgaha yazma kapalı (sunucu TRANSFER_DISABLED=1 ile başlatılmış).';
  const m = machine();
  if (m && m.sendAllowed === false) return `${m.controllerModel ?? 'Bu model'}: ${m.sendBlockedReason ?? 'tezgaha yazma bu kontrolcü modelinde henüz doğrulanmadı.'}`;
  return null;
}
const canCreate = () =>
  !!fd.machineId && !blockedReason() && !fd.busy && fd.name.trim() !== '' && folderNameProblem(fd.name, fd.known) === null &&
  fd.by.trim() !== '' && fd.confirm === fd.machineId;

async function loadKnown() {
  fd.known = [];
  if (!fd.machineId) return;
  try {
    const d = await api(`/api/machines/${encodeURIComponent(fd.machineId)}/programs`);
    fd.known = d.folders ?? [];
  } catch { /* bilinmiyor: sunucu zaten canli listeyle denetler */ }
}

export async function openFolderDialog({ machineId = null, onDone = null } = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('aria-labelledby', 'folder-title');
    document.body.append(dlg);
    dlg.addEventListener('cancel', (ev) => { if (fd.busy) ev.preventDefault(); });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg && !fd.busy) dlg.close(); });
    wire();
  }
  Object.assign(fd, { name: '', confirm: '', by: userName.get(), busy: false, error: null, result: null, onDone });
  try {
    const cfg = await api('/api/library/config');
    fd.machines = cfg.machines.filter((m) => m.capable);
    fd.transferEnabled = cfg.transferEnabled;
  } catch (err) {
    fd.machines = [];
    fd.error = err.message;
  }
  fd.machineId = machineId && fd.machines.some((m) => m.id === machineId) ? machineId : (fd.machines[0]?.id ?? null);
  await loadKnown();
  render();
  if (!dlg.open) dlg.showModal();
}

function resultBlock() {
  const t = fd.result;
  const s = TRANSFER_STATUS[t.status] ?? { icon: '·', label: t.status, cls: 'none' };
  const headline = {
    basarili: `"${t.customer}" klasörü tezgahta açıldı ve doğrulandı.`,
    reddedildi: 'Klasör açılmadı. Tezgaha hiçbir şey yazılmadı.',
    basarisiz: 'Klasör açılamadı.',
    dogrulanamadi: 'Tezgah klasörü açtığını söyledi ama doğrulanamadı: tezgah panelinden elle kontrol edin.',
  }[t.status] ?? t.status;
  return `<div class="result result-${s.cls}"><span class="result-ic" aria-hidden="true">${s.icon}</span><div><b>${escapeHtml(headline)}</b>` +
    `${t.error ? `<p>${escapeHtml(t.error)}</p>` : ''}` +
    `${t.status === 'basarili' ? '<p>Klasör boş. Şimdi bu klasöre "Program gönder" ile program yollayabilirsiniz.</p>' : ''}</div></div>` +
    stepsTable(t.steps) +
    `<p class="hint">Kayıt no ${t.id} · ${escapeHtml(t.requestedBy ?? '')}</p>` +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="again">Başka bir klasör aç</button>' +
    '<button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>';
}

function render() {
  const blocked = blockedReason();
  const problem = folderNameProblem(fd.name, fd.known);
  dlg.innerHTML =
    '<div class="modal-inner">' +
    '<header class="modal-head"><div><span class="eyebrow">Tezgaha yazma</span><h3 id="folder-title">Yeni müşteri klasörü aç</h3></div>' +
    `<button type="button" class="icon-btn" data-act="close"${fd.busy ? ' disabled' : ''}>Kapat</button></header>` +
    '<div class="modal-body">' +
    '<p class="notice">Tezgahın program belleğinde (NcFiles) <b>yeni, boş</b> bir klasör açılır. Var olan hiçbir klasör ya da program değişmez; ' +
    'klasör silme yoktur. Açıldıktan sonra program göndermeniz için hedef klasör olarak seçilebilir.</p>' +
    (fd.error ? `<p class="notice notice-sim">${escapeHtml(fd.error)}</p>` : '') +
    (blocked ? `<p class="notice notice-sim"><b>Klasör açılamaz.</b> ${escapeHtml(blocked)}</p>` : '') +
    (fd.result ? resultBlock() :
      '<div class="fld-grid">' +
      `<label class="fld"><span>Tezgah</span><select data-key="machineId"${fd.busy ? ' disabled' : ''}>` +
      (fd.machines.length === 0 ? '<option value="">(aktarım yapabilen tezgah yok)</option>' :
        fd.machines.map((m) => `<option value="${escapeHtml(m.id)}"${m.id === fd.machineId ? ' selected' : ''}>${escapeHtml(m.id)} · ${escapeHtml(m.name)}${m.controllerModel ? ` · ${escapeHtml(m.controllerModel)}` : ''}</option>`).join('')) +
      '</select></label>' +
      '<label class="fld"><span>Yeni klasör adı (müşteri)</span>' +
      `<input data-key="name" value="${escapeHtml(fd.name)}" maxlength="40" autocomplete="off" spellcheck="false" class="mono" placeholder="ör. MUSTERI_C" aria-describedby="folder-name-msg"${fd.busy ? ' disabled' : ''}></label>` +
      '<label class="fld"><span>Adınız (kayıt için, zorunlu)</span>' +
      `<input data-key="by" value="${escapeHtml(fd.by)}" maxlength="40" placeholder="ör. Ayşe"${byLocked()}${fd.busy ? ' disabled' : ''}></label>` +
      `<label class="fld"><span>Onaylamak için tezgahın kimliğini yazın: <b class="mono">${escapeHtml(fd.machineId ?? '')}</b></span>` +
      `<input data-key="confirm" value="${escapeHtml(fd.confirm)}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(fd.machineId ?? '')}" class="mono"${fd.busy ? ' disabled' : ''}></label>` +
      '</div>' +
      `<p class="hint" id="folder-name-msg" data-role="name-msg" aria-live="polite">${problem ? `✕ ${escapeHtml(problem)}` : 'İngilizce harf, rakam, _ - . ; en fazla 40 karakter.'}</p>` +
      (fd.known.length > 0
        ? `<p class="hint">Tezgahta bilinen klasörler (son taramadan): ${escapeHtml(fd.known.slice(0, 14).join(', '))}${fd.known.length > 14 ? ` … (+${fd.known.length - 14})` : ''}</p>`
        : '<p class="hint">Bu tezgah henüz taranmadı: mevcut klasörler bilinmiyor. Aynı ad varsa tezgah canlı kontrol edilip reddedilir.</p>') +
      `<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="create"${canCreate() ? '' : ' disabled'}>` +
      `${fd.busy ? 'Klasör açılıyor…' : 'Klasörü oluştur'}</button></div>`) +
    '</div></div>';
}

function wire() {
  dlg.addEventListener('change', async (ev) => {
    if (ev.target.dataset?.key !== 'machineId') return;
    fd.machineId = ev.target.value;
    fd.confirm = '';
    await loadKnown();
    render();
  });

  // Yazarken yeniden cizme (odak kaybolur): yalniz mesaji ve dugmeyi guncelle.
  dlg.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.key;
    if (key !== 'name' && key !== 'by' && key !== 'confirm') return;
    fd[key] = ev.target.value;
    if (key === 'by') userName.set(fd.by.trim());
    const msg = dlg.querySelector('[data-role="name-msg"]');
    if (msg) {
      const p = folderNameProblem(fd.name, fd.known);
      msg.textContent = p ? `✕ ${p}` : 'İngilizce harf, rakam, _ - . ; en fazla 40 karakter.';
    }
    const go = dlg.querySelector('[data-act="create"]');
    if (go) go.disabled = !canCreate();
  });

  dlg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') { if (!fd.busy) dlg.close(); return; }
    if (btn.dataset.act === 'again') { Object.assign(fd, { name: '', confirm: '', result: null, error: null }); await loadKnown(); render(); return; }
    if (btn.dataset.act !== 'create' || !canCreate()) return;
    fd.busy = true;
    fd.error = null;
    render();
    try {
      fd.result = await post(`/api/machines/${encodeURIComponent(fd.machineId)}/folders`, {
        name: fd.name.trim(), confirm: fd.confirm, by: fd.by.trim(),
      });
      announce();
      if (fd.result.status === 'basarili') await fd.onDone?.(fd.result.customer);
    } catch (err) {
      fd.error = `Klasör açma isteği başarısız: ${err.message}`;
    }
    fd.busy = false;
    render();
  });
}
