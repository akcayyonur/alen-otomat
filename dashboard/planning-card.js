/**
 * Ürün Tanıtım Kartı ve iş emrindeki kart/kasa listesi.
 *
 * AKIŞ (tek adım): makine üretti, ürün kasaya doldu; usta o üretimin iş emrine girer ve BİR kart bastırır, kartı kasaya atıp kasayı
 * paketlemeye yollar. Kartı SİSTEM basar (kendi numarasıyla, düz kâğıda) ve iş emrine bağlıdır. Kart bir TABLO'dur:
 *   ALEN ÜRÜN KODU · MÜŞTERİ ÜRÜN KODU · TARİH · MAKİNA NO · İŞ EMRİ NO · GKK RAPOR NO   (+ küçük KART NO: paketleme kartı bununla bulur)
 * Her basış bir KASA kaydıdır: o kasaya girdiğini tahmin ettiğimiz adet (önceki karttan bu yana tezgahın saydığı) ve tezgah sayacı arka planda
 * tutulur; kartta MİKTAR YOK. Kesin adet paketlemede girilir (Paketleme bölümü). Ret/hurda sistemde tutulmaz.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, dateTimeText, openModal, chip, rememberedPerson } from './planning-common.js';
import { openMeasureSheet } from './planning-measure.js';

const plain = (v) => (v === null || v === undefined ? '' : String(v));
const sign = (n) => (n === null || n === undefined ? '' : n > 0 ? `+${fmtNum(n)}` : fmtNum(n));
const dateText = (ms) => new Date(ms).toLocaleDateString('tr-TR');

/** Kasa durum rozeti (ikon + etiket). */
export const crateStateChip = (state) => ({
  acik: chip('info', '▶', 'açık'),
  kapali: chip('none', '◔', 'paketleme bekliyor'),
  paketlendi: chip('ok', '✓', 'paketlendi'),
  iptal: chip('bad', '✕', 'iptal'),
}[state] ?? chip('none', '?', String(state)));

/** Küçük uyarı listesi (planning-production.js'e bağımlı olmamak için burada). */
const warningsList = (list) => (list?.length ? `<ul class="pl-warns">${list.map((x) => `<li class="notice">${escapeHtml(x)}</li>`).join('')}</ul>` : '');

/**
 * Kart: 6 alanlı tablo. `cardNo` yoksa (önizleme) "basılınca verilir" yazılır.
 * @param {{cardNo?: string|null, stockCode?: string|null, customerCode?: string|null, machineId?: string|null, woNo?: string|null,
 *          gkkReportNo?: string|null, issuedAt?: number|null, closedAt?: number|null, state?: string}} c
 */
export function cardHtml(c) {
  const machineNo = (/(\d+)\s*$/.exec(c.machineId ?? '') ?? [])[1];
  const when = c.issuedAt ?? c.closedAt ?? Date.now();
  const row = (label, value, cls = '') => `<tr><th scope="row">${label}</th><td class="${cls}">${value === '' || value == null ? '&nbsp;' : escapeHtml(value)}</td></tr>`;
  return (
    '<div class="pl-card">' +
    `<div class="pl-c-head"><div class="pl-c-title">ÜRÜN TANITIM KARTI</div><div class="pl-c-no"><span class="pl-c-label">KART NO:</span> <b>${c.cardNo ? escapeHtml(c.cardNo) : '<i class="pl-c-pending">basılınca verilir</i>'}</b></div></div>` +
    '<table class="pl-c-table"><tbody>' +
    row('ALEN ÜRÜN KODU', plain(c.stockCode)) +
    row('MÜŞTERİ ÜRÜN KODU', plain(c.customerCode)) +
    row('TARİH', dateText(when)) +
    row('MAKİNA NO', machineNo ? String(Number(machineNo)) : plain(c.machineId)) +
    row('İŞ EMRİ NO', plain(c.woNo)) +
    row('GKK RAPOR NO', plain(c.gkkReportNo), 'pl-c-gkk') +
    '</tbody></table>' +
    `<p class="pl-c-foot">Sistemden basıldı ${escapeHtml(new Date(when).toLocaleString('tr-TR', { hour12: false }))}${c.state === 'iptal' ? ' · İPTAL EDİLDİ' : ''}</p>` +
    '</div>'
  );
}

/** Tarayıcının yazdır penceresini açar (yalnız kart basılır; A5 dikey). */
function printNow() {
  document.body.classList.add('pl-printing');
  const done = () => { document.body.classList.remove('pl-printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * ÜRÜN TANITIM KARTI BAS: iş emrinin kartını önizler; "Kartı oluştur ve yazdır" ile kasa kaydı + kart numarası verilir ve yazdırma açılır.
 * Önizleme aşamasında sunucuya HİÇBİR ŞEY yazılmaz (yanlışlıkla dokunma kart harcamasın).
 * @param {string} woNo
 * @param {(card?: object) => void} [onDone] kart basılınca (ekranları tazelemek için)
 */
export async function openIssueCard(woNo, onDone = null) {
  const m = openModal({ title: 'Ürün tanıtım kartı', wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let w;
  try {
    w = await api(`/api/planning/work-orders/${encodeURIComponent(woNo)}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">İş emri alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (w.status !== 'uretimde' && w.status !== 'bitti') {
    m.body.innerHTML = '<p class="notice notice-sim">Kart yalnız üretimdeki ya da bitmiş iş emri için basılır.</p>';
    return;
  }
  const st = { card: null, gkk: w.gkkReportNo ?? '', busy: false, error: null };
  const preview = () => ({ cardNo: null, stockCode: w.stockCode, customerCode: w.customerCode, machineId: w.machineId, woNo: w.no, gkkReportNo: st.gkk });

  function draw() {
    const c = st.card ?? preview();
    const controls = st.card
      ? `<div class="notice"><b class="mono">${escapeHtml(st.card.cardNo)}</b> basıldı. Kartı kasaya atın ve kasayı paketlemeye gönderin.</div>${warningsList(st.card.warnings)}` +
        '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yeniden yazdır</button>' +
        '<button type="button" class="icon-btn" data-act="sheet">Ölçü kontrol föyünü yazdır…</button>' +
        '<button type="button" class="icon-btn" data-act="void">Yanlış basıldı: iptal et…</button>' +
        '<button type="button" class="icon-btn" data-act="close">Kapat</button></div>'
      : '<p class="hint">Kartta bu alanlar basılır. Kasa dolduysa kartı oluşturun, kasaya atın.</p>' +
        (w.gkkReportNo ? '' : '<label class="fld"><span>GKK rapor no (boşsa kartta boş çıkar; yazarsanız iş emrine de işlenir)</span><input name="gkk" maxlength="40" autocomplete="off"></label>') +
        (st.error ? `<p class="notice notice-sim">${escapeHtml(st.error)}</p>` : '') +
        `<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="issue"${st.busy ? ' disabled' : ''}>${st.busy ? 'Basılıyor…' : 'Kartı oluştur ve yazdır'}</button></div>`;
    m.body.innerHTML = `<div class="pl-form-actions">${controls}</div>${cardHtml(c)}`;
  }
  draw();

  // GKK yazılırken yalnız kartın hücresi güncellenir (yeniden çizme odağı kaybettirir).
  m.body.addEventListener('input', (ev) => {
    if (ev.target.name !== 'gkk') return;
    st.gkk = ev.target.value;
    const cell = m.body.querySelector('.pl-c-gkk');
    if (cell) cell.textContent = st.gkk.trim() === '' ? ' ' : st.gkk;
  });
  m.body.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { m.close(); return; }
    if (act === 'print') { printNow(); return; }
    if (act === 'sheet' && st.card) { m.close(); openMeasureSheet(st.card.id); return; }
    if (act === 'issue' && !st.busy) {
      st.busy = true;
      st.error = null;
      draw();
      try {
        const gkk = st.gkk.trim();
        st.card = await post(`/api/planning/work-orders/${encodeURIComponent(woNo)}/cards`, {
          person: rememberedPerson(), ...(gkk !== '' && gkk !== (w.gkkReportNo ?? '') ? { gkkReportNo: gkk } : {}),
        });
        onDone?.(st.card);
        st.busy = false;
        draw();
        setTimeout(printNow, 80); // kart çizildikten sonra yazdır
      } catch (err) {
        st.busy = false;
        st.error = `Kart basılamadı: ${err.message}`;
        draw();
      }
    } else if (act === 'void' && st.card) {
      const why = window.prompt('Kart neden iptal ediliyor? (en az 3 karakter)', 'Yanlış basıldı');
      if (!why) return;
      try {
        await post(`/api/planning/crates/${st.card.id}/void`, { reason: why });
        onDone?.();
        m.close();
      } catch (err) {
        window.alert(err.message);
      }
    }
  });
}

/** Basılmış bir kartı (kasa kaydını) yeniden göster ve yazdır (kayıp/yırtık kart; aynı numara). @param {number} id kasa kimliği */
export async function openCrateCard(id) {
  const m = openModal({ title: 'Ürün tanıtım kartı', wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let c;
  try {
    c = await api(`/api/planning/crates/${encodeURIComponent(id)}`);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Kart alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button>' +
    '<button type="button" class="icon-btn" data-act="sheet">Ölçü kontrol föyü…</button></div>' +
    '<p class="hint pl-form-actions">Kart A5 dikey basılır. Aynı kart numarası yeniden basılır; kayıp kart için de bu kullanılır.</p>' +
    cardHtml({ ...c, issuedAt: c.closedAt ?? c.openedAt });
  m.body.querySelector('[data-act="print"]').addEventListener('click', printNow);
  m.body.querySelector('[data-act="sheet"]').addEventListener('click', () => { m.close(); openMeasureSheet(id); });
}

/** İş emri ayrıntısındaki "Kartlar" paneli: kart no, basılma zamanı, tezgah sayacı, sayılan (tahmin), paketlenen, fark. @param {object} w iş emri (crates ile) */
export function cratesHtml(w) {
  const c = w.crates;
  const canIssue = w.status === 'uretimde' || w.status === 'bitti';
  if (!c || (c.items.length === 0 && !canIssue)) return '<section class="pl-prog" data-role="crates" hidden></section>';
  const t = c.totals;
  const rows = c.items.map((k) =>
    `<tr><td class="mono"><b>${escapeHtml(k.cardNo)}</b></td><td>${k.closedAt ? escapeHtml(dateTimeText(k.closedAt)) : '<span class="is-null">açık kasa</span>'}</td>` +
    `<td class="num">${k.startTotal == null ? cellText(null) : escapeHtml(plain(k.startTotal))} → ${k.endTotal == null ? (k.state === 'acik' ? '…' : cellText(null)) : escapeHtml(plain(k.endTotal))}</td>` +
    `<td class="num">${k.countedQty == null ? cellText(null) : `~${fmtNum(k.countedQty)}`}</td><td class="num">${k.packedQty == null ? cellText(null) : fmtNum(k.packedQty)}</td>` +
    `<td class="num">${k.packDiff == null ? cellText(null) : escapeHtml(sign(k.packDiff))}</td><td>${crateStateChip(k.state)}</td>` +
    `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="crate-card" data-id="${k.id}">Kart</button> <button type="button" class="icon-btn icon-btn-sm" data-act="crate-sheet" data-id="${k.id}">Ölçü föyü</button>` +
    `${k.state === 'paketlendi' ? '' : ` <button type="button" class="icon-btn icon-btn-sm" data-act="crate-void" data-id="${k.id}" data-card="${escapeHtml(k.cardNo)}">İptal…</button>`}</td></tr>`).join('');
  return (
    '<section class="pl-prog" data-role="crates">' +
    '<div class="dt-block-head"><h4 class="sub">Ürün tanıtım kartları</h4>' +
    `${canIssue ? '<div class="dt-actions"><button type="button" class="icon-btn" data-act="measure">Ölçü kontrolü…</button><button type="button" class="icon-btn btn-primary" data-act="issue-card">Ürün tanıtım kartı bas…</button></div>' : ''}</div>` +
    '<p class="hint">Her kart bir kasadır. <b>Sayılan</b> adet, önceki karttan bu yana tezgahın sayacından hesaplanır (tahmin); <b>kesin</b> adet paketlemede girilir; fark gizlenmez.</p>' +
    (c.items.length === 0 ? '<p class="empty">Henüz kart basılmadı.</p>'
      : '<table class="tbl tbl-pl"><thead><tr><th>Kart no</th><th>Basıldı</th><th class="num">Tezgah sayacı</th><th class="num">Sayılan</th><th class="num">Paketlenen</th><th class="num">Fark</th><th>Durum</th><th></th></tr></thead>' +
        `<tbody>${rows}</tbody></table>` +
        `<p class="hint">${fmtNum(t.count)} kart · sayılan ~${fmtNum(t.counted)} · paketlenen ${fmtNum(t.packed)}${t.unpacked > 0 ? ` · <b>${t.unpacked} kasa paketleme bekliyor</b>` : ''}` +
        `${t.unassigned != null && t.unassigned > 0 ? ` · kasaya atanmayan ~${fmtNum(t.unassigned)} adet (henüz kart basılmamış)` : ''}</p>`) +
    '</section>'
  );
}
