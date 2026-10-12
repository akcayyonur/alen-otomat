/**
 * Program editoru: yeni NC programi yazmak ya da kutuphanedeki programdan YENI SURUM uretmek.
 * Bul-degistir yok; satir numarasi, imlec konumu, kaydetmeden once DEGISIKLIK FARKI var.
 *
 * Ilke: ICERIK YORUMLANMAZ. Burada Syntec soz dizimi denetimi, simulasyon ya da otomatik duzeltme
 * yoktur; yalnizca metin duzeyi kontroller (bos, NUL, 1 MB siniri, ASCII disi karakter, Latin-1'e
 * sigmayan karakter). Satir sonu ve kodlama kullanicinin secimiyle uygulanir; dokunulmayan dosya
 * bayt bayt ayni kalir (sunucu `roundTrip` bildirir). Kaydetmek TEZGAHA BIR SEY GONDERMEZ.
 *
 * Akis: yaz -> "Degisiklikleri gozden gecir" (fark) -> "Kutuphaneye kaydet" ya da
 * "Kaydet ve tezgaha gonder..." (gonderme penceresini o programla acar; orada ayri onay var).
 */
import { escapeHtml, num } from './format.js';
import { api, post, userName, kb, programLabel, folderLabel, announce, byLocked } from './lib-common.js';
import { diffTable } from './diff-render.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const FORBIDDEN_FOLDER = /[\\/:*?"<>|\u0000-\u001f]/;
const MAX_BYTES = 1_000_000;

let dlg = null;
const ed = {};

const q = (role) => dlg.querySelector(`[data-role="${role}"]`);
const normalize = (s) => s.replace(/\r\n?/g, '\n');
const keyOf = (c, n) => `${c.toLowerCase()}\u0000${n.toLowerCase()}`;

/* ------------------------------------------------------------------ acilis */

/**
 * @param {{mode?: 'new'|'version', programId?: number|null, versionNo?: number|null, customer?: string,
 *   onSend?: ((programId: number, versionNo: number) => void)|null}} opts
 */
export async function openEditor({ mode = 'new', programId = null, versionNo = null, customer = '', onSend = null } = {}) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'modal modal-wide';
    dlg.setAttribute('aria-labelledby', 'editor-title');
    document.body.append(dlg);
    wire();
  }
  for (const k of Object.keys(ed)) delete ed[k];
  Object.assign(ed, {
    mode, programId: null, baseVersionNo: null, latestVersionNo: null, sourceLabel: '',
    customer, name: '', note: '', by: userName.get(),
    text: '', initialText: '', lineEnding: 'CRLF', initialLineEnding: 'CRLF', encoding: 'utf-8', initialEncoding: 'utf-8', bom: false,
    forceChange: false, notRoundTrip: false, customers: [], existing: new Set(),
    cursor: '', statsText: '', phase: 'edit', busy: false, error: null, newerPrompt: false, acceptNewer: false, result: null, loadFailed: false, onSend,
  });

  try {
    const [cust, progs] = await Promise.all([api('/api/library/customers'), api('/api/library/programs')]);
    ed.customers = cust.customers;
    ed.existing = new Set(progs.programs.map((p) => keyOf(p.customer, p.name)));
    if (mode === 'version') {
      const [detail, pv] = await Promise.all([
        api(`/api/library/programs/${programId}`),
        api(`/api/library/programs/${programId}/versions/${versionNo}?full=1`),
      ]);
      // Kesik metinle kaydetmek icerigi SESSIZCE kisaltirdi: asla izin verme.
      if (pv.truncated) throw new Error('Program metni tam okunamadı; düzenleme için açılamaz.');
      ed.programId = programId;
      ed.baseVersionNo = pv.meta.versionNo;
      ed.latestVersionNo = detail.versions[0]?.versionNo ?? pv.meta.versionNo;
      ed.customer = detail.program.customer;
      ed.name = detail.program.name;
      ed.sourceLabel = programLabel(ed.customer, ed.name);
      ed.text = normalize(pv.text);
      ed.initialText = ed.text;
      ed.lineEnding = pv.lineEnding === 'LF' ? 'LF' : 'CRLF';
      ed.initialLineEnding = ed.lineEnding;
      ed.encoding = pv.encodingId;
      ed.initialEncoding = pv.encodingId;
      ed.bom = pv.bom;
      // Dosya editorde birebir korunamiyorsa (karisik satir sonu vb.) kaydetmek bayt degisikligi demektir.
      ed.notRoundTrip = !pv.roundTrip;
      ed.forceChange = !pv.roundTrip;
      ed.originalLineEnding = pv.lineEnding;
    }
  } catch (err) {
    ed.loadFailed = true;
    ed.error = `Editör açılamadı: ${err.message}`;
  }

  build();
  paint();
  if (!dlg.open) dlg.showModal();
  if (!ed.loadFailed) q('text').focus();
}

/* --------------------------------------------------------------- iskelet */

function build() {
  const version = ed.mode === 'version';
  dlg.innerHTML =
    '<div class="modal-inner">' +
    '<header class="modal-head"><div><span class="eyebrow">Program editörü</span><h3 id="editor-title" data-role="title"></h3></div>' +
    '<button type="button" class="icon-btn" data-act="close">Kapat</button></header>' +
    '<div class="modal-body">' +
    '<p class="notice" data-role="info"></p>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +

    '<section data-role="p-edit">' +
    '<div class="fld-grid">' +
    '<label class="fld"><span>Müşteri klasörü (tezgahta duracağı klasör)</span>' +
    `<input data-key="customer" list="ed-customers" placeholder="boş = kök (ortak alan)" autocomplete="off"${version ? ' disabled' : ''}></label>` +
    '<label class="fld"><span>Program adı</span>' +
    `<input data-key="name" class="mono" maxlength="40" autocomplete="off" spellcheck="false" placeholder="ör. MUSTERI-001"${version ? ' disabled' : ''}></label>` +
    '<label class="fld"><span>Not (isteğe bağlı, sürüm geçmişinde görünür)</span><input data-key="note" maxlength="200"></label>' +
    `<label class="fld"><span>Adınız (kayıt için, zorunlu)</span><input data-key="by" maxlength="40" placeholder="ör. Ayşe"${byLocked()}></label>` +
    '</div>' +
    `<datalist id="ed-customers">${ed.customers.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>` +
    '<p class="hint" data-role="meta-msg" aria-live="polite"></p>' +

    '<div class="ed-tools">' +
    '<label class="fld-inline">Satır sonu <select data-key="lineEnding" class="fld-sm">' +
    '<option value="CRLF">CRLF (Windows)</option><option value="LF">LF</option></select></label>' +
    '<label class="fld-inline">Kodlama <select data-key="encoding" class="fld-sm">' +
    '<option value="utf-8">UTF-8</option><option value="latin1">Latin-1</option></select></label>' +
    '<span class="ed-stats" data-role="stats"></span></div>' +

    '<div class="ed-wrap"><div class="ed-gutter" aria-hidden="true"><pre data-role="gutter"></pre></div>' +
    '<textarea class="ed-text" data-role="text" data-key="text" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off" ' +
    'aria-label="Program metni (satır numaraları solda)"></textarea></div>' +
    '<ul class="checks" data-role="warn"></ul>' +
    '</section>' +

    '<section data-role="p-review" hidden></section>' +
    '<section data-role="p-done" hidden></section>' +
    '</div>' +
    '<footer class="modal-foot" data-role="foot"></footer></div>';

  if (ed.loadFailed) {
    q('p-edit').hidden = true;
  }
}

/* ------------------------------------------------------------ cizim + durum */

/** Alanlari durumdan doldurur (acilista ve kopya moduna gecerken). */
function paint() {
  const set = (key, value) => { const el = dlg.querySelector(`[data-key="${key}"]`); if (el) el.value = value; };
  set('customer', ed.customer);
  set('name', ed.name);
  set('note', ed.note);
  set('by', ed.by);
  set('lineEnding', ed.lineEnding);
  set('encoding', ed.encoding);
  if (!ed.loadFailed) {
    const ta = q('text');
    ta.value = ed.text;
    ed.lineCount = -1;
    syncGutter();
  }
  for (const k of ['customer', 'name']) {
    const el = dlg.querySelector(`[data-key="${k}"]`);
    if (el) el.disabled = ed.mode === 'version';
  }
  refresh();
}

/** Her degisiklikten sonra: baslik, bilgi, istatistik, uyarilar, altlik dugmeleri. */
function refresh() {
  const version = ed.mode === 'version';
  if (ed.loadFailed) {
    q('title').textContent = 'Editör açılamadı';
    q('info').hidden = true;
    q('err').hidden = false;
    q('err').textContent = ed.error ?? '';
    renderFoot();
    return;
  }
  q('title').textContent = version
    ? `Düzenle · ${ed.sourceLabel} (v${ed.baseVersionNo} üzerinden)`
    : (ed.sourceLabel ? `Yeni program · ${ed.sourceLabel} kopyası` : 'Yeni program');
  q('info').innerHTML = version
    ? 'Kaydedince bu program için <b>yeni bir sürüm</b> oluşur; eski sürümler kütüphanede aynen kalır. ' +
      'İçerik yorumlanmaz: <b>söz dizimi denetimi yoktur</b>, bu yüzden kaydetmeden önce değişiklikleri gözden geçirin.'
    : 'Yeni bir NC programı yazın; kütüphaneye kaydedilir ve istenirse hemen tezgaha gönderilir. ' +
      'İçerik yorumlanmaz: yazdığınız metin <b>aynen</b> dosya olur, <b>söz dizimi denetimi yoktur</b>. Kaydetmek tezgaha bir şey göndermez.';

  const a = analyze();
  ed.statsText = `${num(a.lines)} satır · ≈${kb(a.bytes)} · ${ed.lineEnding} · ${ed.encoding === 'utf-8' ? 'UTF-8' : 'Latin-1'}`;
  renderStats();

  const items = [
    ...a.blocks.map((x) => ['block', x]),
    ...a.warns.map((x) => ['warn', x]),
    ...a.infos.map((x) => ['info', x]),
  ];
  const ic = { block: '✕', warn: '▲', info: 'ℹ' };
  q('warn').innerHTML = items.map(([lvl, x]) =>
    `<li class="check check-${lvl}"><span class="check-ic" aria-hidden="true">${ic[lvl]}</span><div><b>${escapeHtml(x.title)}</b>` +
    `${x.detail ? `<p>${escapeHtml(x.detail)}</p>` : ''}</div></li>`).join('');

  const meta = metaProblem();
  q('meta-msg').textContent = meta ? `✕ ${meta}` : (version
    ? 'Müşteri klasörü ve ad sabit (aynı programın yeni sürümü). Farklı bir ad için "Kopya olarak ayır".'
    : 'Ad: İngilizce harf, rakam, "-", "_", "." (en fazla 40). Müşteri klasörü boşsa program kök dizin (ortak alan) olur.');
  q('err').hidden = !ed.error;
  q('err').textContent = ed.error ?? '';
  renderFoot();
}

function dirty() {
  if (ed.mode === 'new') return ed.text !== '';
  return ed.text !== ed.initialText || ed.lineEnding !== ed.initialLineEnding || ed.encoding !== ed.initialEncoding;
}

/** Metin duzeyi kontroller (icerik yorumlanmaz). */
function analyze() {
  const t = ed.text;
  const blocks = [];
  const warns = [];
  const infos = [];
  const lf = (t.match(/\n/g) ?? []).length;
  const lines = lf + 1;
  const utf8 = new TextEncoder().encode(t).length;
  const bytes = (ed.encoding === 'latin1' ? t.length : utf8) + (ed.lineEnding === 'CRLF' ? lf : 0) + (ed.bom && ed.encoding === 'utf-8' ? 3 : 0);
  const lineOf = (idx) => t.slice(0, idx).split('\n').length;

  if (t.trim() === '') blocks.push({ title: 'Program boş', detail: 'Boş dosya kaydedilemez.' });
  if (t.includes('\0')) blocks.push({ title: 'Metinde NUL karakteri var', detail: `Satır ${lineOf(t.indexOf('\0'))}. NC programı metin dosyası olmalı.` });
  if (bytes > MAX_BYTES) blocks.push({ title: `Dosya çok büyük (≈${kb(bytes)})`, detail: `En fazla ${kb(MAX_BYTES)} kaydedilebilir.` });
  if (ed.encoding === 'latin1') {
    const m = /[^\u0000-ÿ]/.exec(t);
    if (m) blocks.push({ title: `Satır ${lineOf(m.index)}: "${m[0]}" karakteri Latin-1'de yok`, detail: 'Karakteri değiştirin ya da kodlamayı UTF-8 seçin.' });
  }
  const nonAscii = /[^\u0000-\u007f]/.exec(t);
  if (nonAscii) {
    warns.push({
      title: `Satır ${lineOf(nonAscii.index)}: ASCII dışı karakter ("${nonAscii[0]}")`,
      detail: 'Tezgah panelinde nasıl görüneceği doğrulanmadı (ç, ş, ğ gibi karakterler bozuk çıkabilir). Emin değilseniz yorum satırlarında bile İngilizce harf kullanın.',
    });
  }
  if (ed.mode === 'version' && ed.baseVersionNo !== ed.latestVersionNo) {
    infos.push({
      title: `v${ed.baseVersionNo} üzerinden düzenliyorsunuz (son sürüm v${ed.latestVersionNo})`,
      detail: `Kaydederseniz v${ed.latestVersionNo + 1} olarak eklenir; v${ed.latestVersionNo}'deki değişiklikler bu metne dahil değildir.`,
    });
  }
  if (ed.notRoundTrip) {
    infos.push({
      title: 'Bu dosyanın satır sonları tek tip değil (ya da kodlaması özel)',
      detail: `Kaydederseniz tüm satır sonları ${ed.lineEnding} olur; metin aynı kalsa bile dosyanın baytları değişir.`,
    });
  }
  return { blocks, warns, infos, lines, bytes };
}

/** Program kimligi (musteri/ad) sorunu ya da null. */
function metaProblem() {
  if (ed.mode === 'version') return null;
  const c = ed.customer.trim();
  const n = ed.name.trim();
  if (c.length > 64 || c === '.' || c === '..' || FORBIDDEN_FOLDER.test(c)) {
    return 'Müşteri klasörü adı geçersiz (\\ / : * ? " < > | karakterleri ve 64 karakterden uzun ad olmaz).';
  }
  if (n === '') return null;
  if (!NAME_RE.test(n) || n === '.' || n === '..') return 'Program adı geçersiz: İngilizce harf, rakam, "-", "_" ve "." kullanılabilir (en fazla 40 karakter).';
  if (/^zz(up|rb)/i.test(n)) return '"ZZUP" ve "ZZRB" ile başlayan adlar aktarım için ayrılmıştır.';
  if (ed.existing.has(keyOf(c, n))) return `"${programLabel(c, n)}" kütüphanede zaten var. Var olan programı değiştirmek için programı açıp "Düzenle"yi kullanın; yeni program için başka ad seçin.`;
  return null;
}

function canReview() {
  const a = analyze();
  const nameOk = ed.mode === 'version' || ed.name.trim() !== '';
  return a.blocks.length === 0 && metaProblem() === null && nameOk && ed.by.trim() !== '' && !ed.busy;
}

function reviewHint() {
  if (ed.mode === 'new' && ed.name.trim() === '') return 'Program adını yazın.';
  if (ed.by.trim() === '') return 'Adınızı yazın (kayıt için).';
  return '';
}

/* ----------------------------------------------------------- satir numaralari */

function syncGutter() {
  const ta = q('text');
  const gutter = q('gutter');
  const n = ta.value.split('\n').length;
  if (n !== ed.lineCount) {
    ed.lineCount = n;
    gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    gutter.parentElement.style.setProperty('--digits', String(Math.max(2, String(n).length)));
  }
  gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
}

function renderStats() {
  q('stats').textContent = `${ed.cursor ? `${ed.cursor} · ` : ''}${ed.statsText ?? ''}`;
}

function updateCursor() {
  const ta = q('text');
  if (!ta || ed.loadFailed) return;
  const pos = ta.selectionStart ?? 0;
  const before = ta.value.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - (before.lastIndexOf('\n') + 1) + 1;
  ed.cursor = `Satır ${line}, sütun ${col}`;
  renderStats();
}

/* ------------------------------------------------------------------- altlik */

function renderFoot() {
  const foot = q('foot');
  const btn = (act, label, cls = '', dis = false, title = '') =>
    `<button type="button" class="icon-btn${cls ? ` ${cls}` : ''}" data-act="${act}"${dis ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`;
  if (ed.loadFailed) { foot.innerHTML = btn('close', 'Kapat', 'btn-primary'); return; }

  if (ed.phase === 'edit') {
    const ok = canReview();
    foot.innerHTML =
      (ed.mode === 'version' ? `<span class="grow">${btn('make-copy', 'Kopya olarak ayır (yeni ad)…', '', ed.busy)}</span>` : '<span class="grow"></span>') +
      `<span class="hint" style="margin:0" data-role="foot-hint">${escapeHtml(reviewHint())}</span>` +
      btn('close', 'Vazgeç') +
      btn('review', ed.mode === 'version' ? 'Değişiklikleri gözden geçir →' : 'İncele ve kaydet →', 'btn-primary', !ok);
  } else if (ed.phase === 'review') {
    const noChange = ed.mode === 'version' && !ed.review?.changed;
    foot.innerHTML =
      `<span class="grow">${btn('back', '← Düzenlemeye dön', '', ed.busy)}</span>` +
      (ed.newerPrompt ? btn('save-anyway', 'Yine de yeni sürüm olarak kaydet', 'btn-primary', ed.busy) : '') +
      btn('save', ed.busy ? 'Kaydediliyor…' : 'Kütüphaneye kaydet', ed.newerPrompt ? '' : 'btn-primary', ed.busy || noChange || ed.newerPrompt) +
      (ed.onSend ? btn('save-send', 'Kaydet ve tezgaha gönder…', '', ed.busy || noChange || ed.newerPrompt, 'Önce kütüphaneye kaydeder, sonra gönderme penceresini açar (orada ayrıca onay istenir)') : '');
  } else {
    foot.innerHTML =
      '<span class="grow"></span>' +
      btn('show', 'Programı kütüphanede göster') +
      (ed.onSend ? btn('send', 'Tezgaha gönder…', 'btn-primary') : '') +
      btn('close', 'Kapat', ed.onSend ? '' : 'btn-primary');
  }
}

function showPhase(phase) {
  ed.phase = phase;
  q('p-edit').hidden = phase !== 'edit';
  q('p-review').hidden = phase !== 'review';
  q('p-done').hidden = phase !== 'done';
  q('err').hidden = !ed.error;
  renderFoot();
  dlg.querySelector('.modal-body').scrollTop = 0;
}

/* -------------------------------------------------------------------- inceleme */

function renderReview() {
  const host = q('p-review');
  const a = analyze();
  const label = programLabel(ed.customer.trim(), ed.name.trim());
  let html = '';

  if (ed.mode === 'version') {
    const { html: diffHtml, added, removed, coarse } = diffTable(ed.initialText, ed.text, { cutNote: 'kaydedince hepsi kaydedilir' });
    const cnt = { added, removed };
    const metaChanged = ed.lineEnding !== ed.initialLineEnding || ed.encoding !== ed.initialEncoding || ed.forceChange;
    ed.review = { changed: cnt.added + cnt.removed > 0 || metaChanged };
    const metaNotes = [];
    if (ed.lineEnding !== ed.initialLineEnding) metaNotes.push(`satır sonu ${ed.initialLineEnding} → ${ed.lineEnding}`);
    if (ed.encoding !== ed.initialEncoding) metaNotes.push(`kodlama ${ed.initialEncoding} → ${ed.encoding}`);
    if (ed.forceChange && metaNotes.length === 0) metaNotes.push(`satır sonları ${ed.lineEnding} olarak birleştirilecek`);

    html += `<h4 class="sub">${escapeHtml(label)} · v${ed.baseVersionNo} → yeni sürüm</h4>` +
      `<p class="hint"><b class="diff-add-t">+${num(cnt.added)}</b> satır eklendi · <b class="diff-del-t">−${num(cnt.removed)}</b> satır silindi` +
      `${metaNotes.length ? ` · ${escapeHtml(metaNotes.join(', '))}` : ''}${coarse ? ' · çok büyük değişiklik: satırlar topluca gösteriliyor' : ''}</p>`;
    if (!ed.review.changed) {
      html += '<p class="notice">Metinde değişiklik yok: kaydedilirse yeni sürüm açılmaz. Düzenlemeye dönüp değişiklik yapın.</p>';
    } else if (cnt.added + cnt.removed === 0) {
      html += '<p class="notice">Metin aynı; yalnızca dosyanın satır sonu/kodlaması değişiyor (baytlar farklı olacağı için yeni sürüm açılır).</p>';
    } else {
      html += diffHtml;
    }
  } else {
    ed.review = { changed: true };
    html += `<h4 class="sub">Yeni program: ${escapeHtml(label)}</h4>` +
      '<table class="tbl"><tbody>' +
      `<tr><th>Müşteri klasörü</th><td>${escapeHtml(folderLabel(ed.customer.trim()))}</td></tr>` +
      `<tr><th>Program adı</th><td class="mono">${escapeHtml(ed.name.trim())}</td></tr>` +
      `<tr><th>İçerik</th><td>${num(a.lines)} satır · ≈${escapeHtml(kb(a.bytes))} · ${ed.lineEnding} · ${ed.encoding === 'utf-8' ? 'UTF-8' : 'Latin-1'}</td></tr>` +
      `<tr><th>Not</th><td>${escapeHtml(ed.note || '—')}</td></tr></tbody></table>` +
      '<h4 class="sub">İlk satırlar</h4>' +
      `<pre class="code-view" tabindex="0" aria-label="Program içeriğinin ilk satırları">${escapeHtml(ed.text.split('\n').slice(0, 40).join('\n'))}</pre>` +
      (a.lines > 40 ? `<p class="hint">… ${num(a.lines - 40)} satır daha.</p>` : '');
  }

  html += (a.warns.length ? `<ul class="checks">${a.warns.map((x) =>
    `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div><b>${escapeHtml(x.title)}</b><p>${escapeHtml(x.detail)}</p></div></li>`).join('')}</ul>` : '') +
    `<p class="hint">Kaydedince: ${escapeHtml(ed.by.trim())} adıyla kütüphaneye yazılır. Tezgaha bir şey gönderilmez; göndermek ayrı bir adımdır ve ayrıca onay ister.</p>`;
  host.innerHTML = html;
}

/* ------------------------------------------------------------------- kaydetme */

async function save({ then = 'done' } = {}) {
  ed.busy = true;
  ed.error = null;
  renderFoot();
  const body = {
    text: ed.text, lineEnding: ed.lineEnding, encoding: ed.encoding, bom: ed.bom,
    note: ed.note.trim(), by: ed.by.trim(), acceptNewer: ed.acceptNewer,
    ...(ed.mode === 'version'
      ? { programId: ed.programId, baseVersionNo: ed.baseVersionNo }
      : { customer: ed.customer.trim(), name: ed.name.trim() }),
  };
  try {
    ed.result = await post('/api/library/programs/text', body);
    userName.set(ed.by.trim());
    ed.busy = false;
    announce();
    if (then === 'send' && ed.onSend) {
      const { program, version } = ed.result;
      dlg.close();
      ed.onSend(program.id, version.versionNo);
      return;
    }
    renderDone();
    showPhase('done');
  } catch (err) {
    ed.busy = false;
    if (err.code === 'newer-version') {
      ed.newerPrompt = true;
      ed.error = err.message;
      showPhase('review');
    } else if (err.code === 'exists') {
      ed.error = err.message;
      ed.existing.add(keyOf(ed.customer.trim(), ed.name.trim()));
      showPhase('edit');
      refresh();
    } else {
      ed.error = `Kaydedilemedi: ${err.message}`;
      showPhase(ed.phase);
    }
  }
}

function renderDone() {
  const { program, version, created } = ed.result;
  q('p-done').innerHTML =
    `<div class="result result-${created ? 'ok' : 'warn'}"><span class="result-ic" aria-hidden="true">${created ? '✓' : 'ℹ'}</span><div>` +
    `<b>${created ? `Kütüphaneye kaydedildi: ${escapeHtml(programLabel(program.customer, program.name))} · v${version.versionNo}` : `İçerik ${escapeHtml(programLabel(program.customer, program.name))} v${version.versionNo} ile aynı: yeni sürüm açılmadı`}</b>` +
    `<p>${num(version.size)} bayt · SHA-256 <span class="mono">${escapeHtml(version.sha256.slice(0, 16))}…</span> · ${escapeHtml(version.createdBy ?? '')}</p>` +
    '<p><b>Tezgaha henüz bir şey gönderilmedi.</b> Göndermek için "Tezgaha gönder…" düğmesini kullanın.</p></div></div>';
}

/* ---------------------------------------------------------------------- olaylar */

function requestClose() {
  if (ed.busy) return;
  if (ed.phase !== 'done' && !ed.loadFailed && dirty() && !window.confirm('Kaydedilmemiş değişiklikler var. Editör kapatılsın mı?')) return;
  dlg.close();
}

function wire() {
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); requestClose(); });
  // Chrome, ust uste ikinci Esc'te `cancel` olayini atlayip pencereyi kapatabilir: yazilan metin onaysiz giderdi.
  dlg.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); requestClose(); } });

  dlg.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.key;
    if (!key || key === 'lineEnding' || key === 'encoding') return;
    ed[key] = key === 'text' ? normalize(ev.target.value) : ev.target.value;
    if (key === 'text') syncGutter();
    if (key === 'by') userName.set(ed.by.trim());
    ed.error = null;
    ed.newerPrompt = false;
    refresh();
    if (key === 'text') updateCursor();
  });

  dlg.addEventListener('change', (ev) => {
    const key = ev.target.dataset?.key;
    if (key !== 'lineEnding' && key !== 'encoding') return;
    ed[key] = ev.target.value;
    refresh();
  });

  // scroll olayi kabarciklanmaz: yakalama asamasinda dinle.
  dlg.addEventListener('scroll', (ev) => { if (ev.target === q('text')) syncGutter(); }, true);
  for (const type of ['keyup', 'mouseup', 'focusin']) {
    dlg.addEventListener(type, (ev) => { if (ev.target === q('text')) updateCursor(); }, true);
  }

  dlg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    switch (btn.dataset.act) {
      case 'close': requestClose(); break;
      case 'review':
        if (!canReview()) break;
        ed.error = null;
        renderReview();
        showPhase('review');
        break;
      case 'back': ed.newerPrompt = false; ed.acceptNewer = false; ed.error = null; showPhase('edit'); refresh(); q('text').focus(); break;
      case 'save': await save(); break;
      case 'save-anyway': ed.acceptNewer = true; ed.newerPrompt = false; await save(); break;
      case 'save-send': await save({ then: 'send' }); break;
      case 'show': {
        const id = ed.result.program.id;
        dlg.close();
        location.hash = `#/programlar/${id}`;
        break;
      }
      case 'send': {
        const { program, version } = ed.result;
        dlg.close();
        ed.onSend?.(program.id, version.versionNo);
        break;
      }
      case 'make-copy':
        Object.assign(ed, {
          mode: 'new', sourceLabel: ed.sourceLabel, programId: null, baseVersionNo: null, name: '',
          forceChange: false, notRoundTrip: false,
        });
        paint();
        dlg.querySelector('[data-key="name"]').focus();
        break;
      default: break;
    }
  });
}
