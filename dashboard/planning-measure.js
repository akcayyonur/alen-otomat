/**
 * ÖLÇÜ KONTROLÜ (EYS.FR.005): iş emrinde üretilen ürünlerin saatlik ölçümleri; ürün tanıtım kartına (kasaya) bağlı föy.
 *
 *   - Tezgah başında usta saatlik ölçümü girer: bir yarım saatlik SÜTUN (varsayılan: şimdi) için ölçü satırlarının değerleri (ör. Ø34,2 → 34,13)
 *     ve üç kontrol: Görsel Kontrol, Geçer Mastarlar, Geçmez Mastarlar (uygun / uygun değil). Tolerans dışı değer ▲ ile işaretlenir
 *     (renk tek başına anlam taşımaz) ve "makine durdurulur, bölüm sorumlusuna bilgi verilir" uyarısı çıkar (formun notu).
 *   - Ölçü satırları (adı, nominal, alt/üst sapma) iş emrinde bir kez tanımlanır; aynı ürünün sonraki iş emri planı otomatik alır.
 *   - Kart basılınca o karta düşen ölçümler kartın FÖYÜNE yazılır: kâğıt formun düzeni (gündüz 07:30–19:00, gece 19:30–07:00; A4 yatay).
 * Hesaplar ve kurallar sunucuda (backend/planning/measure.js, planning.js); burası gösterim ve istek.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, fmtNum, openModal, rememberedPerson, rememberPerson, isAdminRole, printModal } from './planning-common.js';

const SLOT_MS = 30 * 60_000;
const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const dayLabel = (ms) => new Date(ms).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
const fmt = (v) => (v === null || v === undefined ? '' : String(Number(v.toFixed(4))).replace('.', ','));

const CHECKS = Object.freeze([
  { kind: 'gorsel', label: 'Görsel Kontrol' },
  { kind: 'gecer', label: 'Geçer Mastarlar' },
  { kind: 'gecmez', label: 'Geçmez Mastarlar' },
]);

/** İstemci tarafı tolerans değerlendirmesi (sunucudakiyle aynı kural; yalnız yazarken anlık işaret için). */
function judge(row, value) {
  if (!row || value === null || Number.isNaN(value) || row.nominal == null) return null;
  const eps = 1e-9;
  if (row.lower != null && value < row.nominal + row.lower - eps) return 'dusuk';
  if (row.upper != null && value > row.nominal + row.upper + eps) return 'yuksek';
  return row.lower == null && row.upper == null ? null : 'ok';
}
const parseVal = (raw) => {
  const t = String(raw ?? '').trim().replace(/\s+/g, '');
  if (t === '') return null;
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return NaN;
  return Number(t.replace(',', '.'));
};
const limitText = (r) => {
  if (r.nominal == null) return '';
  if (r.min == null && r.max == null) return `nominal ${fmt(r.nominal)}`;
  return `${r.min == null ? '…' : fmt(r.min)} – ${r.max == null ? '…' : fmt(r.max)}`;
};

/* ====================================================================== giriş penceresi */

/** Saatlik ölçüm girişi (tezgah başı). @param {string} woNo @param {() => void} [onDone] */
export async function openMeasureDialog(woNo, onDone = () => {}) {
  const m = openModal({ title: `Ölçü kontrolü · ${woNo}`, wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  const st = { data: null, slot: null, touched: new Set(), checks: {}, busy: false, error: null, ok: null, warnings: [] };

  async function load() {
    st.data = await api(`/api/planning/work-orders/${encodeURIComponent(woNo)}/measurements`);
    if (st.slot == null) st.slot = st.data.currentSlot;
  }
  try { await load(); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }

  const saved = () => st.data.slots.find((s) => s.slot === st.slot) ?? null;

  function draw() {
    const d = st.data;
    const head = `<p class="pl-wohead"><b class="mono">${escapeHtml(d.woNo)}</b> · ${escapeHtml(d.stockCode)} ${escapeHtml(d.productName ?? '')} · ${escapeHtml(d.machineId ?? '')}</p>`;
    if (d.status !== 'uretimde' && d.status !== 'bitti') {
      m.body.innerHTML = `${head}<p class="notice notice-sim">Ölçü kontrolü yalnız üretimdeki ya da bitmiş iş emrinde girilir.</p>`;
      return;
    }
    if (d.plan.length === 0) {
      m.body.innerHTML = `${head}<p class="notice">Bu iş emri için ölçüler tanımlı değil. Önce ölçü satırlarını yazın (ör. <b>Ø34,2</b>, nominal 34,2, alt sapma −0,1, üst sapma 0). Aynı ürünün sonraki iş emirleri bunu otomatik alır.</p>` +
        '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="plan">Ölçüleri tanımla…</button></div>';
      return;
    }
    const cur = saved();
    const isNow = st.slot === d.currentSlot;
    const rowsHtml = d.plan.map((r, i) => {
      const v = cur?.values[i + 1]?.value ?? null;
      return `<tr data-row="${i + 1}"><td class="num"><b>${i + 1}</b></td><td><b>${escapeHtml(r.label)}</b>${limitText(r) ? `<br><small class="hint">${escapeHtml(limitText(r))}</small>` : ''}</td>` +
        `<td><input class="ms-in" name="v${i + 1}" inputmode="decimal" autocomplete="off" value="${escapeHtml(fmt(v))}" aria-label="${escapeHtml(r.label)} ölçüsü"></td><td class="ms-st" data-st="${i + 1}"></td></tr>`;
    }).join('');
    const checkHtml = CHECKS.map((c) => {
      const val = st.touched.has(c.kind) ? st.checks[c.kind] : (cur?.checks[c.kind] ?? null);
      const btn = (v, label) => `<button type="button" data-check="${c.kind}" data-v="${v}" aria-pressed="${String(val) === v || (v === '' && val === null)}"${(String(val) === v || (v === '' && val === null)) ? ' class="is-on"' : ''}>${label}</button>`;
      return `<tr><td colspan="2"><b>${c.label}</b></td><td colspan="2"><div class="seg ms-seg" role="group" aria-label="${c.label}">${btn('true', '✓ Uygun')}${btn('false', '✕ Uygun değil')}${btn('', '— boş')}</div></td></tr>`;
    }).join('');
    const recent = d.slots.slice(-8).reverse().map((s) => {
      const cells = d.plan.map((_, i) => {
        const v = s.values[i + 1];
        return `<td class="num">${v ? `${v.status === 'yuksek' ? '▲ ' : v.status === 'dusuk' ? '▼ ' : ''}${escapeHtml(fmt(v.value))}` : '<span class="is-null">—</span>'}</td>`;
      }).join('');
      const marks = CHECKS.map((c) => (s.checks[c.kind] === true ? '✓' : s.checks[c.kind] === false ? '✕' : '·')).join(' ');
      return `<tr><td>${escapeHtml(dayLabel(s.slot))} <b>${escapeHtml(hm(s.slot))}</b></td>${cells}<td class="mono">${marks}</td><td>${s.card ? `<span class="mono">${escapeHtml(s.card.cardNo)}</span>` : '<span class="hint">kart bekliyor</span>'}</td></tr>`;
    }).join('');

    m.body.innerHTML = head +
      `<div class="ms-nav"><button type="button" class="icon-btn shop-btn" data-act="prev" aria-label="Önceki sütun">◀</button>` +
      `<div class="ms-slot"><b>${escapeHtml(dayLabel(st.slot))} ${escapeHtml(hm(st.slot))}</b><small class="hint">${isNow ? 'şimdiki sütun' : 'geçmiş sütun'}${cur ? ' · kayıtlı: düzeltebilirsiniz' : ''}</small></div>` +
      `<button type="button" class="icon-btn shop-btn" data-act="next" aria-label="Sonraki sütun"${isNow ? ' disabled' : ''}>▶</button>` +
      '<button type="button" class="icon-btn" data-act="plan">Ölçüleri düzenle…</button></div>' +
      '<form autocomplete="off" data-role="form"><div class="table-wrap"><table class="tbl tbl-pl ms-tbl"><thead><tr><th class="num">#</th><th>Ölçü</th><th>Değer</th><th>Durum</th></tr></thead>' +
      `<tbody>${rowsHtml}${checkHtml}</tbody></table></div>` +
      '<label class="fld ms-person"><span>Yapan kişi (isteğe bağlı)</span><input name="person" maxlength="60" autocomplete="off"></label>' +
      (st.error ? `<p class="notice notice-sim">${escapeHtml(st.error)}</p>` : '') +
      (st.ok ? `<p class="notice">${escapeHtml(st.ok)}</p>` : '') +
      (st.warnings.length ? `<ul class="pl-warns">${st.warnings.map((x) => `<li class="notice notice-sim">▲ ${escapeHtml(x)}</li>`).join('')}</ul>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      `<button type="submit" class="icon-btn btn-primary"${st.busy ? ' disabled' : ''}>${st.busy ? 'Kaydediliyor…' : 'Ölçümü kaydet'}</button></div></form>` +
      `<h4 class="sub">Son ölçümler</h4>${d.slots.length === 0 ? '<p class="empty">Henüz ölçüm girilmedi.</p>'
        : `<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Sütun</th>${d.plan.map((r) => `<th class="num">${escapeHtml(r.label)}</th>`).join('')}<th>G · Ge · Gm</th><th>Kart</th></tr></thead><tbody>${recent}</tbody></table></div>`}` +
      '<p class="hint">Kontrol planıyla farklı bir frekans belirtilmedikçe 2 adet numune kontrol edilir; hatalı ürün bulunursa makine durdurulur ve bölüm sorumlusuna bilgi verilir. ' +
      'Görsel kontrolde çapak, yüzey, çatlak ve kademe kontrolleri yapılır.</p>';
    const form = m.body.querySelector('form');
    form.elements.person.value = rememberedPerson();
    refreshStatus();
    const first = form.querySelector('.ms-in');
    if (first && !cur) first.focus();
  }

  /** Yazarken tolerans durumunu satır sonunda göster (▲/▼/✓: renk tek başına değil). */
  function refreshStatus() {
    const form = m.body.querySelector('form');
    if (!form) return;
    st.data.plan.forEach((r, i) => {
      const cell = form.querySelector(`[data-st="${i + 1}"]`);
      const raw = form.elements[`v${i + 1}`].value;
      const v = parseVal(raw);
      if (Number.isNaN(v)) { cell.innerHTML = '<span class="chip chip-bad">✕ sayı değil</span>'; return; }
      const s = judge(r, v);
      cell.innerHTML = s === null ? '' : s === 'ok' ? '<span class="chip chip-ok">✓ uygun</span>' : `<span class="chip chip-bad">${s === 'yuksek' ? '▲ tolerans dışı (yüksek)' : '▼ tolerans dışı (düşük)'}</span>`;
    });
  }

  m.body.addEventListener('input', (ev) => { if (ev.target.matches('.ms-in')) refreshStatus(); });
  m.body.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    const chk = ev.target.closest('[data-check]');
    if (chk) {
      const kind = chk.dataset.check;
      st.touched.add(kind);
      st.checks[kind] = chk.dataset.v === '' ? null : chk.dataset.v === 'true';
      for (const b of m.body.querySelectorAll(`[data-check="${kind}"]`)) {
        const on = b === chk;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      return;
    }
    if (act === 'close') { m.close(); return; }
    if (act === 'prev' || act === 'next') {
      const next = st.slot + (act === 'prev' ? -SLOT_MS : SLOT_MS);
      if (next > st.data.currentSlot || next < st.data.currentSlot - 72 * 3_600_000) return;
      st.slot = next; st.touched.clear(); st.checks = {}; st.error = null; st.ok = null; st.warnings = [];
      draw();
      return;
    }
    if (act === 'plan') { openMeasurePlanDialog(woNo, async () => { try { await load(); } catch { /* yenilenemedi */ } draw(); onDone(); }); }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (st.busy) return;
    const form = ev.target;
    const values = {};
    let any = false;
    st.data.plan.forEach((_, i) => {
      const raw = form.elements[`v${i + 1}`].value;
      values[i + 1] = raw;
      if (raw.trim() !== '') any = true;
    });
    const checks = {};
    for (const k of st.touched) { checks[k] = st.checks[k] ?? null; if (st.checks[k] !== null && st.checks[k] !== undefined) any = true; }
    const person = form.elements.person.value;
    if (!any && !saved()) { st.error = 'Önce en az bir ölçü ya da kontrol girin.'; st.ok = null; draw(); return; }
    rememberPerson(person);
    st.busy = true; st.error = null; st.ok = null;
    try {
      const r = await post(`/api/planning/work-orders/${encodeURIComponent(woNo)}/measurements`, { slot: st.slot, values, checks, person });
      st.data = r;
      st.warnings = r.warnings ?? [];
      st.touched.clear(); st.checks = {};
      st.ok = `${hm(st.slot)} sütunu kaydedildi.`;
      onDone();
    } catch (err) {
      st.error = err.message;
    }
    st.busy = false;
    draw();
  });
  draw();
}

/* ====================================================================== plan düzenleyici */

/**
 * Ölçü satırları: ad, nominal, alt/üst sapma (en çok 10). Her ürünün ölçüleri ve SAYISI farklıdır (biri 3, biri 5 ölçü).
 * Hedef bir iş emri (`{woNo}`) ya da ürün kartının KALICI planı (`{stockCode}`; yeni iş emirleri bunu kopyalar) olabilir.
 * @param {string|{woNo?: string, stockCode?: string}} target dize: iş emri no @param {() => void} [onDone]
 */
export async function openMeasurePlanDialog(target, onDone = () => {}) {
  const t = typeof target === 'string' ? { woNo: target } : target;
  const forProduct = !t.woNo;
  const m = openModal({ title: forProduct ? `Ürün ölçü planı · ${t.stockCode}` : `Ölçü satırları · ${t.woNo}`, wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let head;
  let plan;
  let productCode = null;
  try {
    if (forProduct) {
      const p = await api(`/api/planning/products/${encodeURIComponent(t.stockCode)}`);
      head = `<b class="mono">${escapeHtml(p.stockCode)}</b> ${escapeHtml(p.name ?? '')}`;
      plan = p.measurePlan;
    } else {
      const data = await api(`/api/planning/work-orders/${encodeURIComponent(t.woNo)}/measurements`);
      head = `<b class="mono">${escapeHtml(data.woNo)}</b> · ${escapeHtml(data.stockCode)} ${escapeHtml(data.productName ?? '')}`;
      plan = data.plan;
      productCode = data.stockCode;
    }
  } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  const rows = plan.map((r) => ({ label: r.label, nominal: fmt(r.nominal), lower: fmt(r.lower), upper: fmt(r.upper) }));
  if (rows.length === 0) rows.push({ label: '', nominal: '', lower: '', upper: '' });
  let error = null;
  let toProduct = isAdminRole(); // yönetici bir iş emrinde tanımlıyorsa varsayılan: ürün kartına da kaydet

  function draw() {
    m.body.innerHTML =
      `<p class="pl-wohead">${head}</p>` +
      '<p class="hint">Her satır ölçülecek bir özelliktir; <b>kaç satır olacağı ürüne göre değişir</b> (3 ölçü, 5 ölçü ...; en çok 10). <b>Nominal</b> ve <b>sapmalar</b> yazılırsa tolerans dışı değerler otomatik işaretlenir. ' +
      'Alt sapmayı eksi işaretiyle yazın: <b>Ø34,2 −0,1/+0</b> → nominal 34,2 · alt −0,1 · üst 0. Sapma gerekmiyorsa boş bırakın.</p>' +
      '<form autocomplete="off"><div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th class="num">#</th><th>Ölçü adı</th><th>Nominal</th><th>Alt sapma</th><th>Üst sapma</th><th></th></tr></thead><tbody>' +
      rows.map((r, i) => `<tr data-i="${i}"><td class="num"><b>${i + 1}</b></td>` +
        `<td><input name="label${i}" maxlength="40" value="${escapeHtml(r.label)}" placeholder="ör. Ø34,2" class="ms-in-w"></td>` +
        `<td><input name="nominal${i}" inputmode="decimal" value="${escapeHtml(r.nominal)}" class="ms-in"></td>` +
        `<td><input name="lower${i}" inputmode="decimal" value="${escapeHtml(r.lower)}" placeholder="−0,1" class="ms-in"></td>` +
        `<td><input name="upper${i}" inputmode="decimal" value="${escapeHtml(r.upper)}" placeholder="0" class="ms-in"></td>` +
        `<td><button type="button" class="icon-btn icon-btn-sm" data-act="del" data-i="${i}" aria-label="${i + 1}. satırı sil">Sil</button></td></tr>`).join('') +
      '</tbody></table></div>' +
      (!forProduct && isAdminRole() && productCode
        ? `<label class="chk"><input type="checkbox" name="toProduct"${toProduct ? ' checked' : ''}> Ürün kartına da kaydet <span class="hint" style="margin:0">(${escapeHtml(productCode)}: sonraki iş emirleri bu ölçüleri hazır alır)</span></label>`
        : forProduct ? '<p class="hint">Bu plan ürün kartında KALICI durur: bu ürün için açılacak yeni iş emirleri bu ölçülerle gelir. Açık iş emirleri etkilenmez.</p>'
          : '<p class="hint">Aynı ürünün sonraki iş emirleri bu planı otomatik alır.</p>') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      `<div class="dt-actions"><button type="button" class="icon-btn" data-act="add"${rows.length >= 10 ? ' disabled' : ''}>＋ Ölçü ekle</button>` +
      '<button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>';
  }
  const read = () => {
    const f = m.body.querySelector('form');
    rows.forEach((r, i) => { r.label = f.elements[`label${i}`].value; r.nominal = f.elements[`nominal${i}`].value; r.lower = f.elements[`lower${i}`].value; r.upper = f.elements[`upper${i}`].value; });
    if (f.elements.toProduct) toProduct = f.elements.toProduct.checked;
  };
  m.body.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { m.close(); return; }
    if (act === 'add' && rows.length < 10) { read(); rows.push({ label: '', nominal: '', lower: '', upper: '' }); error = null; draw(); }
    if (act === 'del') { read(); rows.splice(Number(ev.target.closest('[data-i]').dataset.i), 1); error = null; draw(); }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    read();
    const payload = rows.filter((r) => r.label.trim() !== '' || r.nominal.trim() !== '' || r.lower.trim() !== '' || r.upper.trim() !== '');
    try {
      if (forProduct) await put(`/api/planning/products/${encodeURIComponent(t.stockCode)}/measure-plan`, { rows: payload });
      else await put(`/api/planning/work-orders/${encodeURIComponent(t.woNo)}/measure-plan`, { rows: payload, ...(toProduct && isAdminRole() ? { saveToProduct: true } : {}) });
      m.close();
      onDone();
    } catch (err) {
      error = err.message;
      draw();
    }
  });
  draw();
}

/* ====================================================================== föy (kâğıt form) */

const toForm = (slotMs) => {
  const d = new Date(slotMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const offset = minutes - 450;
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (offset >= 0 ? 0 : 1));
  return { date, index: (offset >= 0 ? offset : 1440 + offset) / 30 };
};
const slotLabel = (index) => { const t = (450 + index * 30) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
const dateKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Kâğıt formun düzeni: gündüz bloğu (07:30 … 19:00) ve gece bloğu (19:30 … 07:00); satırlar 1…10 + Görsel / Geçer / Geçmez.
 * Tolerans dışı değerler ▲/▼ ile işaretlidir (siyah-beyaz baskıda da okunur).
 * @param {object} sheet /api/planning/crates/:id/sheet yanıtı
 */
export function sheetHtml(sheet) {
  // form günlerine göre grupla (kart birden çok günü kapsayabilir)
  const days = new Map();
  for (const s of sheet.slots) {
    const { date, index } = toForm(s.slot);
    const key = dateKeyOf(date);
    if (!days.has(key)) days.set(key, { date, cells: new Map() });
    days.get(key).cells.set(index, s);
  }
  if (days.size === 0) {
    const { date } = toForm(sheet.card?.issuedAt ?? sheet.slots.at(-1)?.slot ?? Date.now());
    days.set(dateKeyOf(date), { date, cells: new Map() });
  }
  const plan = sheet.plan;
  const block = (cells, from, to) => {
    const idx = Array.from({ length: to - from }, (_, i) => from + i);
    const head = `<tr><th class="ms-lbl">ÖLÇÜ KONTROLÜ</th>${idx.map((i) => `<th>${slotLabel(i)}</th>`).join('')}</tr>`;
    // Satır sayısı ürüne göre değişir: tanımlı ölçü kadar satır basılır (3 ölçü, 5 ölçü ...); hiç tanımlı değilse kâğıt gibi 10 boş satır.
    const rows = Array.from({ length: plan.length > 0 ? plan.length : 10 }, (_, r) => {
      const p = plan[r];
      const label = p ? `${r + 1}. ${escapeHtml(p.label)}${limitText(p) ? `<small>${escapeHtml(limitText(p))}</small>` : ''}` : `${r + 1}.`;
      return `<tr><th class="ms-lbl">${label}</th>${idx.map((i) => {
        const v = cells.get(i)?.values[r + 1];
        if (!v) return '<td></td>';
        return `<td class="${v.status === 'dusuk' || v.status === 'yuksek' ? 'ms-bad' : ''}">${v.status === 'yuksek' ? '▲' : v.status === 'dusuk' ? '▼' : ''}${escapeHtml(fmt(v.value))}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const checks = sheet.checks.map((c) => `<tr class="ms-chk"><th class="ms-lbl">${escapeHtml(c.label)}</th>${idx.map((i) => {
      const ok = cells.get(i)?.checks[c.kind];
      return `<td>${ok === true ? '✓' : ok === false ? '✕' : ''}</td>`;
    }).join('')}</tr>`).join('');
    return `<table class="pl-ms-t"><thead>${head}</thead><tbody>${rows}${checks}</tbody></table>`;
  };
  const w = sheet.wo;
  return [...days.values()].map(({ date, cells }) =>
    '<div class="pl-ms">' +
    `<div class="pl-ms-head"><div class="pl-ms-title">${sheet.card ? 'ÖLÇÜ KONTROL FÖYÜ' : 'ÖLÇÜ KONTROL RAPORU'}</div><div class="pl-ms-meta">` +
    (sheet.card ? `<span><span class="pl-c-label">KART NO:</span> <b>${escapeHtml(sheet.card.cardNo)}</b></span>` : '') +
    `<span><span class="pl-c-label">İŞ EMRİ NO:</span> <b>${escapeHtml(w.no)}</b></span>` +
    `<span><span class="pl-c-label">ALEN ÜRÜN KODU:</span> <b>${escapeHtml(w.stockCode)}</b></span>` +
    `<span><span class="pl-c-label">MAKİNA NO:</span> <b>${escapeHtml(String(w.machineNumber ?? w.machineId ?? ''))}</b></span>` +
    `<span><span class="pl-c-label">TARİH:</span> <b>${escapeHtml(date.toLocaleDateString('tr-TR'))}</b></span></div></div>` +
    (sheet.card ? '' : cardsLine(sheet)) +
    block(cells, 0, 24) +
    '<p class="pl-ms-note">* Kontrol Planı ile farklı bir frekans belirtilmedikçe 2 Adet numune kontrol edilip hatalı ürün bulunması durumunda makine durdurularak bölüm sorumlusuna bilgi verilir. ' +
    '*Görsel kontrol esnasında çapak, yüzey kontrolü (çapak vb.) çatlak ve kademe kontrolleri yapılır.</p>' +
    block(cells, 24, 48) +
    '<p class="pl-ms-foot">EYS.FR.005 · YAYIN TAR: 18.09.2024 · REV NO: 2 · REV TARİHİ: 02.03.2026 · Sistemden basıldı ' + escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false })) + '</p>' +
    '</div>').join('');
}

/** İş emri raporunun üstündeki satır: hangi kartta kaç sütun var, karta bağlanmamış (kart bekleyen) kaç sütun. */
function cardsLine(sheet) {
  const parts = (sheet.cards ?? []).map((c) => `${escapeHtml(c.cardNo)} (${c.columns} sütun)`);
  if (sheet.pending > 0) parts.push(`kart bekleyen: ${sheet.pending} sütun`);
  return parts.length ? `<p class="pl-ms-cards"><span class="pl-c-label">KARTLAR:</span> ${parts.join(' · ')}</p>` : '';
}

/** Ürün tanıtım kartının ölçü kontrol föyünü göster ve yazdır (A4 yatay). @param {number} crateId */
export async function openMeasureSheet(crateId) {
  const m = openModal({ title: 'Ölçü kontrol föyü', wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let sheet;
  try { sheet = await api(`/api/planning/crates/${encodeURIComponent(crateId)}/sheet`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Föy alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    `<p class="hint pl-form-actions">${fmtNum(sheet.slots.length)} sütun ölçüm bu karta (${escapeHtml(sheet.card.cardNo)}) ait. Föy A4 yatay basılır; ölçü satırları ${sheet.plan.length === 0 ? 'tanımlı değil (iş emrinden tanımlanır)' : `${sheet.plan.length} adet`}.</p>` +
    `<div class="pl-ms-scroll">${sheetHtml(sheet)}</div>`;
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}

/**
 * Bir iş emrinin TÜM ölçümleri tek raporda (kartlara bölünmeden): kalite kontrole ve paketlemeye giden rapor. Herkes görür (izleyici dahil).
 * @param {string} woNo
 */
export async function openMeasureReport(woNo) {
  const m = openModal({ title: `Ölçü raporu · ${woNo}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let rep;
  try { rep = await api(`/api/planning/work-orders/${encodeURIComponent(woNo)}/measure-report`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Rapor alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    `<p class="hint pl-form-actions">${fmtNum(rep.slots.length)} sütun ölçüm · ${rep.plan.length === 0 ? 'ölçü satırları tanımlı değil' : `${rep.plan.length} ölçü satırı`}. Rapor A4 yatay basılır.</p>` +
    `<div class="pl-ms-scroll">${rep.slots.length === 0 && rep.plan.length === 0 ? '<p class="empty">Bu iş emrinde ölçü yok.</p>' : sheetHtml(rep)}</div>`;
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}
