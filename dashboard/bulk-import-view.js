/**
 * "Tüm programları kütüphaneye al": bir tornadaki bütün programları tek akışla kütüphaneye alma.
 *
 *   1. Plan   tornadan HER dosya FTP ile okunur (YALNIZ OKUMA; tornaya hiçbir şey yazılmaz) ve kütüphaneye göre
 *             sınıflandırılır. Arka planda çalışır; ilerleme gösterilir.
 *   2. İnceleme  Yeni · Zaten var · ÇAKIŞMA (aynı ad, farklı içerik) · Alınamayan. Çakışmalar OTOMATİK alınmaz:
 *             her biri için fark gösterilir ve "yeni sürüm olarak al" / "atla (kütüphanedekini koru)" seçilir.
 *   3. Uygula  kararlar kütüphaneye yazılır (içerik plandan gelir, tornaya tekrar bağlanılmaz).
 */
import { escapeHtml, num, dateTime } from './format.js';
import { api, post, userName, kb, announce, folderLabel } from './lib-common.js';
import { diffTable } from './diff-render.js';

const HINT = Object.freeze({
  'tezgah-yeni': ['tezgahtaki daha yeni', 'Tezgahtaki dosyanın tarihi, kütüphanedeki son sürümden sonra. Yalnızca ipucu: tezgah saati yanlış olabilir.'],
  'kutuphane-yeni': ['kütüphanedeki daha yeni', 'Kütüphanedeki son sürüm, tezgahtaki dosyadan sonra eklenmiş. Yalnızca ipucu.'],
  'ayni-gun': ['aynı gün', 'İki tarih bir günden az farklı.'],
});

let dlg = null;
const bi = {};
let timer = null;

const q = (sel) => dlg.querySelector(sel);
const normalize = (s) => s.replace(/\r\n?/g, '\n');
const fileLabel = (customer, name) => `${customer === '' ? '' : `${customer}\\`}${name}`;
const stopPolling = () => { clearTimeout(timer); timer = null; };

/** @param {{machineId: string, machineName?: string, knownFolders?: string[]}} opts */
export function openBulkImport({ machineId, machineName = '', knownFolders = [] }) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal modal-wide';
    dlg.setAttribute('aria-labelledby', 'bulk-title');
    document.body.append(dlg);
    wire();
  }
  stopPolling();
  for (const k of Object.keys(bi)) delete bi[k];
  Object.assign(bi, {
    machineId, machineName, folders: [...knownFolders].sort((a, b) => a.localeCompare(b, 'tr')), picked: new Set(knownFolders),
    phase: 'intro', planId: null, progress: null, plan: null, decisions: new Map(), skipFolders: new Set(),
    openDiff: null, diffs: new Map(), error: null, result: null, busy: false,
  });
  render();
  if (!dlg.open) dlg.showModal();
}

/* ------------------------------------------------------------------ akis */

async function startPlan() {
  bi.error = null;
  bi.phase = 'running';
  bi.progress = { phase: 'baslangic', done: 0, total: 0, folder: null };
  render();
  const allPicked = bi.folders.length === 0 || bi.picked.size === bi.folders.length;
  try {
    const r = await post(`/api/machines/${encodeURIComponent(bi.machineId)}/programs/import-plan`, allPicked ? {} : { folders: [...bi.picked] });
    bi.planId = r.planId;
    poll();
  } catch (err) {
    bi.phase = 'intro';
    bi.error = `Okuma başlatılamadı: ${err.message}`;
    render();
  }
}

function poll() {
  stopPolling();
  timer = setTimeout(async () => {
    if (!dlg?.open || bi.phase !== 'running') return;
    try {
      const r = await api(`/api/machines/${encodeURIComponent(bi.machineId)}/programs/import-plan/${encodeURIComponent(bi.planId)}`);
      bi.progress = r.progress;
      if (r.status === 'calisiyor') { updateProgress(); poll(); return; }
      if (r.status === 'hata') { bi.phase = 'intro'; bi.error = `Okuma başarısız: ${r.error}`; render(); return; }
      bi.plan = r.plan;
      // Varsayilan karar: cakismalar ATLANIR (kullanici bilincli secmedikce kutuphane degismez).
      bi.decisions = new Map(r.plan.cakisma.map((c) => [c.key, 'atla']));
      bi.skipFolders = new Set();
      bi.phase = 'review';
      render();
    } catch (err) {
      bi.phase = 'intro';
      bi.error = `Plan alınamadı: ${err.message}`;
      render();
    }
  }, 700);
}

function updateProgress() {
  const p = bi.progress;
  const bar = q('[data-role="bar"]');
  if (!bar) return;
  bar.max = Math.max(1, p.total);
  bar.value = p.done;
  q('[data-role="bar-text"]').textContent = p.phase === 'listeleme'
    ? 'Klasörler listeleniyor…'
    : p.phase === 'okuma'
      ? `Okunuyor: ${p.folder ?? ''} · ${num(p.done)} / ${num(p.total)} dosya`
      : p.phase === 'siniflandirma' ? 'Kütüphaneyle karşılaştırılıyor…' : 'Başlıyor…';
}

/* ----------------------------------------------------------------- seçimler */

const selectedCount = () => {
  if (!bi.plan) return { yeni: 0, al: 0 };
  const yeni = bi.plan.yeni.filter((y) => !bi.skipFolders.has(y.customer)).length;
  const al = bi.plan.cakisma.filter((c) => bi.decisions.get(c.key) === 'al').length;
  return { yeni, al };
};

function refreshApplyButton() {
  const btn = q('[data-act="apply"]');
  if (!btn) return;
  const { yeni, al } = selectedCount();
  btn.disabled = bi.busy || yeni + al === 0;
  btn.textContent = bi.busy ? 'Kütüphaneye yazılıyor…' : `Seçilenleri kütüphaneye al (${num(yeni + al)})`;
  const sub = q('[data-role="apply-sub"]');
  if (sub) sub.textContent = `${num(yeni)} yeni program` + (al ? ` · ${num(al)} çakışma yeni sürüm olarak` : '') + '. Tornaya hiçbir şey yazılmaz.';
}

async function apply() {
  bi.busy = true;
  bi.error = null;
  refreshApplyButton();
  try {
    const skipKeys = bi.plan.yeni.filter((y) => bi.skipFolders.has(y.customer)).map((y) => y.key);
    const decisions = Object.fromEntries([...bi.decisions].filter(([, v]) => v === 'al'));
    bi.result = await post(`/api/machines/${encodeURIComponent(bi.machineId)}/programs/import-apply`, {
      planId: bi.planId, decisions, skipKeys, by: userName.get(),
    });
    bi.phase = 'done';
    announce();
  } catch (err) {
    bi.error = `Kütüphaneye yazılamadı: ${err.message}`;
  }
  bi.busy = false;
  render();
}

async function toggleDiff(key) {
  if (bi.openDiff === key) { bi.openDiff = null; renderDiffRow(key, null); return; }
  const prev = bi.openDiff;
  bi.openDiff = key;
  if (prev) renderDiffRow(prev, null);
  renderDiffRow(key, '<p class="hint">Fark hazırlanıyor…</p>');
  try {
    if (!bi.diffs.has(key)) {
      bi.diffs.set(key, await api(`/api/machines/${encodeURIComponent(bi.machineId)}/programs/import-plan/${encodeURIComponent(bi.planId)}/diff?key=${encodeURIComponent(key)}`));
    }
    const d = bi.diffs.get(key);
    const t = diffTable(normalize(d.library.text), normalize(d.lathe.text), { cutNote: 'gösterilmiyor' });
    const baslik = `<p class="hint">Eski = <b>kütüphane v${d.library.versionNo}</b> (${escapeHtml(d.library.lineEnding)}, ${escapeHtml(d.library.encoding)}) · ` +
      `Yeni = <b>tezgahtaki dosya</b> (${escapeHtml(d.lathe.lineEnding)}, ${escapeHtml(d.lathe.encoding)})</p>`;
    const govde = t.html !== ''
      ? `<p class="hint"><b class="diff-add-t">+${num(t.added)}</b> satır tezgahta fazla · <b class="diff-del-t">−${num(t.removed)}</b> satır kütüphanede fazla</p>${t.html}`
      : `<p class="notice">Metin aynı; yalnızca <b>satır sonu/kodlama</b> farklı (tezgah: ${escapeHtml(d.lathe.lineEnding)}, kütüphane: ${escapeHtml(d.library.lineEnding)}).</p>`;
    if (bi.openDiff === key) renderDiffRow(key, baslik + govde);
  } catch (err) {
    if (bi.openDiff === key) renderDiffRow(key, `<p class="notice notice-sim">Fark alınamadı: ${escapeHtml(err.message)}</p>`);
  }
}

function renderDiffRow(key, html) {
  const row = [...dlg.querySelectorAll('tr[data-diff-for]')].find((r) => r.dataset.diffFor === key);
  if (!row) return;
  row.hidden = html === null;
  row.querySelector('td').innerHTML = html ?? '';
}

/* ----------------------------------------------------------------- çizim */

function chipHint(hint) {
  const h = HINT[hint];
  return h ? `<span class="chip chip-info" title="${escapeHtml(h[1])}">${escapeHtml(h[0])}</span>` : '';
}

function renderIntro() {
  return '<p class="notice">Tornadaki <b>tüm klasörler ve programlar</b> FTP ile <b>okunur</b>; tornaya hiçbir şey yazılmaz. ' +
    'Dosyalar sıralı ve kısa aralıklarla okunur (üretimi yormamak için); yüzlerce dosyada birkaç dakika sürebilir. ' +
    'Sonra neyin alınacağını siz görüp onaylarsınız. <b>Aynı adlı ama içeriği farklı</b> programlar otomatik alınmaz: farkı görüp karar verirsiniz.</p>' +
    (bi.folders.length > 0
      ? '<details class="grp"><summary><b>Klasör seç</b> (isteğe bağlı: varsayılan hepsi) · ' +
        `<span data-role="picked-count">${num(bi.picked.size)} / ${num(bi.folders.length)}</span></summary><div class="grp-body"><div class="mx-list">` +
        bi.folders.map((f) => `<label class="chk"><input type="checkbox" data-folder="${escapeHtml(f)}"${bi.picked.has(f) ? ' checked' : ''}> ${escapeHtml(f)}</label>`).join('') +
        '</div><p class="hint">Klasör seçerseniz kök dizindeki (ortak alan) dosyalar okunmaz ve tezgah envanteri tam yenilenmez.</p></div></details>'
      : '<p class="hint">Klasör listesi henüz bilinmiyor (tezgah taranmadı): hepsi okunur.</p>') +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="start"' +
    `${bi.folders.length > 0 && bi.picked.size === 0 ? ' disabled' : ''}>Okumayı başlat</button></div>`;
}

function renderRunning() {
  return '<p class="notice">Tornadan programlar okunuyor… Bu pencereyi kapatabilirsiniz; okuma arka planda sürer (30 dakika içinde bu tezgahın panelinden yeniden başlatmanız gerekir).</p>' +
    '<progress class="bi-progress" data-role="bar" value="0" max="1" aria-label="Okuma ilerlemesi"></progress>' +
    '<p class="hint" data-role="bar-text" aria-live="polite">Başlıyor…</p>';
}

function renderReview() {
  const p = bi.plan;
  const s = p.summary;
  const folders = new Map();
  for (const y of p.yeni) { if (!folders.has(y.customer)) folders.set(y.customer, []); folders.get(y.customer).push(y); }
  const names = [...folders.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'tr')));

  return '<div class="mx-list">' +
    `<span class="chip chip-info">＋ ${num(s.yeni)} yeni</span>` +
    `<span class="chip chip-ok">✓ ${num(s.ayni)} zaten kütüphanede</span>` +
    `<span class="chip ${s.cakisma ? 'chip-bad' : 'chip-none'}">≠ ${num(s.cakisma)} çakışma${s.eolOnly ? ` (${num(s.eolOnly)} yalnız satır sonu)` : ''}</span>` +
    `<span class="chip ${s.atlanan ? 'chip-warn' : 'chip-none'}">▲ ${num(s.atlanan)} alınamayan</span>` +
    `<span class="hint" style="margin:0">${num(s.listed)} dosya okundu · ${escapeHtml(kb(s.bytes))} · ${num(p.durationMs / 1000, 1)} sn</span></div>` +
    (p.warnings.length ? `<p class="notice">▲ ${escapeHtml(p.warnings.slice(0, 4).join('; '))}${p.warnings.length > 4 ? ` … (+${num(p.warnings.length - 4)})` : ''}</p>` : '') +

    // --- yeni programlar ---
    `<h4 class="sub">Yeni programlar (${num(s.yeni)}): kütüphanede yok, alınacak</h4>` +
    (s.yeni === 0 ? '<p class="empty">Yeni program yok.</p>' :
      names.map((c) => {
        const list = folders.get(c);
        return `<details class="grp"><summary><label class="chk" style="margin:0"><input type="checkbox" data-skip-folder="${escapeHtml(c)}"${bi.skipFolders.has(c) ? '' : ' checked'}> ` +
          `<b>${escapeHtml(folderLabel(c))}</b></label> · ${num(list.length)} program</summary><div class="grp-body">` +
          '<table class="tbl"><thead><tr><th>Program</th><th class="num">Boyut</th><th>Tezgah tarihi</th></tr></thead><tbody>' +
          list.map((y) => `<tr><td class="mono"><b>${escapeHtml(y.name)}</b></td><td class="num">${escapeHtml(kb(y.size))}</td><td>${escapeHtml(y.modified ?? '—')}</td></tr>`).join('') +
          '</tbody></table></div></details>';
      }).join('')) +

    // --- cakismalar ---
    `<h4 class="sub">Çakışmalar (${num(s.cakisma)}): aynı ad, içerik farklı</h4>` +
    (s.cakisma === 0 ? '<p class="empty">Çakışma yok.</p>' :
      '<p class="hint">Hiçbiri otomatik alınmaz. <b>Yeni sürüm olarak al</b>: tezgahtaki hâl kütüphanede yeni sürüm olur (eski sürümler durur). ' +
      '<b>Atla</b>: kütüphane değişmez; tezgahtaki dosya "farklı" görünmeye devam eder.</p>' +
      '<div class="dt-actions" style="margin-bottom:8px">' +
      '<button type="button" class="icon-btn icon-btn-sm" data-act="all-al">Hepsini yeni sürüm olarak al</button>' +
      '<button type="button" class="icon-btn icon-btn-sm" data-act="all-atla">Hepsini atla</button>' +
      (s.eolOnly ? '<button type="button" class="icon-btn icon-btn-sm" data-act="eol-al">Yalnız satır sonu farklıları al</button>' : '') + '</div>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>Program</th><th>Tezgahta</th><th>Kütüphanede (son)</th><th>İpucu</th><th>Karar</th><th></th></tr></thead><tbody>' +
      p.cakisma.map((c, i) => {
        const karar = bi.decisions.get(c.key) ?? 'atla';
        const radio = (v, label) => `<label class="chk" style="margin:0"><input type="radio" name="d${i}" data-decide="${escapeHtml(c.key)}" value="${v}"${karar === v ? ' checked' : ''}> ${label}</label>`;
        return `<tr data-key="${escapeHtml(c.key)}"><td class="mono"><b>${escapeHtml(fileLabel(c.customer, c.name))}</b></td>` +
          `<td>${escapeHtml(kb(c.size))}<br><small class="hint">${escapeHtml(c.modified ?? '—')}</small></td>` +
          `<td>v${c.libraryVersion} · ${escapeHtml(kb(c.librarySize))}<br><small class="hint">${escapeHtml(dateTime(c.libraryCreatedAt))}</small></td>` +
          `<td>${c.eolOnlyVersion != null ? '<span class="chip chip-none" title="Metin kütüphanedeki bir sürümle aynı; yalnızca satır sonu (CRLF/LF) farklı.">yalnız satır sonu</span> ' : ''}${chipHint(c.hint)}</td>` +
          `<td>${radio('al', 'Yeni sürüm olarak al')}<br>${radio('atla', 'Atla')}</td>` +
          `<td><button type="button" class="icon-btn icon-btn-sm" data-act="diff" data-key="${escapeHtml(c.key)}">Farkı göster</button></td></tr>` +
          `<tr data-diff-for="${escapeHtml(c.key)}" hidden><td colspan="6"></td></tr>`;
      }).join('') + '</tbody></table></div>') +

    // --- alinamayanlar ---
    (s.atlanan === 0 ? '' :
      `<details class="grp"><summary><b>Alınamayanlar (${num(s.atlanan)})</b> · ad kuralına uymayan, çok büyük, boş ya da ikili dosyalar</summary><div class="grp-body">` +
      '<table class="tbl"><thead><tr><th>Dosya</th><th>Neden</th></tr></thead><tbody>' +
      p.atlanan.map((a) => `<tr><td class="mono">${escapeHtml(fileLabel(a.customer, a.name))}</td><td>${escapeHtml(a.reason)}</td></tr>`).join('') +
      '</tbody></table></div></details>') +

    '<div class="confirm-box"><p class="hint" data-role="apply-sub" style="margin:0"></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="apply">Seçilenleri kütüphaneye al</button></div></div>';
}

function renderDone() {
  const r = bi.result;
  const toplam = r.yeniProgram + r.yeniSurum;
  return `<div class="result result-${r.hatalar.length ? 'warn' : 'ok'}"><span class="result-ic" aria-hidden="true">${r.hatalar.length ? '▲' : '✓'}</span><div>` +
    `<b>${num(toplam)} program kütüphaneye alındı.</b>` +
    `<p>${num(r.yeniProgram)} yeni program · ${num(r.yeniSurum)} mevcut programa yeni sürüm · ${num(r.zatenVardi)} zaten kütüphanedeydi · ${num(r.atlanan)} alınmadı (atlanan).</p>` +
    `<p>Tornaya hiçbir şey yazılmadı. Tezgahın matrisi güncellendi.</p></div></div>` +
    (r.hatalar.length ? `<h4 class="sub">Hatalar (${num(r.hatalar.length)})</h4><ul class="checks">` +
      r.hatalar.slice(0, 30).map((h) => `<li class="check check-block"><span class="check-ic" aria-hidden="true">✕</span><div><b>${escapeHtml(fileLabel(h.customer, h.name))}</b><p>${escapeHtml(h.error)}</p></div></li>`).join('') + '</ul>' : '') +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>';
}

function render() {
  const body = bi.phase === 'intro' ? renderIntro()
    : bi.phase === 'running' ? renderRunning()
      : bi.phase === 'review' ? renderReview() : renderDone();
  dlg.innerHTML =
    '<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">Kütüphane · yalnızca okuma</span>' +
    `<h3 id="bulk-title">Tüm programları kütüphaneye al · ${escapeHtml(bi.machineName || bi.machineId)}</h3></div>` +
    `<button type="button" class="icon-btn" data-act="close"${bi.busy ? ' disabled' : ''}>Kapat</button></header>` +
    '<div class="modal-body">' +
    (bi.error ? `<p class="notice notice-sim">${escapeHtml(bi.error)}</p>` : '') + body + '</div></div>';
  if (bi.phase === 'review') refreshApplyButton();
  if (bi.phase === 'running') updateProgress();
}

/* ----------------------------------------------------------------- olaylar */

function wire() {
  dlg.addEventListener('cancel', (ev) => { if (bi.busy) ev.preventDefault(); else stopPolling(); });
  dlg.addEventListener('close', stopPolling);

  dlg.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset?.folder !== undefined) {
      if (t.checked) bi.picked.add(t.dataset.folder); else bi.picked.delete(t.dataset.folder);
      q('[data-role="picked-count"]').textContent = `${num(bi.picked.size)} / ${num(bi.folders.length)}`;
      q('[data-act="start"]').disabled = bi.picked.size === 0;
    } else if (t.dataset?.skipFolder !== undefined) {
      if (t.checked) bi.skipFolders.delete(t.dataset.skipFolder); else bi.skipFolders.add(t.dataset.skipFolder);
      refreshApplyButton();
    } else if (t.dataset?.decide !== undefined) {
      bi.decisions.set(t.dataset.decide, t.value);
      refreshApplyButton();
    }
  });

  dlg.addEventListener('click', async (ev) => {
    // <summary> icindeki onay kutusu details'i acip kapatmasin
    if (ev.target.matches?.('[data-skip-folder]')) ev.stopPropagation();
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const setAll = (fn) => {
      for (const c of bi.plan.cakisma) bi.decisions.set(c.key, fn(c) ? 'al' : 'atla');
      for (const r of dlg.querySelectorAll('input[data-decide]')) {
        const c = bi.plan.cakisma.find((x) => x.key === r.dataset.decide);
        r.checked = r.value === bi.decisions.get(c.key);
      }
      refreshApplyButton();
    };
    switch (btn.dataset.act) {
      case 'close': if (!bi.busy) { stopPolling(); dlg.close(); } break;
      case 'start': await startPlan(); break;
      case 'apply': await apply(); break;
      case 'diff': await toggleDiff(btn.dataset.key); break;
      case 'all-al': setAll(() => true); break;
      case 'all-atla': setAll(() => false); break;
      case 'eol-al': setAll((c) => c.eolOnlyVersion != null); break;
      default: break;
    }
  });
}
