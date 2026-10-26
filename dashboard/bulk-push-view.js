/**
 * "Toplu gönder": kütüphanedeki programların SON sürümlerini bir tornaya topluca yazar; tornada aynı adlı FARKLI içerik varsa
 * üzerine yazar, ama ÖNCE tornadaki hâli kütüphaneye yedekler.
 *
 *   1. Plan       tornaya YALNIZ OKUMA yapılır: her kütüphane programı için yeni / ezilecek / zaten aynı / atlanan sınıflanır.
 *   2. İnceleme   neyin yazılacağı, neyin yedekleneceği görülür; klasör bazında çıkarılabilir. Onay = tornanın adını yazmak.
 *   3. Uygula     arka planda sürer (yüzlerce program), ilerleme görünür, durdurulabilir; pencere kapatılsa da devam eder.
 *   4. Sonuç      yazılan / ezilen / atlanan / hata; durmuş ya da yarım kalan iş için planı yeniden çıkarmak kaldığı yerden sürdürür.
 * Dokunulmayanlar: tornada olup kütüphanede olmayan programlar, kök dizindeki (ortak alan) programlar, çalışan program.
 */
import { escapeHtml, num, dateTime } from './format.js';
import { api, post, userName, kb, announce, folderLabel } from './lib-common.js';

let dlg = null;
const bp = {};
let timer = null;
/** Torna -> açık plan kimliği: pencere kapansa da iş sürer; yeniden açılınca kaldığı yerden gösterilir. */
const active = new Map();

const q = (sel) => dlg.querySelector(sel);
const fileLabel = (customer, name) => `${customer === '' ? '' : `${customer}\\`}${name}`;
const stopPolling = () => { clearTimeout(timer); timer = null; };
const base = () => `/api/machines/${encodeURIComponent(bp.machineId)}/programs`;

const OUTCOME = Object.freeze({
  yeni: { icon: '＋', label: 'yeni yazıldı', cls: 'ok' },
  ezildi: { icon: '⇄', label: 'ezildi (yedekli)', cls: 'info' },
  ayni: { icon: '✓', label: 'zaten aynı', cls: 'ok' },
  atlandi: { icon: '▲', label: 'atlandı', cls: 'warn' },
  hata: { icon: '✕', label: 'hata', cls: 'bad' },
});

/** @param {{machineId: string, machineName?: string, knownFolders?: string[], blockedReason?: string|null}} opts */
export function openBulkPush({ machineId, machineName = '', knownFolders = [], blockedReason = null }) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal modal-wide';
    dlg.setAttribute('aria-labelledby', 'push-title');
    document.body.append(dlg);
    wire();
  }
  stopPolling();
  for (const k of Object.keys(bp)) delete bp[k];
  Object.assign(bp, {
    machineId, machineName, blockedReason, folders: [...knownFolders].sort((a, b) => a.localeCompare(b, 'tr')), picked: new Set(knownFolders),
    phase: 'intro', planId: null, progress: null, plan: null, apply: null, skipFolders: new Set(), ack: false, confirm: '', error: null, busy: false,
  });
  if (!dlg.open) dlg.showModal();
  const known = active.get(machineId);
  if (known) { bp.planId = known; bp.phase = 'planning'; render(); poll(0); } else render();
}

/* ------------------------------------------------------------------ akış */

async function startPlan() {
  bp.error = null;
  bp.phase = 'planning';
  bp.progress = { phase: 'baslangic', done: 0, total: 0, folder: null };
  render();
  const allPicked = bp.folders.length === 0 || bp.picked.size === bp.folders.length;
  try {
    const r = await post(`${base()}/push-plan`, allPicked ? {} : { folders: [...bp.picked] });
    bp.planId = r.planId;
    active.set(bp.machineId, r.planId);
    poll();
  } catch (err) {
    bp.phase = 'intro';
    bp.error = `Plan başlatılamadı: ${err.message}`;
    render();
  }
}

function poll(delay = 800) {
  stopPolling();
  timer = setTimeout(async () => {
    if (!dlg?.open || !['planning', 'applying'].includes(bp.phase)) return;
    try {
      const r = await api(`${base()}/push-plan/${encodeURIComponent(bp.planId)}`);
      absorb(r);
    } catch (err) {
      if (err.status === 404) { active.delete(bp.machineId); bp.phase = 'intro'; bp.error = 'Plan süresi doldu ya da sunucu yeniden başlatıldı. Planı yeniden çıkarın.'; render(); return; }
      bp.error = `Durum alınamadı: ${err.message}`;
      poll(2000);
    }
  }, delay);
}

/** Sunucudan gelen durumu ekrana yansıtır. */
function absorb(r) {
  bp.progress = r.progress;
  if (r.status === 'hata') { active.delete(bp.machineId); bp.phase = 'intro'; bp.error = `Plan başarısız: ${r.error}`; render(); return; }
  if (r.status === 'calisiyor') { updatePlanning(); poll(); return; }
  const first = bp.plan === null;
  bp.plan = r.plan;
  bp.apply = r.apply;
  if (r.apply) {
    const was = bp.phase;
    bp.phase = r.apply.status === 'calisiyor' ? 'applying' : 'done';
    if (bp.phase === 'applying') { if (was !== 'applying') render(); else updateApplying(); poll(1000); return; }
    render();
    announce(); // matris/envanter degisti
    return;
  }
  bp.phase = 'review';
  if (first) bp.skipFolders = new Set();
  render();
}

async function startApply() {
  bp.busy = true;
  bp.error = null;
  refreshApply();
  try {
    const skipKeys = [...bp.plan.yeni, ...bp.plan.ezilecek].filter((x) => bp.skipFolders.has(x.customer)).map((x) => x.key);
    await post(`${base()}/push-apply`, {
      planId: bp.planId, confirm: bp.confirm.trim(), by: userName.get(), skipKeys, acks: bp.ack ? ['unknown-state'] : [],
    });
    bp.phase = 'applying';
    bp.apply = { status: 'calisiyor', done: 0, total: 0, counts: {}, results: [], current: null };
    bp.busy = false;
    render();
    poll(400);
  } catch (err) {
    bp.busy = false;
    bp.error = `Gönderme başlatılamadı: ${err.message}`;
    render();
  }
}

async function stopApply() {
  const btn = q('[data-act="stop"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Durduruluyor…'; }
  try { await post(`${base()}/push-stop`, { planId: bp.planId }); } catch (err) { bp.error = `Durdurulamadı: ${err.message}`; render(); }
}

/* ----------------------------------------------------------------- seçimler */

const selected = () => {
  if (!bp.plan) return { yeni: 0, ezilecek: 0, yedek: 0 };
  const ok = (x) => !bp.skipFolders.has(x.customer);
  return {
    yeni: bp.plan.yeni.filter(ok).length,
    ezilecek: bp.plan.ezilecek.filter(ok).length,
    yedek: bp.plan.ezilecek.filter((x) => ok(x) && x.needsBackup).length,
  };
};

function applyBlocked() {
  const p = bp.plan;
  if (!p) return 'Plan yok';
  if (!p.gate.transferEnabled) return 'Gönderme kapalı (TRANSFER_DISABLED=1)';
  if (!p.gate.allowed) return p.gate.reason ?? 'Bu kontrolcü modelinde gönderme kapalı';
  return null;
}

function refreshApply() {
  const btn = q('[data-act="apply"]');
  if (!btn) return;
  const sel = selected();
  const total = sel.yeni + sel.ezilecek;
  const need = bp.plan.unknownState && !bp.ack;
  const blocked = applyBlocked();
  btn.disabled = bp.busy || blocked !== null || total === 0 || need || bp.confirm.trim() !== bp.machineId;
  btn.textContent = bp.busy ? 'Başlatılıyor…' : `Gönder (${num(total)} program)`;
  const sub = q('[data-role="apply-sub"]');
  if (sub) {
    sub.innerHTML = `<b>${num(total)}</b> program yazılacak: ${num(sel.yeni)} yeni, ${num(sel.ezilecek)} mevcut dosyanın üzerine` +
      (sel.yedek ? ` (<b>${num(sel.yedek)}</b> tanesinin tornadaki hâli ÖNCE kütüphaneye yedeklenecek)` : '') +
      '. Programlar tornaya yazılır ama <b>aktif olmaz</b>; operatör panelden seçer.';
  }
}

/* ----------------------------------------------------------------- çizim */

function renderIntro() {
  return '<p class="notice">Kütüphanedeki her programın <b>son sürümü</b> bu tornaya yazılır. Tornada <b>aynı adlı ama içeriği farklı</b> bir dosya varsa onun üzerine yazılır; ' +
    '<b>ezilmeden önce tornadaki hâli kütüphaneye yedeklenir</b> (program sayfasında "Tornalardan alınan yedekler"). ' +
    'Tornada olup kütüphanede olmayan programlara, kök dizindeki ortak programlara (ör. O9001) ve şu an çalışan programa <b>dokunulmaz</b>. ' +
    'Müşteri klasörü tornada yoksa o program atlanır (klasör açılmaz).</p>' +
    '<p class="hint">Önce <b>plan</b> çıkarılır: tornaya yalnız okuma yapılır, hiçbir şey yazılmaz. Neyin yazılacağını görüp onaylarsınız.</p>' +
    (bp.blockedReason ? `<p class="notice notice-sim">Bu tornada şu an gönderme kapalı: ${escapeHtml(bp.blockedReason)} Plan yine de çıkarılabilir (yalnız okuma).</p>` : '') +
    (bp.folders.length > 0
      ? '<details class="grp"><summary><b>Klasör seç</b> (isteğe bağlı: varsayılan hepsi) · ' +
        `<span data-role="picked-count">${num(bp.picked.size)} / ${num(bp.folders.length)}</span></summary><div class="grp-body"><div class="mx-list">` +
        bp.folders.map((f) => `<label class="chk"><input type="checkbox" data-folder="${escapeHtml(f)}"${bp.picked.has(f) ? ' checked' : ''}> ${escapeHtml(f)}</label>`).join('') +
        '</div></div></details>'
      : '<p class="hint">Klasör listesi henüz bilinmiyor (tezgah taranmadı): hepsi okunur.</p>') +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="plan"' +
    `${bp.folders.length > 0 && bp.picked.size === 0 ? ' disabled' : ''}>Planı çıkar</button></div>`;
}

function renderPlanning() {
  return '<p class="notice">Tornadaki klasörler ve dosyalar okunuyor (yalnız okuma)… Bu pencereyi kapatabilirsiniz; plan arka planda hazırlanır, bu tezgahın panelinden tekrar açın.</p>' +
    '<progress class="bi-progress" data-role="bar" value="0" max="1" aria-label="Plan ilerlemesi"></progress>' +
    '<p class="hint" data-role="bar-text" aria-live="polite">Başlıyor…</p>';
}

function updatePlanning() {
  const p = bp.progress;
  const bar = q('[data-role="bar"]');
  if (!bar || !p) return;
  bar.max = Math.max(1, p.total);
  bar.value = p.done;
  q('[data-role="bar-text"]').textContent = p.phase === 'listeleme' ? 'Klasörler listeleniyor…'
    : p.phase === 'okuma' ? `Karşılaştırma için okunuyor: ${p.folder ?? ''} · ${num(p.done)} / ${num(p.total)} dosya`
      : p.phase === 'siniflandirma' ? 'Kütüphaneyle karşılaştırılıyor…' : 'Başlıyor…';
}

function programRow(x, kind) {
  const lathe = kind === 'yeni'
    ? '<span class="is-null">—</span>'
    : `${escapeHtml(kb(x.latheSize))}<br><small class="hint">${escapeHtml(x.modified ?? '—')}</small>`;
  const backup = kind === 'yeni' ? '' : x.needsBackup
    ? '<span class="chip chip-warn" title="Tornadaki hâl kütüphanedeki hiçbir sürümle tutmuyor: ezilmeden önce yedeklenecek.">yedeklenecek</span>'
    : `<span class="chip chip-ok" title="Tornadaki hâl kütüphanede zaten bu sürüm olarak var.">kütüphanede v${x.latheVersionNo}</span>`;
  return `<tr><td class="mono"><b>${escapeHtml(x.name)}</b></td>` +
    `<td>${kind === 'yeni' ? '<span class="chip chip-info">＋ yeni</span>' : '<span class="chip chip-warn">⇄ ezilecek</span>'}</td>` +
    `<td>${lathe}</td><td>v${x.versionNo} · ${escapeHtml(kb(x.size))}</td><td>${backup}</td></tr>`;
}

function renderReview() {
  const p = bp.plan;
  const s = p.summary;
  const folders = new Map();
  for (const x of p.yeni) { if (!folders.has(x.customer)) folders.set(x.customer, { yeni: [], ez: [] }); folders.get(x.customer).yeni.push(x); }
  for (const x of p.ezilecek) { if (!folders.has(x.customer)) folders.set(x.customer, { yeni: [], ez: [] }); folders.get(x.customer).ez.push(x); }
  const names = [...folders.keys()].sort((a, b) => a.localeCompare(b, 'tr'));
  const blocked = applyBlocked();

  return '<div class="mx-list">' +
    `<span class="chip chip-info">＋ ${num(s.yeni)} yeni</span>` +
    `<span class="chip ${s.ezilecek ? 'chip-warn' : 'chip-none'}">⇄ ${num(s.ezilecek)} ezilecek${s.yedeklenecek ? ` (${num(s.yedeklenecek)} yedeklenecek)` : ''}</span>` +
    `<span class="chip chip-ok">✓ ${num(s.ayni)} zaten aynı</span>` +
    `<span class="chip ${s.atlanan ? 'chip-warn' : 'chip-none'}">▲ ${num(s.atlanan)} atlanan</span>` +
    `<span class="chip chip-none" title="Tornada olup kütüphanede olmayan programlara dokunulmaz.">${num(s.tornadaOzel)} tornaya özel (dokunulmaz)</span>` +
    `<span class="hint" style="margin:0">${num(s.kutuphane)} kütüphane programı · ${num(p.durationMs / 1000, 1)} sn${s.kokKutuphane ? ` · kök dizinde ${num(s.kokKutuphane)} program toplu gönderime girmez` : ''}</span></div>` +
    (blocked ? `<p class="notice notice-sim"><b>Gönderilemez:</b> ${escapeHtml(blocked)}</p>` : '') +
    (p.unknownState ? '<p class="notice notice-sim">▲ Tezgahtan canlı veri gelmiyor (ajan kapalı olabilir): <b>çalışan program bilinemiyor</b>, bu yüzden çalışan programın üzerine yazılmasını önleyemem. ' +
      'Aşağıdaki kutuyu işaretleyerek bunu bilerek kabul etmeniz gerekir.</p>' : '') +
    (p.warnings.length ? `<p class="notice">▲ ${escapeHtml(p.warnings.slice(0, 4).join('; '))}${p.warnings.length > 4 ? ` … (+${num(p.warnings.length - 4)})` : ''}</p>` : '') +

    `<h4 class="sub">Yazılacaklar (${num(s.yeni + s.ezilecek)})</h4>` +
    (names.length === 0 ? '<p class="empty">Yazılacak program yok: bu torna kütüphaneyle aynı ya da hepsi atlandı.</p>' :
      '<p class="hint">Klasör kutusunu kaldırırsanız o klasördeki programlar bu seferlik gönderilmez.</p>' +
      names.map((c) => {
        const f = folders.get(c);
        return `<details class="grp"><summary><label class="chk" style="margin:0"><input type="checkbox" data-skip-folder="${escapeHtml(c)}"${bp.skipFolders.has(c) ? '' : ' checked'}> ` +
          `<b>${escapeHtml(folderLabel(c))}</b></label> · ${num(f.yeni.length)} yeni · ${num(f.ez.length)} ezilecek</summary><div class="grp-body">` +
          '<table class="tbl"><thead><tr><th>Program</th><th>İşlem</th><th>Tornada</th><th>Gönderilecek</th><th>Yedek</th></tr></thead><tbody>' +
          f.ez.map((x) => programRow(x, 'ezilecek')).join('') + f.yeni.map((x) => programRow(x, 'yeni')).join('') +
          '</tbody></table></div></details>';
      }).join('')) +

    (s.atlanan === 0 ? '' :
      `<details class="grp"><summary><b>Atlananlar (${num(s.atlanan)})</b> · gönderilmeyecek</summary><div class="grp-body">` +
      '<table class="tbl"><thead><tr><th>Program</th><th>Neden</th></tr></thead><tbody>' +
      p.atlanan.map((a) => `<tr><td class="mono">${escapeHtml(fileLabel(a.customer, a.name))}</td><td>${escapeHtml(a.reason)}</td></tr>`).join('') +
      '</tbody></table></div></details>') +
    (s.tornadaOzel === 0 ? '' :
      `<details class="grp"><summary><b>Tornaya özel (${num(s.tornadaOzel)})</b> · kütüphanede yok, dokunulmaz</summary><div class="grp-body">` +
      '<p class="hint">Bunları "Tüm programları kütüphaneye al…" ile kütüphaneye alıp düzenledikten sonra tüm tornalara gönderebilirsiniz.</p>' +
      '<table class="tbl"><thead><tr><th>Program</th><th class="num">Boyut</th></tr></thead><tbody>' +
      p.tornadaOzel.map((a) => `<tr><td class="mono">${escapeHtml(fileLabel(a.customer, a.name))}</td><td class="num">${escapeHtml(kb(a.size))}</td></tr>`).join('') +
      '</tbody></table>' + (s.tornadaOzel > p.tornadaOzel.length ? `<p class="hint">… ve ${num(s.tornadaOzel - p.tornadaOzel.length)} tane daha</p>` : '') + '</div></details>') +

    '<div class="confirm-box"><p class="hint" data-role="apply-sub" style="margin:0"></p>' +
    (p.unknownState ? `<label class="chk"><input type="checkbox" data-ack${bp.ack ? ' checked' : ''}> Canlı veri yok; çalışan program bilinemese de devam etmek istiyorum</label>` : '') +
    `<label class="fld"><span>Onaylamak için tornanın adını yazın: <b class="mono">${escapeHtml(bp.machineId)}</b></span>` +
    `<input type="text" data-role="confirm" autocomplete="off" spellcheck="false" value="${escapeHtml(bp.confirm)}" placeholder="${escapeHtml(bp.machineId)}"></label>` +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="apply" disabled>Gönder</button>' +
    '<button type="button" class="icon-btn" data-act="replan">Planı yenile</button></div></div>';
}

function countChips(c) {
  const n = (v) => num(v ?? 0);
  return '<div class="mx-list">' +
    `<span class="chip chip-info">＋ ${n(c.yeni)} yeni</span>` +
    `<span class="chip chip-info">⇄ ${n(c.ezilen)} ezildi</span>` +
    `<span class="chip chip-ok">✓ ${n(c.ayni)} aynı</span>` +
    `<span class="chip ${c.atlanan ? 'chip-warn' : 'chip-none'}">▲ ${n(c.atlanan)} atlandı</span>` +
    `<span class="chip ${c.hata ? 'chip-bad' : 'chip-none'}">✕ ${n(c.hata)} hata</span>` +
    `<span class="chip chip-none" title="Tornadaki eski hâl kütüphaneye yedeklendi">${n(c.yedeklendi)} yedek alındı</span></div>`;
}

function resultRow(r) {
  const o = r.status === 'dogrulanamadi' ? { icon: '▲', label: 'doğrulanamadı', cls: 'bad' } : (OUTCOME[r.outcome] ?? { icon: '·', label: r.outcome, cls: 'none' });
  const yedek = r.backup?.kind === 'yedek' ? `yedek #${r.backup.id}` : r.backup?.kind === 'surum' ? `kütüphanede v${r.backup.versionNo}` : '';
  return `<tr><td class="mono"><b>${escapeHtml(fileLabel(r.customer, r.name))}</b></td>` +
    `<td><span class="chip chip-${o.cls}"><span aria-hidden="true">${o.icon}</span> ${escapeHtml(o.label)}</span></td>` +
    `<td>${escapeHtml(yedek)}</td><td>${escapeHtml([r.detail, r.warning].filter(Boolean).join(' · '))}</td></tr>`;
}

function renderApplying() {
  return '<p class="notice">Programlar tornaya yazılıyor. Bu pencereyi kapatabilirsiniz; iş arka planda sürer (bu tezgahın panelinden "Toplu gönder…" ile tekrar açabilirsiniz). ' +
    'Üretimi yormamak için programlar aralıklı yazılır.</p>' +
    '<div data-role="apply-body"></div>' +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-danger" data-act="stop">Durdur</button></div>';
}

function updateApplying() {
  const a = bp.apply;
  const host = q('[data-role="apply-body"]');
  if (!host || !a) return;
  host.innerHTML =
    `<progress class="bi-progress" value="${a.done ?? 0}" max="${Math.max(1, a.total ?? 1)}" aria-label="Gönderme ilerlemesi"></progress>` +
    `<p class="hint" aria-live="polite">${num(a.done ?? 0)} / ${num(a.total ?? 0)} program${a.current ? ` · şu an: <span class="mono">${escapeHtml(a.current)}</span>` : ''}${a.stopRequested ? ' · durduruluyor…' : ''}</p>` +
    countChips(a.counts ?? {}) +
    ((a.results ?? []).length ? '<h4 class="sub">Son işlemler</h4><table class="tbl"><thead><tr><th>Program</th><th>Sonuç</th><th>Yedek</th><th>Ayrıntı</th></tr></thead><tbody>' +
      [...a.results].reverse().map(resultRow).join('') + '</tbody></table>' : '');
  const stop = q('[data-act="stop"]');
  if (stop && a.stopRequested) { stop.disabled = true; stop.textContent = 'Durduruluyor…'; }
}

function renderDone() {
  const a = bp.apply;
  const c = a.counts ?? {};
  const bad = (a.results ?? []).filter((r) => r.outcome === 'hata');
  const skipped = (a.results ?? []).filter((r) => r.outcome === 'atlandi');
  const left = (a.results ?? []).filter((r) => r.warning);
  const stopped = a.status === 'durduruldu';
  const failed = a.status === 'hata';
  const cls = failed || bad.length ? 'warn' : 'ok';
  const written = (c.yeni ?? 0) + (c.ezilen ?? 0);
  return `<div class="result result-${stopped || failed ? 'warn' : cls}"><span class="result-ic" aria-hidden="true">${cls === 'ok' && !stopped && !failed ? '✓' : '▲'}</span><div>` +
    `<b>${failed ? 'Toplu gönderme hata ile bitti' : stopped ? 'Toplu gönderme DURDURULDU' : 'Toplu gönderme bitti'}: ${num(written)} program yazıldı.</b>` +
    `<p>${num(c.yeni ?? 0)} yeni · ${num(c.ezilen ?? 0)} mevcut dosyanın üzerine (${num(c.yedeklendi ?? 0)} yedek alındı) · ${num(c.ayni ?? 0)} zaten aynıydı · ${num(c.atlanan ?? 0)} atlandı · ${num(c.hata ?? 0)} hata.</p>` +
    `<p>${num(a.done ?? 0)} / ${num(a.total ?? 0)} program işlendi${stopped ? '; kalanlara dokunulmadı' : ''}. ${failed ? escapeHtml(a.error ?? '') : ''}</p>` +
    '<p>Yazılan programlar tornada <b>aktif olmaz</b>; operatör panelden seçer. Her program için denetim kaydı tutuldu (Program kütüphanesi › Gönderme geçmişi).</p></div></div>' +
    (left.length ? `<p class="notice notice-sim">▲ ${num(left.length)} programın yan adlı eski dosyası (ZZRB…) tornada SİLİNEMEDİ ve duruyor; içerikleri kütüphanede yedekli, panelden elle silinebilir.</p>` : '') +
    (bad.length ? `<h4 class="sub">Hatalar (${num(bad.length)}): tornadaki dosyalar eski hâlinde bırakıldı</h4><ul class="checks">` +
      bad.slice(0, 40).map((r) => `<li class="check check-block"><span class="check-ic" aria-hidden="true">✕</span><div><b>${escapeHtml(fileLabel(r.customer, r.name))}</b><p>${escapeHtml(r.detail ?? '')}</p></div></li>`).join('') + '</ul>' : '') +
    (skipped.length ? `<details class="grp"><summary><b>Atlananlar (${num(skipped.length)})</b> · yazılmadı</summary><div class="grp-body"><table class="tbl"><thead><tr><th>Program</th><th>Neden</th></tr></thead><tbody>` +
      skipped.map((r) => `<tr><td class="mono">${escapeHtml(fileLabel(r.customer, r.name))}</td><td>${escapeHtml(r.detail ?? '')}</td></tr>`).join('') + '</tbody></table></div></details>' : '') +
    `<details class="grp"><summary><b>Tüm sonuçlar (${num((a.results ?? []).length)})</b></summary><div class="grp-body"><table class="tbl"><thead><tr><th>Program</th><th>Sonuç</th><th>Yedek</th><th>Ayrıntı</th></tr></thead><tbody>` +
    (a.results ?? []).slice(0, 1000).map(resultRow).join('') + '</tbody></table></div></details>' +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="replan">' +
    `${stopped || bad.length || skipped.length ? 'Kalanlar için yeni plan çıkar' : 'Yeni plan çıkar'}</button><button type="button" class="icon-btn" data-act="close">Kapat</button></div>`;
}

function render() {
  const body = bp.phase === 'intro' ? renderIntro()
    : bp.phase === 'planning' ? renderPlanning()
      : bp.phase === 'review' ? renderReview()
        : bp.phase === 'applying' ? renderApplying() : renderDone();
  dlg.innerHTML =
    '<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">Kütüphane → tornaya yazma · yedekleyerek ezer</span>' +
    `<h3 id="push-title">Toplu gönder · ${escapeHtml(bp.machineName || bp.machineId)}</h3></div>` +
    '<button type="button" class="icon-btn" data-act="close">Kapat</button></header>' +
    '<div class="modal-body">' + (bp.error ? `<p class="notice notice-sim">${escapeHtml(bp.error)}</p>` : '') + body + '</div></div>';
  if (bp.phase === 'review') refreshApply();
  if (bp.phase === 'planning') updatePlanning();
  if (bp.phase === 'applying') updateApplying();
}

/* ----------------------------------------------------------------- olaylar */

function wire() {
  dlg.addEventListener('cancel', () => stopPolling());
  dlg.addEventListener('close', stopPolling);

  dlg.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset?.folder !== undefined) {
      if (t.checked) bp.picked.add(t.dataset.folder); else bp.picked.delete(t.dataset.folder);
      q('[data-role="picked-count"]').textContent = `${num(bp.picked.size)} / ${num(bp.folders.length)}`;
      q('[data-act="plan"]').disabled = bp.picked.size === 0;
    } else if (t.dataset?.skipFolder !== undefined) {
      if (t.checked) bp.skipFolders.delete(t.dataset.skipFolder); else bp.skipFolders.add(t.dataset.skipFolder);
      refreshApply();
    } else if (t.dataset?.ack !== undefined) {
      bp.ack = t.checked;
      refreshApply();
    }
  });
  dlg.addEventListener('input', (ev) => {
    if (ev.target.dataset?.role === 'confirm') { bp.confirm = ev.target.value; refreshApply(); }
  });

  dlg.addEventListener('click', async (ev) => {
    if (ev.target.matches?.('[data-skip-folder]')) ev.stopPropagation(); // <summary> icindeki kutu details'i acip kapatmasin
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    switch (btn.dataset.act) {
      case 'close': stopPolling(); dlg.close(); break;
      case 'plan': await startPlan(); break;
      case 'replan': active.delete(bp.machineId); bp.plan = null; bp.apply = null; bp.confirm = ''; bp.ack = false; await startPlan(); break;
      case 'apply': await startApply(); break;
      case 'stop': await stopApply(); break;
      default: break;
    }
  });
}
