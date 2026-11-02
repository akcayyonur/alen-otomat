/**
 * "Program adini degistir" penceresi: kutuphanedeki bir programi AYNI musteri klasorunde yeniden adlandirir.
 * Surumler/icerik dokunulmaz, yalniz ad.
 *
 * Bu programin kopyasi olan tezgah YOKSA (matriste gorulmemisse) sunucuya yazma gerektirmez: "Yeni musteri
 * klasoru" gibi tezgah kimligi onayi istemez, Kaydet yeterlidir.
 *
 * Kopyasi olan tezgah VARSA (kullanici isteği, 2026-10-30): kaydedince kütüphanedeki ad degistiginde bu
 * tezgahlardaki dosyanin adi da FTP RNFR/RNTO ile degistirilir (icerik AYNEN kalir). Bu gercek bir tezgah
 * yazmasi oldugu icin ayrica onay ister: 1 tezgahta kimlik, >1 tezgahta SAYI (kutuphaneden toplu silmedeki
 * "yanlis secimi onler" deseniyle ayni). Bir tezgah calisan/secili programi koruma ya da canli veri
 * yoksa/model kapaliysa KENDI BASINA atlanabilir; bu durumda o tezgahta eski ad kalir (sonuc pencerede
 * gosterilir), digerlerini etkilemez.
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

/** 0 tezgah -> onay yok; 1 tezgah -> kimlik; >1 -> sayi (sunucudaki renameAcrossMachines ile ayni kural). */
export const expectedMachineConfirm = (holders) => (holders.length === 0 ? null : holders.length === 1 ? holders[0] : String(holders.length));

let dlg = null;
const rd = { program: null, holders: [], name: '', confirm: '', busy: false, error: null, onDone: null };

const canSave = () => {
  if (rd.busy || rd.name.trim() === '' || programRenameProblem(rd.name, rd.program.name) !== null) return false;
  const expected = expectedMachineConfirm(rd.holders);
  return expected === null || rd.confirm.trim() === expected;
};

/** @param {{program: object, holders?: string[], onDone?: (result: object) => void}} opts holders: bu programin kopyasi olan tezgah kimlikleri (matristen) */
export function openRenameDialog({ program, holders = [], onDone = null }) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('aria-labelledby', 'rename-title');
    document.body.append(dlg);
    dlg.addEventListener('cancel', (ev) => { if (rd.busy) ev.preventDefault(); });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg && !rd.busy) dlg.close(); });
    wire();
  }
  Object.assign(rd, { program, holders, name: program.name, confirm: '', busy: false, error: null, onDone });
  render();
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('[data-key="name"]')?.select();
}

function machineNote() {
  const n = rd.holders.length;
  if (n === 0) {
    return '<p class="hint">Bu program hiçbir tezgahın son taramasında görülmedi; değiştirilecek bir tezgah dosyası yok.</p>';
  }
  const expected = expectedMachineConfirm(rd.holders);
  return '<p class="hint">' +
    `Bu program şu tezgah${n > 1 ? 'lar' : ''}da bulundu (son taramaya göre): <span class="mono">${escapeHtml(rd.holders.join(', '))}</span>. ` +
    `Kaydedince bu tezgah${n > 1 ? 'lardaki' : 'taki'} dosyanın adı da değiştirilir (içerik aynen kalır); ` +
    'çalışan/seçili bir programsa ya da canlı veri yoksa o tezgah için atlanır, sonuç gösterilir.</p>' +
    '<div class="fld-grid">' +
    `<label class="fld"><span>Onay (${n === 1 ? 'tezgah kimliği' : 'tezgah sayısı'})</span>` +
    `<input data-key="confirm" value="${escapeHtml(rd.confirm)}" placeholder="${escapeHtml(expected)}" autocomplete="off" spellcheck="false" class="mono"${rd.busy ? ' disabled' : ''}></label>` +
    '</div>';
}

function render() {
  const problem = programRenameProblem(rd.name, rd.program.name);
  dlg.innerHTML =
    '<div class="modal-inner">' +
    `<header class="modal-head"><div><span class="eyebrow">${escapeHtml(folderLabel(rd.program.customer))}</span><h3 id="rename-title">Program adını değiştir</h3></div>` +
    `<button type="button" class="icon-btn" data-act="close"${rd.busy ? ' disabled' : ''}>Kapat</button></header>` +
    '<div class="modal-body">' +
    '<p class="hint">Kütüphane kaydının adı değişir; sürümler ve içerik aynen kalır.</p>' +
    (rd.error ? `<p class="notice notice-sim">${escapeHtml(rd.error)}</p>` : '') +
    '<div class="fld-grid">' +
    '<label class="fld"><span>Yeni ad</span>' +
    `<input data-key="name" value="${escapeHtml(rd.name)}" maxlength="40" autocomplete="off" spellcheck="false" class="mono" aria-describedby="rename-name-msg"${rd.busy ? ' disabled' : ''}></label>` +
    '</div>' +
    `<p class="hint" id="rename-name-msg" data-role="name-msg" aria-live="polite">${problem ? `✕ ${escapeHtml(problem)}` : 'İngilizce harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).'}</p>` +
    machineNote() +
    `<div class="dt-actions"><button type="button" class="icon-btn" data-act="close"${rd.busy ? ' disabled' : ''}>Vazgeç</button>` +
    `<button type="button" class="icon-btn btn-primary" data-act="save"${canSave() ? '' : ' disabled'}>${rd.busy ? 'Kaydediliyor…' : (rd.holders.length ? 'Kaydet ve tezgahlarda değiştir' : 'Kaydet')}</button></div>` +
    '</div></div>';
}

function wire() {
  // Yazarken yeniden cizme (odak kaybolur): yalniz mesaji ve dugmeyi guncelle.
  dlg.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.key;
    if (key === 'name') {
      rd.name = ev.target.value;
      const problem = programRenameProblem(rd.name, rd.program.name);
      const msg = dlg.querySelector('[data-role="name-msg"]');
      if (msg) msg.textContent = problem ? `✕ ${problem}` : 'İngilizce harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).';
    } else if (key === 'confirm') {
      rd.confirm = ev.target.value;
    } else {
      return;
    }
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
      if (result.renamed && rd.holders.length > 0) {
        try {
          result.machines = await post(`/api/library/programs/${rd.program.id}/rename-on-machines`, {
            customer: result.program.customer, oldName: result.oldName, newName: result.program.name,
            machineIds: rd.holders, confirm: rd.confirm.trim(),
          });
        } catch (err) {
          // Kutuphane adi ZATEN degisti (geri alinamaz); tezgah adimi basarisizsa bunu ayrica bildir.
          result.machinesError = err.message;
        }
      }
      dlg.close();
      await rd.onDone?.(result);
    } catch (err) {
      rd.busy = false;
      rd.error = err.message;
      render();
    }
  });
}
