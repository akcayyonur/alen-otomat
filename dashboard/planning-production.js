/**
 * Planlama > Is emri: gerceklesen uretim paneli ve "Uretime baslat" / "Bitir" pencereleri (C asamasi).
 *
 * Baslat/bitir bir insan eylemidir (ortak hesapla fabrika PC'sinde); ADET telemetriden gelir: is emrinin penceresi
 * [baslangic, bitis] ve tezgahi icin sayilan parcalar. Program eslemesi adedi belirlemez, yalniz capraz denetimdir.
 * Bu modul yalniz gosterim ve istek gonderir; hesaplar sunucuda (backend/planning/progress.js).
 */
import { escapeHtml, stateOf } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, dateTimeText, openModal, chip, fmtDec, rememberedPerson, rememberPerson, parseInput, gramToKg } from './planning-common.js';
import { openIssueCard } from './planning-card.js';
import { openGkkPicker } from './planning-gkk.js';
import { createFirstApproval } from './planning-approvals.js';

/** "Listeden seç…" düğmeli GKK alanı: ustalar hammaddenin GK numarasını takip formundan bulup yazar. */
const gkkField = (value = '', label = 'GKK rapor no') =>
  `<label class="fld"><span>${escapeHtml(label)}</span><span class="fld-row"><input name="gkkReportNo" value="${escapeHtml(value ?? '')}" maxlength="40" autocomplete="off">` +
  '<button type="button" class="icon-btn icon-btn-sm" data-act="gkk-pick" title="Hammaddeye uyan GK numaralarını listeler">Listeden seç…</button></span></label>';

/** GKK "Listeden seç…" düğmesini bağlar. @param {HTMLFormElement} form @param {object} w iş emri */
function wireGkkPick(form, w) {
  form.querySelector('[data-act="gkk-pick"]')?.addEventListener('click', () => {
    const e = form.elements;
    openGkkPicker({
      erpMaterial: e.usedMaterial?.value.trim() || w.usedMaterial || w.material || '', stockCode: w.stockCode, current: e.gkkReportNo.value.trim(),
      onPick: (no) => { e.gkkReportNo.value = no; },
    });
  });
}

const PROGRAM_CHIP = Object.freeze({
  esli: (p) => chip('ok', '✓', 'eşli'),
  'baska-urun': (p) => chip('bad', '✕', `başka ürüne eşli${p.stockCode ? ` → ${p.stockCode}` : ''}`),
  'esli-degil': () => chip('none', '?', 'eşlenmemiş'),
  yok: () => chip('none', '—', 'program yok'),
});
const BASIS_LABEL = Object.freeze({ aralik: 'parçalar arası süreyle', cevrim: 'ölçülen çevrimle', plan: 'planlanan çevrimle' });
const dayText = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('tr-TR'); };
const sec = (v) => (v === null || v === undefined ? '<span class="is-null">—</span>' : `${fmtDec(v, 1)} sn`);

/** Uyari listesi: [{level: 'warn'|'info', text}] ya da duz metin dizisi. */
export function warningsHtml(items) {
  const list = items.map((w) => (typeof w === 'string' ? { level: 'warn', text: w } : w));
  if (list.length === 0) return '';
  return `<ul class="checks">${list.map((w) =>
    `<li class="check ${w.level === 'warn' ? 'check-warn' : 'check-info'}"><span class="check-ic" aria-hidden="true">${w.level === 'warn' ? '▲' : 'ℹ'}</span><div>${escapeHtml(w.text)}</div></li>`).join('')}</ul>`;
}

/** Numune: ilk N adedin olculen ortalama cevrimi; fark varsa urun kartina yazma ONERISI (dugme, onayli). */
function sampleHtml(s, w) {
  const state = s.complete
    ? (s.measuredAvgSec == null ? 'tamamlandı, çevrim süresi ölçülemedi' : `tamamlandı: ölçülen ortalama çevrim <b>${fmtDec(s.measuredAvgSec, 1)} sn</b> (planlanan ${s.plannedSec == null ? '—' : `${fmtDec(s.plannedSec, 1)} sn`})`)
    : `sürüyor: ${fmtNum(s.doneQty)} / ${fmtNum(s.qty)} adet${s.measuredAvgSec != null ? ` · şimdilik ortalama ${fmtDec(s.measuredAvgSec, 1)} sn` : ''}`;
  const suggest = s.suggestSec != null
    ? ` <button type="button" class="icon-btn icon-btn-sm" data-act="sample-write" data-sec="${s.suggestSec}" data-code="${escapeHtml(w.stockCode)}">Ürün kartına yaz (${fmtDec(s.suggestSec, 1)} sn)…</button>`
    : (s.complete && s.measuredAvgSec != null ? ' <small class="hint">planlananla uyumlu, öneri yok</small>' : '');
  return `<p class="pl-sample"><b>Numune (ilk ${fmtNum(s.qty)} adet)</b> ${state}.${suggest}</p>`;
}

/** @param {object} w /api/planning/work-orders/:no yaniti (progress ile) */
export function progressHtml(w) {
  const p = w.progress;
  if (!p) return '<section class="pl-prog" data-role="progress"><p class="hint">Henüz üretime başlatılmadı: adet, iş emri başlatılınca tezgahın sayacından sayılır.</p></section>';
  const pct = p.pct ?? 0;
  const over = p.overBy > 0;
  const meterText = `${fmtNum(p.produced)} / ${fmtNum(w.targetQty)} adet · %${fmtDec(pct, 1)}${over ? ` · ${fmtNum(p.overBy)} fazla` : p.remaining > 0 ? ` · kalan ${fmtNum(p.remaining)}` : ''}`;
  const kpi = (label, value) => `<div class="pl-kpi"><span class="pl-kpi-l">${label}</span><span class="pl-kpi-v">${value}</span></div>`;
  const eta = p.eta
    ? `${escapeHtml(dateTimeText(p.eta.ms))} <small class="hint">(${BASIS_LABEL[p.eta.basis]})</small>${p.eta.lateRisk ? ` ${chip('bad', '▲', 'termin riski')}` : ''}`
    : '<span class="is-null">—</span>';
  return (
    '<section class="pl-prog" data-role="progress">' +
    `<h4 class="sub">Üretim · ${p.frozen ? 'kapanışta dondurulmuş sonuç' : 'canlı (10 sn\'de bir tazelenir)'}</h4>` +
    `<p class="hint">${escapeHtml(dateTimeText(p.from))} → ${p.open ? 'şimdi' : escapeHtml(dateTimeText(p.to))} · ${escapeHtml(w.machineId)}</p>` +
    `<div class="pl-meter" role="img" aria-label="${escapeHtml(meterText)}"><span class="${over ? 'is-over' : ''}" style="width:${Math.min(100, pct)}%"></span></div>` +
    `<p class="pl-meter-t"><b>${escapeHtml(meterText)}</b></p>` +
    '<div class="pl-kpis">' +
    kpi('Planlanan çevrim', sec(p.cycle.plannedSec)) + kpi('Ölçülen çevrim', sec(p.cycle.measuredAvgSec)) + kpi('Parçalar arası', sec(p.cycle.intervalSec)) +
    (p.open ? kpi('Tahmini bitiş', eta) : '') + '</div>' +
    (p.sample ? sampleHtml(p.sample, w) : '') +
    '<p class="hint">Ölçülen çevrim kontrolcünün çevrim sayacıdır; parçalar arası süre duruş ve yükleme kaybını da içerir (aradaki fark gizlenmez).</p>' +
    (p.live ? `<p class="hint">Tezgah şu an: <b>${escapeHtml(stateOf(p.live.state).icon)} ${escapeHtml(stateOf(p.live.state).label)}</b> · program <span class="mono">${escapeHtml(p.live.program ?? '—')}</span> ` +
      `${(PROGRAM_CHIP[p.live.programStatus] ?? PROGRAM_CHIP.yok)({})}</p>` : '') +
    (p.shifts.length
      ? '<table class="tbl tbl-pl"><thead><tr><th>Üretim günü</th><th>Vardiya</th><th class="num">Adet</th></tr></thead><tbody>' +
        p.shifts.map((s) => `<tr><td>${escapeHtml(dayText(s.date))}</td><td>${escapeHtml(s.label)}</td><td class="num">${fmtNum(s.qty)}</td></tr>`).join('') + '</tbody></table>'
      : '') +
    (p.programs.length
      ? '<table class="tbl tbl-pl"><thead><tr><th>Program</th><th class="num">Adet</th><th>Eşleme</th></tr></thead><tbody>' +
        p.programs.map((g) => `<tr><td class="mono">${cellText(g.program)}</td><td class="num">${fmtNum(g.qty)}</td><td>${(PROGRAM_CHIP[g.status] ?? PROGRAM_CHIP.yok)(g)}</td></tr>`).join('') + '</tbody></table>'
      : '') +
    warningsHtml(p.warnings) +
    '</section>'
  );
}

/* ----------------------------------------------------- baslat / bitir pencereleri */

const nowLocalHint = 'Boş bırakın: şimdi. Unuttuysanız en fazla 72 saat geriye alabilirsiniz; adet başlangıçtan itibaren sayılır.';

/**
 * "Bu tezgahta baslatiyorum": tezgah, (istege bagli geriye alinmis) baslangic, yapan kisi ve iş emrinin elle doldurulan alanlari.
 * @param {string} no @param {(w: object) => void} [onDone]
 * @param {{machineId?: string}} [opts] machineId: tezgah basindaki kartin tezgahi (varsayilan: is emrindeki tezgah)
 */
export async function openStartDialog(no, onDone = () => {}, { machineId = null } = {}) {
  const m = openModal({ title: `Üretime başlat · ${no}` });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let meta;
  let w;
  try {
    [meta, w] = await Promise.all([api('/api/planning/summary'), api(`/api/planning/work-orders/${encodeURIComponent(no)}`)]);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (w.status !== 'planlandi') {
    m.body.innerHTML = '<p class="notice notice-sim">Bu iş emri artık "planlandı" durumunda değil; listeyi yenileyin.</p>';
    return;
  }
  const fld = (name, label, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${name}" autocomplete="off"${extra}></label>`;
  m.body.innerHTML =
    `<p class="pl-wohead"><b class="mono">${escapeHtml(w.no)}</b> · ${escapeHtml(w.stockCode)} ${escapeHtml(w.productName ?? '')} · hedef ${fmtNum(w.targetQty)} adet</p>` +
    '<form autocomplete="off"><div class="fld-grid">' +
    `<label class="fld"><span>Tezgah (bu tezgahta başlatıyorum)</span><select name="machineId" required>${(machineId ?? w.machineId) ? '' : '<option value="">— tezgah seçin —</option>'}${meta.machines.map((x) =>
      `<option value="${escapeHtml(x.id)}"${x.id === (machineId ?? w.machineId) ? ' selected' : ''}>${escapeHtml(x.id)}${x.name && x.name !== x.id ? ` · ${escapeHtml(x.name)}` : ''}</option>`).join('')}</select></label>` +
    `<label class="fld"><span>Başlangıç zamanı</span><input name="startAt" type="datetime-local"><small class="hint">${nowLocalHint}</small></label>` +
    fld('person', 'Yapan kişi (isteğe bağlı)', ' maxlength="60"') +
    fld('usedMaterial', 'Kullanılan hammadde (gerçek)', ` maxlength="80" placeholder="${escapeHtml(w.material ?? '')}"`) +
    gkkField(w.gkkReportNo ?? '', 'GKK rapor no (hammadde)') + fld('firstApprovalNo', 'İlk onay rapor no (boş bırakılabilir)', ' maxlength="40"') +
    '</div><p class="hint">İlk onay rapor no ve ölçülen net gramaj ilk parça yapılıp ölçülünce belli olur: şimdi boş bırakın, sonra Tezgah başı ekranındaki <b>"İlk onay numarası al"</b> ya da <b>"İş emrini düzenle"</b> ile girin.</p>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">Üretime başlat</button></div></form>';
  const form = m.body.querySelector('form');
  form.elements.person.value = rememberedPerson();
  form.elements.person.focus();
  wireGkkPick(form, w);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    const e = form.elements;
    rememberPerson(e.person.value);
    try {
      const r = await post(`/api/planning/work-orders/${encodeURIComponent(no)}/start`, {
        machineId: e.machineId.value, ...(e.startAt.value ? { startAt: e.startAt.value } : {}), person: e.person.value,
        fields: { usedMaterial: e.usedMaterial.value, gkkReportNo: e.gkkReportNo.value, firstApprovalNo: e.firstApprovalNo.value },
      });
      m.body.innerHTML =
        `<div class="notice"><b>Üretime başlatıldı:</b> <span class="mono">${escapeHtml(r.no)}</span> · ${escapeHtml(r.machineId)} · ${escapeHtml(dateTimeText(r.startedAt))}` +
        `${r.startTotal != null ? ` · tezgah sayacı ${fmtNum(r.startTotal)}` : ''}</div>` +
        warningsHtml(r.warnings ?? []) +
        '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>';
      onDone(r);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/**
 * Bitir: o ana kadar sayilan adet gosterilir; onaylaninca sonuc dondurulur (hedef sapmasi uyarilir).
 * @param {string} no @param {(w: object) => void} [onDone]
 */
export async function openFinishDialog(no, onDone = () => {}) {
  const m = openModal({ title: `İş emrini bitir · ${no}` });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let w;
  try {
    w = await api(`/api/planning/work-orders/${encodeURIComponent(no)}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (w.status !== 'uretimde') {
    m.body.innerHTML = '<p class="notice notice-sim">Bu iş emri üretimde değil; listeyi yenileyin.</p>';
    return;
  }
  const p = w.progress;
  m.body.innerHTML =
    `<p class="pl-wohead"><b class="mono">${escapeHtml(w.no)}</b> · ${escapeHtml(w.stockCode)} ${escapeHtml(w.productName ?? '')} · ${escapeHtml(w.machineId)}</p>` +
    `<p class="notice">Şu ana kadar <b>${fmtNum(p?.produced ?? 0)}</b> adet sayıldı (hedef ${fmtNum(w.targetQty)}${p && p.remaining > 0 ? `, kalan ${fmtNum(p.remaining)}` : ''}). ` +
    'Bitirince bu sonuç dondurulur; sonradan gelen veri değiştirmez (yanlışsa "Üretime geri al" vardır).</p>' +
    warningsHtml(p?.warnings ?? []) +
    '<form autocomplete="off"><div class="fld-grid">' +
    '<label class="fld"><span>Bitiş zamanı</span><input name="endAt" type="datetime-local"><small class="hint">Boş bırakın: şimdi. Bitirmeyi unuttuysanız gerçek bitiş zamanını girin; adet o ana kadar sayılır.</small></label>' +
    '<label class="fld"><span>Yapan kişi (isteğe bağlı)</span><input name="person" maxlength="60" autocomplete="off"></label></div>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">İş emrini bitir</button></div></form>';
  const form = m.body.querySelector('form');
  form.elements.person.value = rememberedPerson();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    rememberPerson(form.elements.person.value);
    try {
      const r = await post(`/api/planning/work-orders/${encodeURIComponent(no)}/finish`, {
        ...(form.elements.endAt.value ? { endAt: form.elements.endAt.value } : {}), person: form.elements.person.value,
      });
      m.body.innerHTML =
        `<div class="notice"><b>Bitirildi:</b> <span class="mono">${escapeHtml(r.no)}</span> · <b>${fmtNum(r.progress?.produced ?? 0)}</b> adet (hedef ${fmtNum(r.targetQty)})</div>` +
        warningsHtml(r.warnings ?? []) +
        '<p class="hint">Son kasa dolduysa kartını şimdi basabilirsiniz (iş emri bittikten sonra da Tezgah başı ekranından basılır).</p>' +
        '<div class="dt-actions"><button type="button" class="icon-btn" data-act="card">Son kasa için ürün tanıtım kartı bas</button><button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>';
      m.body.querySelector('[data-act="card"]').addEventListener('click', () => { m.close(); openIssueCard(r.no, () => onDone(r)); });
      onDone(r);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/**
 * TEZGAH BAŞINDAN İŞ EMRİ DÜZENLEME (operatör): ilk parça yapıldıktan sonra belli olan değerler (ilk onay rapor no, ölçülen net gramaj, GKK rapor no)
 * ile kullanılan hammadde ve açıklama. Planlama alanları (hedef, tezgah, ağırlık, süre...) buradan değişmez: yönetici ister.
 * @param {string} no @param {(w: object) => void} [onDone]
 */
export async function openEditFieldsDialog(no, onDone = () => {}) {
  const m = openModal({ title: `İş emrini düzenle · ${no}` });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let w;
  try {
    w = await api(`/api/planning/work-orders/${encodeURIComponent(no)}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (w.status === 'iptal') {
    m.body.innerHTML = '<p class="notice notice-sim">İptal edilmiş iş emri değiştirilemez.</p>';
    return;
  }
  const gram = (kg) => (kg === null || kg === undefined ? '' : String(Number((kg * 1000).toFixed(4))).replace('.', ','));
  const fld = (name, label, value, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${name}" autocomplete="off" value="${escapeHtml(value ?? '')}"${extra}></label>`;
  m.body.innerHTML =
    `<p class="pl-wohead"><b class="mono">${escapeHtml(w.no)}</b> · ${escapeHtml(w.stockCode)} ${escapeHtml(w.productName ?? '')} · ${escapeHtml(w.machineId ?? '')}</p>` +
    '<p class="hint">İlk parça yapılıp ölçülünce <b>ilk onay rapor no</b> ve <b>ölçülen net gramaj</b> buradan girilir. Değişiklikler iş emri geçmişine yazılır.</p>' +
    '<form autocomplete="off"><div class="fld-grid">' +
    `<label class="fld"><span>İlk onay rapor no</span><span class="fld-row"><input name="firstApprovalNo" value="${escapeHtml(w.firstApprovalNo ?? '')}" maxlength="40" autocomplete="off">` +
    '<button type="button" class="icon-btn icon-btn-sm" data-act="approval-new" title="Sıradaki ilk onay numarasını verir ve iş emrine yazar">Numara al…</button></span></label>' +
    fld('measuredNetG', 'Ölçülen net gramaj (gram)', gram(w.measuredNetKg), ' inputmode="decimal"') +
    gkkField(w.gkkReportNo ?? '') +
    fld('usedMaterial', 'Kullanılan hammadde (gerçek)', w.usedMaterial, ` maxlength="80" placeholder="${escapeHtml(w.material ?? '')}"`) +
    `<label class="fld pl-wide"><span>Açıklama</span><input name="note" maxlength="500" value="${escapeHtml(w.note ?? '')}"></label></div>` +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>';
  const form = m.body.querySelector('form');
  form.elements.firstApprovalNo.focus();
  wireGkkPick(form, w);
  // Numara alınınca sunucu iş emrine yazar; alanı da doldur (kaydet'e basınca aynı değer gider)
  form.querySelector('[data-act="approval-new"]').addEventListener('click', () => {
    createFirstApproval(w.no, (a) => { form.elements.firstApprovalNo.value = a.code; w.firstApprovalNo = a.code; onDone(a); });
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = m.body.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    const e = form.elements;
    try {
      const r = await post(`/api/planning/work-orders/${encodeURIComponent(no)}/fields`, {
        fields: {
          firstApprovalNo: e.firstApprovalNo.value, gkkReportNo: e.gkkReportNo.value, usedMaterial: e.usedMaterial.value, note: e.note.value,
          measuredNetKg: gramToKg(parseInput(e.measuredNetG.value)),
        },
      });
      m.close();
      onDone(r);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}
