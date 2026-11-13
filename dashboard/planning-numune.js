/**
 * Planlama > Numune takip (EYS.FR.012 "Numune Talep / Takip Formu"): müşteriye numune üretilip gönderilmesi ve
 * müşteriden gelen onay/ret geri bildiriminin takibi. `products` tablosuyla HİÇ BAĞLANMAZ (ürün kartı henüz
 * olmayabilir — kâğıt formdaki ALEN ÜRÜN KODU boş kalabilir, serbest metindir).
 *
 * Akış: "Yeni numune formu aç" → NUMUNE TANIMLAMA + NUMUNE ÜRETİM BİLGİLERİ alanları girilir (çoğu isteğe
 * bağlı, zamanla doldurulur) → "Formu oluştur/kaydet" ile kayıt oluşur → "Formu görüntüle/yazdır" ile çıktı
 * alınıp müşteriye gönderilir (fiziksel) → müşteriden e-posta ile gelen karar "Düzenle"den elle işaretlenir:
 * onaylandı / onaylanmadı → satır rengi yeşil/kırmızı (ikon+etiket de var, renk tek başına değil).
 *
 * Kâğıt formdaki "KALİTE KONTROL RAPOR NO" alanı YANLIŞ adlandırılmış: aslında GKK rapor no'dur (kullanıcı
 * teyidi, 2026-11-02) — burada "GKK rapor no" olarak gösterilir, openGkkPicker ile aynı listeden seçilebilir.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import {
  put, del, cellText, fmtNum, fmtDec, dateKey, dateText, debounce, openModal, chip, canWrite, isAdminRole, printModal, openListPrint, truncCell,
  machineOptions, sizeText,
} from './planning-common.js';
import { openGkkPicker } from './planning-gkk.js';

const STATUS_CHIP = Object.freeze({
  bekliyor: chip('warn', '◔', 'karar bekliyor'),
  onaylandi: chip('ok', '✓', 'onaylandı'),
  reddedildi: chip('bad', '✕', 'onaylanmadı'),
});
const rowClass = (status) => (status === 'onaylandi' ? ' pl-done' : status === 'reddedildi' ? ' pl-rejected' : ' pl-waiting');
const isoDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const decInput = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

/* Analiz (ret oranı) için aralık hazır seçimleri: "Bu ay" güncel ayın başından bugüne; "Son N ay" N-1 önceki ayın
   başından bugüne (bu ay dahil N ay) - RANGE_PRESETS'teki (bugun/ay/gecenay/30gun) ile AYNI amaç değil, farklı
   kümeleme, bu yüzden kendi listesi. */
const STATS_PRESETS = Object.freeze([
  { key: 'ay', label: 'Bu ay', range: (n) => [dateKey(new Date(n.getFullYear(), n.getMonth(), 1)), dateKey(n)] },
  { key: '3ay', label: 'Son 3 ay', range: (n) => [dateKey(new Date(n.getFullYear(), n.getMonth() - 2, 1)), dateKey(n)] },
  { key: '6ay', label: 'Son 6 ay', range: (n) => [dateKey(new Date(n.getFullYear(), n.getMonth() - 5, 1)), dateKey(n)] },
  { key: 'yil', label: 'Bu yıl', range: (n) => [dateKey(new Date(n.getFullYear(), 0, 1)), dateKey(n)] },
]);
const pct = (v) => (v == null ? '<span class="is-null">—</span>' : `%${fmtDec(v * 100, 1)}`);

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderSamples(host) {
  const canEdit = canWrite('numune');
  const now = new Date();
  const st = { q: '', status: '', items: [], total: 0, seq: 0 };
  const stStats = { preset: 'ay', from: STATS_PRESETS[0].range(now)[0], to: STATS_PRESETS[0].range(now)[1], data: null, error: null, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Kod, müşteri, müşteri numune/ürün kodu, Alen kodu ara…" aria-label="Numune ara">' +
    '<label class="fld-inline">Durum <select data-role="status"><option value="">Tümü</option><option value="bekliyor">Karar bekliyor</option><option value="onaylandi">Onaylandı</option><option value="reddedildi">Onaylanmadı</option></select></label>' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni numune formu aç</button>' : '') + '</div>' +
    '<h4 class="sub">Analiz · ret oranı</h4>' +
    '<div data-role="stats-panel"></div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>' +
    (isAdminRole() ? '<div data-role="seq-box"></div>' : '');
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  /* --------------------------------------------------------------------------- analiz (ret orani) */

  function drawStats() {
    const bar =
      '<div class="pl-bar"><div class="seg" role="group" aria-label="Analiz aralığı">' +
      STATS_PRESETS.map((p) => `<button type="button" data-stats-preset="${p.key}" class="${stStats.preset === p.key ? 'is-on' : ''}">${escapeHtml(p.label)}</button>`).join('') +
      '</div>' +
      `<label class="fld-inline">Başlangıç <input type="date" data-role="stats-from" value="${escapeHtml(stStats.from)}"></label>` +
      `<label class="fld-inline">Bitiş <input type="date" data-role="stats-to" value="${escapeHtml(stStats.to)}"></label></div>`;
    const d = stStats.data;
    $('stats-panel').innerHTML = bar +
      (stStats.error ? `<p class="notice notice-sim">Analiz alınamadı: ${escapeHtml(stStats.error)}</p>` :
        !d ? '<p class="hint">Yükleniyor…</p>' :
        '<div class="pl-kpis">' +
        `<div class="pl-kpi"><span class="pl-kpi-l">Ret oranı</span><span class="pl-kpi-v">${pct(d.rejectionRate)}</span>` +
        `<small class="hint">${d.decided > 0 ? `${fmtNum(d.decided)} karar · ${fmtNum(d.approved)} onay · ${fmtNum(d.rejected)} ret` : 'bu aralıkta karar verilmiş kayıt yok'}</small></div>` +
        `<div class="pl-kpi"><span class="pl-kpi-l">Talep edilen</span><span class="pl-kpi-v">${fmtNum(d.requested)}</span>` +
        `<small class="hint">${fmtNum(d.pending)} hâlâ karar bekliyor</small></div>` +
        '</div>' +
        '<p class="hint">Ret oranı, <b>karar tarihi</b> (müşteriden onay/ret geldiği tarih) bu aralıkta olan kayıtlardan hesaplanır. "Talep edilen" ise bu aralıkta açılan numune formu sayısıdır (farklı tarih alanı — talebi bu aralıkta ama kararı henüz gelmemiş kayıtlar olabilir).</p>');
  }

  async function loadStats() {
    const seq = ++stStats.seq;
    stStats.error = null;
    drawStats();
    try {
      const d = await api(`/api/planning/samples/stats?${new URLSearchParams({ from: stStats.from, to: stStats.to })}`);
      if (seq !== stStats.seq) return;
      stStats.data = d;
      drawStats();
    } catch (err) {
      if (seq !== stStats.seq) return;
      stStats.error = err.message;
      drawStats();
    }
  }

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q || st.status ? 'Eşleşen numune kaydı yok.' : `Henüz numune kaydı yok.${canEdit ? ' "Yeni numune formu aç" ile başlayın.' : ''}`)
      : `${fmtNum(st.total)} numune kaydı`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kod</th><th>Tarih</th><th>Müşteri</th><th>Müşteri numune/ürün kodu</th><th>Alen ürün kodu</th><th>Durum</th></tr></thead><tbody>' +
      st.items.map((s) =>
        `<tr class="pl-row${rowClass(s.status)}" data-id="${s.id}" tabindex="0"><td class="mono"><b>${escapeHtml(s.code)}</b></td><td>${dateText(s.requestedOn)}</td>` +
        `<td class="trunc"${truncCell(s.customer)}>${cellText(s.customer)}</td>` +
        `<td class="trunc"${truncCell([s.customerSampleCode, s.customerCode].filter(Boolean).join(' · '))}>${cellText([s.customerSampleCode, s.customerCode].filter(Boolean).join(' · ') || null)}</td>` +
        `<td class="mono">${cellText(s.stockCode)}</td><td>${STATUS_CHIP[s.status] ?? s.status}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/samples?${new URLSearchParams({ q: st.q, status: st.status, limit: 300 })}`);
      if (seq !== st.seq) return;
      st.total = r.total; st.items = r.items;
      draw();
      if (isAdminRole()) drawSeq(r.next);
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Numune kayıtları alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  /** Numara taban ayarı (kâğıt defterdeki SERİ NO'yla çakışmasın). Yalnız yönetici. */
  function drawSeq(n) {
    const box = $('seq-box');
    if (!box) return;
    box.innerHTML =
      '<div class="pl-seq-box"><p class="hint-meta">Sıradaki numune kodu: <b class="mono">' + escapeHtml(n.nextCode) + '</b>' +
      (n.floor > 0 || n.max > 0 ? '' : ' <span class="is-null">(taban girilmedi, 000001\'den başlıyor)</span>') + '</p>' +
      '<div class="pl-seq"><input type="text" inputmode="numeric" maxlength="6" data-role="seq-last" placeholder="ör. 219" aria-label="Kâğıt defterde en son verilen numune sıra no">' +
      '<button type="button" class="icon-btn" data-act="seq-set">Bu numaradan devam ettir</button></div>' +
      '<p class="hint">Kâğıt defterde (EYS.FR.012) hâlâ kullanılan bir sıra varsa en son verilen numarayı bir kez buraya girin. Numara yalnız yükseltilebilir, geri alınamaz.</p>' +
      '<p class="notice notice-sim" data-role="seq-err" hidden></p></div>';
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => {
    if (ev.target.dataset?.role === 'status') { st.status = ev.target.value; load(); return; }
    const role = ev.target.dataset?.role;
    if (role === 'stats-from' || role === 'stats-to') {
      if (role === 'stats-from') stStats.from = ev.target.value; else stStats.to = ev.target.value;
      stStats.preset = '';
      if (stStats.from && stStats.to) loadStats();
    }
  };
  host.onclick = (ev) => {
    const statsPreset = ev.target.closest('[data-stats-preset]')?.dataset.statsPreset;
    if (statsPreset) {
      const p = STATS_PRESETS.find((x) => x.key === statsPreset);
      [stStats.from, stStats.to] = p.range(new Date());
      stStats.preset = statsPreset;
      loadStats();
      return;
    }
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="new"]')) { openSampleDialog(null, load); return; }
    if (ev.target.closest('[data-act="print"]')) {
      openListPrint({
        title: 'Numune Talep / Takip Formu Listesi', formNo: 'EYS.FR.012',
        heads: ['Kod', 'Tarih', 'Müşteri', 'Müşteri numune/ürün kodu', 'Alen ürün kodu', 'Durum'],
        rows: st.items.map((s) => [s.code, dateText(s.requestedOn).replace(/<[^>]+>/g, ''), s.customer,
          [s.customerSampleCode, s.customerCode].filter(Boolean).join(' · '), s.stockCode, { bekliyor: 'Karar bekliyor', onaylandi: 'Onaylandı', reddedildi: 'Onaylanmadı' }[s.status] ?? s.status]),
      });
      return;
    }
    const setBtn = ev.target.closest('[data-act="seq-set"]');
    if (setBtn) {
      const box = ev.target.closest('.pl-seq-box');
      const err = box.querySelector('[data-role="seq-err"]');
      err.hidden = true;
      put('/api/planning/samples/sequence', { last: box.querySelector('[data-role="seq-last"]').value })
        .then((n) => drawSeq(n)).catch((e) => { err.textContent = e.message; err.hidden = false; });
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (row) openSampleDialog(Number(row.dataset.id), load);
  };
  loadStats();
  await load();
}

/* ============================================================================================== form / duzenle */

const FIELD_LABEL = Object.freeze({
  customer: 'Müşteri', customerSampleCode: 'Müşteri numune kodu', customerCode: 'Müşteri ürün kodu', stockCode: 'Alen ürün kodu',
  sampleQty: 'Numune miktarı', dueDate: 'Teslim tarihi', quoteNetG: 'Fiyat teklif net ağırlığı (gr)', sampleNetG: 'Numune net ağırlığı (gr)',
  productionSec: 'Üretim süresi (sn)', material: 'Hammadde', altMaterial: 'Alternatif hammadde', gauges: 'Kullanılan mastar/lar',
  producedQty: 'Üretim miktarı', sampleSetQty: 'Ayrılan örnek miktarı', producedOn: 'Üretim tarihi', sentQty: 'Gönderilen miktar',
});

/** Mikro gönderim durumu için küçük bir çip (CLAUDE.md §7: renk tek başına değil, ikon+etiket). */
const mikroChip = (sent, error) => (sent ? chip('ok', '✓', 'gönderildi') : error ? chip('bad', '✕', 'gönderilemedi') : chip('warn', '◔', 'bekliyor'));

/**
 * Numune formu: yeni (id=null) ya da düzenle. Salt okuma rolü (yalnız 'read') formu görür, değiştiremez.
 *
 * Yeni ürün kodu oluşturma (2026-11-13, kullanıcı isteği): yalnız YENİ form açarken (düzenlemede gösterilmez —
 * kod oluşunca sabitlenir, iş emri numarasıyla AYNI ilke), müşteri (sabit 19 grup) + kod öneki (SR/Nİ) seçilince
 * "Alen ürün kodu" alanı sunucudan gelen önizlemeyle dolar ve KİLİTLENİR (elle yazılan değer zaten sunucuda göz
 * ardı edilir, kullanıcı yanılmasın diye alan da devre dışı bırakılır). Her iki seçim de boşaltılırsa alan yine
 * serbest metne döner (eski akış — elle ya da hiç kod girmeden numune açma).
 * @param {number|null} id @param {() => void} [onDone]
 */
export async function openSampleDialog(id, onDone = () => {}) {
  const editable = canWrite('numune');
  const m = openModal({ title: id ? `Numune formu düzenle` : 'Yeni numune formu', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let s = null;
  let machines = [];
  let groups = [];
  try {
    const [meta, grp] = await Promise.all([api('/api/planning/summary').catch(() => ({ machines: [] })), api('/api/planning/samples/customer-groups').catch(() => [])]);
    machines = meta.machines ?? [];
    groups = grp ?? [];
    if (id) {
      s = await api(`/api/planning/samples/${id}`);
      s.drawings = (await api(`/api/planning/samples/${id}/drawings`).catch(() => ({ drawings: [] }))).drawings;
    }
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  let error = null;
  let decideMode = null; // 'onaylandi' | 'reddedildi' | null
  let mikroBusy = null; // 'product' | 'weight' | null
  // Yeni kod uretme (yalniz yeni formda anlamli): secimler + sunucudan gelen onizleme.
  const gen = { group: '', prefix: '', code: '', err: null, loading: false };
  // Hammadde secimi (Mikro'dan canli arama; "elle yazilmasin" - kullanici isteği, 2026-11-13): deger `s`'den
  // ilk acilista alinir, sonrasinda BU state'ten okunur (gen-group deseniyle AYNI gerekce: create modunda `v()`
  // hep null doner, degisiklikler diger alanlari silmeden yalniz bu alana yansitilmali).
  const matState = { material: (s ? s.material : null) ?? '', altMaterial: (s ? s.altMaterial : null) ?? '' };

  const v = (key) => (s ? s[key] : null);
  const txt = (key, label, max, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" value="${escapeHtml(v(key) ?? '')}" maxlength="${max}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;
  const num = (key, label, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" inputmode="decimal" value="${escapeHtml(decInput(v(key)))}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;
  const dt = (key, label) => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" type="date" value="${isoDate(v(key))}"${editable ? '' : ' disabled'}></label>`;

  function groupLabel(code) {
    const g = groups.find((x) => x.code === code);
    return g ? `${g.code} — ${g.name}` : code;
  }

  function newCodeBlockHtml() {
    if (s || !editable) return ''; // yalniz YENI formda; duzenlemede kod sabittir
    const groupOpts = '<option value="">— seçilmedi —</option>' + groups.map((g) => `<option value="${escapeHtml(g.code)}"${g.code === gen.group ? ' selected' : ''}>${escapeHtml(g.code)} — ${escapeHtml(g.name)}</option>`).join('');
    const prefixOpts = ['', 'SR', 'Nİ'].map((p) => `<option value="${escapeHtml(p)}"${p === gen.prefix ? ' selected' : ''}>${p === '' ? '— seçilmedi —' : escapeHtml(p)}</option>`).join('');
    return (
      '<h4 class="sub">Yeni ürün kodu oluştur (isteğe bağlı)</h4>' +
      '<div class="fld-grid">' +
      `<label class="fld"><span>Müşteri (kod grubu)</span><select data-role="gen-group">${groupOpts}</select></label>` +
      `<label class="fld"><span>Kod öneki</span><select data-role="gen-prefix">${prefixOpts}</select></label>` +
      '</div>' +
      `<p class="hint" data-role="gen-hint">${gen.loading ? 'Hesaplanıyor…' : gen.err ? `✕ ${escapeHtml(gen.err)}` : gen.code ? `Sıradaki kod: <b class="mono">${escapeHtml(gen.code)}</b> (kaydedince kesinleşir)` : 'Müşteri ve kod öneki seçilirse Alen ürün kodu otomatik oluşturulur; boş bırakılırsa aşağıya elle de girilebilir.'}</p>`
    );
  }

  function mikroPanelHtml() {
    if (!s || !s.autoGenerated) return '';
    const weightKnown = s.sampleNetG != null;
    const weightSent = weightKnown && s.mikroWeightSentG === s.sampleNetG;
    return (
      '<h4 class="sub">Mikro</h4>' +
      '<div class="pl-kpis">' +
      `<div class="pl-kpi"><span class="pl-kpi-l">Müşteri grubu</span><span class="pl-kpi-v mono">${escapeHtml(groupLabel(s.customerGroupCode))} · ${escapeHtml(s.codePrefix ?? '')}</span></div>` +
      `<div class="pl-kpi"><span class="pl-kpi-l">Mikro ürün kartı</span><span class="pl-kpi-v">${mikroChip(s.mikroProductSent, s.mikroProductError)}</span>` +
      (s.mikroProductError ? `<br><small class="hint">${escapeHtml(s.mikroProductError)}</small>` : '') +
      (editable && !s.mikroProductSent ? `<button type="button" class="icon-btn icon-btn-sm" data-act="retry-product"${mikroBusy ? ' disabled' : ''}>${mikroBusy === 'product' ? 'Deneniyor…' : 'Yeniden dene'}</button>` : '') + '</div>' +
      `<div class="pl-kpi"><span class="pl-kpi-l">Mikro net ağırlık</span><span class="pl-kpi-v">${weightKnown ? mikroChip(weightSent, s.mikroWeightError) : '<span class="is-null">numune net ağırlığı girilince gönderilir</span>'}</span>` +
      (s.mikroWeightError ? `<br><small class="hint">${escapeHtml(s.mikroWeightError)}</small>` : '') +
      (editable && weightKnown && !weightSent ? `<button type="button" class="icon-btn icon-btn-sm" data-act="retry-weight"${mikroBusy ? ' disabled' : ''}>${mikroBusy === 'weight' ? 'Deneniyor…' : 'Yeniden dene'}</button>` : '') + '</div>' +
      '</div>'
    );
  }

  /** Hammadde/Alternatif hammadde: elle yazılmaz, yalnız Mikro aramasından seçilir (kullanıcı isteği, 2026-11-13).
   * `readonly` giriş + "Seç…"/"Değiştir"/"Temizle" düğmeleri; değer `matState`'te tutulur (bkz. yukarıdaki not). */
  function matField(key, label) {
    return `<label class="fld"><span>${escapeHtml(label)}</span><span class="fld-row" data-mat="${key}">` +
      `<input name="${key}" value="${escapeHtml(matState[key])}" maxlength="80" readonly placeholder="— seçilmedi —">` +
      matFieldButtons(key) + '</span></label>';
  }

  function matFieldButtons(key) {
    if (!editable) return '';
    const val = matState[key];
    return `<button type="button" class="icon-btn icon-btn-sm" data-act="pick-material" data-field="${key}">${val ? 'Değiştir' : 'Seç…'}</button>` +
      (val ? `<button type="button" class="icon-btn icon-btn-sm" data-act="clear-material" data-field="${key}">Temizle</button>` : '');
  }

  /** Seçim/temizleme sonrası SADECE o alanın girişini + düğmelerini günceller (tam `draw()` diğer alanları silerdi, gen-group'taki AYNI gerekçe). */
  function refreshMatField(key) {
    const row = m.body.querySelector(`[data-mat="${key}"]`);
    if (!row) return;
    row.querySelector('input').value = matState[key];
    row.querySelectorAll('button').forEach((b) => b.remove());
    row.insertAdjacentHTML('beforeend', matFieldButtons(key));
  }

  /** Teknik resimler (PDF) — yalnız var olan numunede (yeni formda kayıt henüz yok, önce "Formu oluştur" gerekir). */
  function drawingsHtml() {
    if (!s) return '';
    const list = s.drawings ?? [];
    return (
      '<section class="dr-box" data-role="drawings"><h4 class="sub">Teknik resimler (PDF)</h4>' +
      (list.length === 0
        ? '<p class="hint">Henüz PDF yok.</p>'
        : `<ol class="dr-list">${list.map((d) =>
          `<li><span class="dr-name">${escapeHtml(d.name)}</span> <small class="hint">${d.pages} sayfa · ${escapeHtml(sizeText(d.size))}</small> ` +
          `<a href="/api/planning/samples/${s.id}/drawings/${d.id}" target="_blank" rel="noopener">Aç</a>` +
          (editable ? ` <button type="button" class="icon-btn icon-btn-sm" data-act="dr-del" data-id="${d.id}" aria-label="${escapeHtml(d.name)} dosyasını kaldır">Kaldır</button>` : '') +
          '</li>').join('')}</ol>`) +
      (editable ? (list.length >= 8
        ? '<p class="hint">En çok 8 PDF eklenebilir.</p>'
        : '<label class="dr-up"><span class="icon-btn">PDF yükle…</span><input type="file" accept="application/pdf,.pdf" multiple data-role="dr-file" aria-label="Teknik resim PDF dosyaları"></label>') : '') +
      '<p class="notice notice-sim" data-role="dr-err" hidden></p></section>'
    );
  }

  function refreshDrawings() {
    const sec = m.body.querySelector('[data-role="drawings"]');
    if (sec) sec.outerHTML = drawingsHtml();
  }

  /** `wireDrawings` (planning-drawings.js, iş emri teknik resimleri) ile AYNI desen: sırayla yükle, hata çıkınca dur. */
  async function uploadDrawings(files) {
    const box = m.body.querySelector('[data-role="drawings"]');
    const err = (msg) => { const e = box?.querySelector('[data-role="dr-err"]'); if (e) { e.textContent = msg ?? ''; e.hidden = !msg; } };
    err(null);
    box?.querySelector('.dr-up')?.classList.add('is-busy');
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { err(`${f.name}: PDF değil.`); break; }
      try {
        const r = await api(`/api/planning/samples/${s.id}/drawings?${new URLSearchParams({ name: f.name })}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: f });
        s.drawings = r.drawings;
        refreshDrawings();
      } catch (e) {
        err(`${f.name}: ${e.message}`);
        break;
      }
    }
  }

  /** Hammadde seç: Mikro'dan canlı arama (`openGkkPicker` ile AYNI desen; dar, numune-özel uç). */
  async function openMaterialPicker({ current = '', onPick }) {
    const pm = openModal({ title: 'Hammadde seç', wide: true });
    pm.body.innerHTML =
      (current ? `<p class="notice">Şu an seçili: <b class="mono">${escapeHtml(current)}</b></p>` : '') +
      '<input type="search" class="pl-search pl-search-big" data-role="q" placeholder="Hammadde kodu ya da adı…" aria-label="Hammadde ara" autocomplete="off">' +
      '<div class="table-wrap pl-pick" data-role="list"><p class="hint">Aramak için yazın.</p></div>';
    const $$ = (r) => pm.body.querySelector(`[data-role="${r}"]`);
    let seq = 0;
    const rowHtml = (x) =>
      `<tr><td class="mono"><b>${escapeHtml(x.stockCode)}</b></td><td>${escapeHtml(x.name ?? '')}</td><td>${escapeHtml(x.unit ?? '')}</td>` +
      `<td><button type="button" class="icon-btn shop-btn btn-primary" data-pick="${escapeHtml(x.stockCode)}">Seç</button></td></tr>`;
    async function load() {
      const my = ++seq;
      const q = $$('q').value.trim();
      if (!q) { $$('list').innerHTML = '<p class="hint">Aramak için yazın.</p>'; return; }
      try {
        const r = await api(`/api/planning/samples/materials?${new URLSearchParams({ q, limit: 30 })}`);
        if (my !== seq) return;
        $$('list').innerHTML = r.items.length === 0
          ? '<p class="empty">Eşleşen hammadde yok.</p>'
          : `<table class="tbl tbl-pl"><thead><tr><th>Stok kodu</th><th>Ad</th><th>Birim</th><th></th></tr></thead><tbody>${r.items.map(rowHtml).join('')}</tbody></table>`;
      } catch (err) {
        if (my === seq) $$('list').innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
      }
    }
    const search = debounce(load, 200);
    pm.body.addEventListener('input', (ev) => { if (ev.target.dataset?.role === 'q') search(); });
    pm.body.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pick]');
      if (!b) return;
      pm.close();
      onPick(b.dataset.pick);
    });
    $$('q').focus();
  }

  /** Grup/önek secimi degisince SADECE ipucu + Alen kodu alanini guncelle — tam `draw()` kullanicinin o ana kadar
   * yazdigi diger alanlari (musteri numune kodu, miktar...) silerdi (`v()` create modunda hep `s`'den okur, `s` null). */
  function refreshGenUI() {
    const hint = m.body.querySelector('[data-role="gen-hint"]');
    if (hint) {
      hint.innerHTML = gen.loading ? 'Hesaplanıyor…'
        : gen.err ? `✕ ${escapeHtml(gen.err)}`
        : gen.code ? `Sıradaki kod: <b class="mono">${escapeHtml(gen.code)}</b> (kaydedince kesinleşir)`
        : 'Müşteri ve kod öneki seçilirse Alen ürün kodu otomatik oluşturulur; boş bırakılırsa aşağıya elle de girilebilir.';
    }
    const stockInput = m.body.querySelector('input[name="stockCode"]');
    if (stockInput) {
      if (gen.code) { stockInput.value = gen.code; stockInput.readOnly = true; }
      else stockInput.readOnly = !editable;
    }
  }

  const fetchGenPreview = debounce(() => {
    if (!gen.group || !gen.prefix) { gen.code = ''; gen.err = null; gen.loading = false; refreshGenUI(); return; }
    gen.loading = true; gen.err = null; refreshGenUI();
    api(`/api/planning/samples/next-stock-code?${new URLSearchParams({ group: gen.group, prefix: gen.prefix })}`)
      .then((r) => { gen.loading = false; gen.code = r.stockCode; gen.err = null; refreshGenUI(); })
      .catch((e) => { gen.loading = false; gen.code = ''; gen.err = e.message; refreshGenUI(); });
  }, 200);

  function draw() {
    m.body.innerHTML =
      (s ? `<p class="pl-wohead"><b class="mono">${escapeHtml(s.code)}</b> · ${dateText(s.requestedOn)} · ${STATUS_CHIP[s.status]}</p>` : '') +
      '<form autocomplete="off"><h4 class="sub">Numune tanımlama</h4><div class="fld-grid">' +
      txt('customer', 'Müşteri *', 120, ' required') + txt('customerSampleCode', 'Müşteri numune kodu', 60) +
      txt('customerCode', 'Müşteri ürün kodu', 60) +
      `<label class="fld"><span>Alen ürün kodu</span><input name="stockCode" value="${escapeHtml(gen.code || v('stockCode') || '')}" maxlength="40" autocomplete="off"${!editable || (!s && gen.code) || (s && s.autoGenerated) ? ' readonly' : ''}` +
      `${s && s.autoGenerated ? ' title="Otomatik oluşturulan kod sonradan değiştirilemez (ürün kartı ve Mikro kaydı bu kodla bağlı)."' : ''}></label>` +
      txt('sampleQty', 'Numune miktarı', 40, ' placeholder="ör. 1.100 AD."') + dt('dueDate', 'Teslim tarihi') +
      `<label class="fld"><span>Tezgah</span><select name="machineId"${editable ? '' : ' disabled'}>${machineOptions(machines, v('machineId') ?? '', '— seçilmedi —')}</select></label>` +
      '</div>' +
      newCodeBlockHtml() +
      mikroPanelHtml() +
      '<h4 class="sub">Numune üretim bilgileri</h4><div class="fld-grid">' +
      num('quoteNetG', 'Fiyat teklif net ağırlığı (gr)') + num('sampleNetG', 'Numune net ağırlığı (gr)') +
      num('productionSec', 'Üretim süresi (sn)') + matField('material', 'Hammadde') + matField('altMaterial', 'Alternatif hammadde') +
      txt('gauges', 'Kullanılan mastar/lar', 120) + num('producedQty', 'Üretim miktarı') + num('sampleSetQty', 'Ayrılan örnek miktarı') +
      dt('producedOn', 'Üretim tarihi') +
      `<label class="fld"><span>GKK rapor no</span><span class="fld-row"><input name="gkkReportNo" maxlength="40" autocomplete="off" value="${escapeHtml(v('gkkReportNo') ?? '')}"${editable ? '' : ' readonly'}>` +
      (editable ? '<button type="button" class="icon-btn icon-btn-sm" data-act="pick-gk">Listeden seç…</button>' : '') + '</span></label>' +
      num('sentQty', 'Gönderilen miktar') +
      '</div>' +
      drawingsHtml() +
      `<label class="fld"><span>Müşteri geri bildirim</span><textarea name="customerFeedback" rows="3" maxlength="2000"${editable ? '' : ' readonly'}>${escapeHtml(v('customerFeedback') ?? '')}</textarea></label>` +
      `<label class="fld"><span>Not</span><input name="note" maxlength="500" autocomplete="off" value="${escapeHtml(v('note') ?? '')}"${editable ? '' : ' readonly'}></label>` +
      (decideMode
        ? `<div class="notice${decideMode === 'reddedildi' ? ' notice-sim' : ''}"><b>${decideMode === 'onaylandi' ? 'Seri üretim onaylandı' : 'Numune onaylanmadı'} olarak işaretlenecek.</b></div>` +
          `<label class="fld"><span>${decideMode === 'onaylandi' ? 'Seri üretim onay tarihi' : 'Karar tarihi'}</span><input name="decidedOn" type="date" value="${isoDate(Date.now())}"></label>` +
          `<label class="fld"><span>${decideMode === 'onaylandi' ? 'Not (isteğe bağlı)' : 'Ret sebebi ve müşteri rapor no'}</span><textarea name="decisionNote" rows="2" maxlength="1000">${escapeHtml(s?.status === decideMode ? (s.decisionNote ?? '') : '')}</textarea></label>` +
          '<div class="dt-actions"><button type="button" class="icon-btn" data-act="decide-cancel">Vazgeç</button>' +
          `<button type="submit" class="icon-btn btn-primary" data-act="decide-save">${decideMode === 'onaylandi' ? 'Onaylandı olarak kaydet' : 'Onaylanmadı olarak kaydet'}</button></div>`
        : '') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions">' +
      (s ? '<button type="button" class="icon-btn" data-act="view">Formu görüntüle/yazdır</button>' : '') +
      (editable && !decideMode ? [
        s && s.status !== 'onaylandi' ? '<button type="button" class="icon-btn" data-act="approve">✓ Onaylandı</button>' : '',
        s && s.status !== 'reddedildi' ? '<button type="button" class="icon-btn" data-act="reject">✕ Onaylanmadı</button>' : '',
        s && s.status !== 'bekliyor' ? '<button type="button" class="icon-btn" data-act="reopen">Kararı geri al</button>' : '',
      ].join('') : '') +
      (isAdminRole() && s ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
      '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (editable && !decideMode ? `<button type="submit" class="icon-btn btn-primary" data-act="save">${s ? 'Kaydet' : 'Formu oluştur'}</button>` : '') +
      '</div></form>';
  }
  draw();

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="view"]')) { openSampleForm(s); return; }
    if (ev.target.closest('[data-act="pick-gk"]')) {
      const f = m.body.querySelector('form');
      openGkkPicker({ stockCode: f.elements.stockCode.value, current: f.elements.gkkReportNo.value, onPick: (no) => { f.elements.gkkReportNo.value = no; } });
      return;
    }
    if (ev.target.closest('[data-act="approve"]')) { decideMode = 'onaylandi'; error = null; draw(); return; }
    if (ev.target.closest('[data-act="reject"]')) { decideMode = 'reddedildi'; error = null; draw(); return; }
    if (ev.target.closest('[data-act="decide-cancel"]')) { decideMode = null; error = null; draw(); return; }
    if (ev.target.closest('[data-act="reopen"]')) {
      post(`/api/planning/samples/${s.id}/reopen`).then((r) => { s = r; onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${s.code}" numaralı numune kaydı silinsin mi? Bu geri alınamaz.`)) return;
      del(`/api/planning/samples/${s.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="retry-product"]') || ev.target.closest('[data-act="retry-weight"]')) {
      const which = ev.target.closest('[data-act="retry-product"]') ? 'product' : 'weight';
      mikroBusy = which; error = null; draw();
      post(`/api/planning/samples/${s.id}/retry-mikro-${which}`)
        .then((r) => { s = r; mikroBusy = null; draw(); })
        .catch((e) => { mikroBusy = null; error = e.message; draw(); });
      return;
    }
    const matBtn = ev.target.closest('[data-act="pick-material"]');
    if (matBtn) {
      const field = matBtn.dataset.field;
      openMaterialPicker({ current: matState[field], onPick: (code) => { matState[field] = code; refreshMatField(field); } });
      return;
    }
    const clearBtn = ev.target.closest('[data-act="clear-material"]');
    if (clearBtn) {
      const field = clearBtn.dataset.field;
      matState[field] = '';
      refreshMatField(field);
      return;
    }
    const drDel = ev.target.closest('[data-act="dr-del"]');
    if (drDel) {
      const d = (s.drawings ?? []).find((x) => x.id === Number(drDel.dataset.id));
      if (!window.confirm(`${d?.name ?? 'Bu PDF'} bu numuneden kaldırılsın mı?`)) return;
      del(`/api/planning/samples/${s.id}/drawings/${drDel.dataset.id}`)
        .then((r) => { s.drawings = r.drawings; refreshDrawings(); })
        .catch((e) => { const errEl = m.body.querySelector('[data-role="dr-err"]'); if (errEl) { errEl.textContent = e.message; errEl.hidden = false; } });
    }
  });
  m.body.addEventListener('change', (ev) => {
    if (ev.target.closest('[data-role="dr-file"]')) {
      const files = [...ev.target.files];
      ev.target.value = '';
      uploadDrawings(files);
      return;
    }
    const role = ev.target.dataset?.role;
    if (role !== 'gen-group' && role !== 'gen-prefix') return;
    if (role === 'gen-group') {
      gen.group = ev.target.value;
      const g = groups.find((x) => x.code === gen.group);
      if (g) { const cust = m.body.querySelector('input[name="customer"]'); if (cust) cust.value = g.name; }
    } else {
      gen.prefix = ev.target.value;
    }
    fetchGenPreview();
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    error = null;
    try {
      if (decideMode) {
        s = await post(`/api/planning/samples/${s.id}/decide`, { status: decideMode, decidedOn: f.elements.decidedOn.value || null, note: f.elements.decisionNote.value });
        decideMode = null;
      } else {
        const body = {
          customer: f.elements.customer.value, customerSampleCode: f.elements.customerSampleCode.value, customerCode: f.elements.customerCode.value,
          stockCode: f.elements.stockCode.value, sampleQty: f.elements.sampleQty.value, dueDate: f.elements.dueDate.value || null,
          quoteNetG: f.elements.quoteNetG.value, sampleNetG: f.elements.sampleNetG.value, productionSec: f.elements.productionSec.value,
          material: f.elements.material.value, altMaterial: f.elements.altMaterial.value, gauges: f.elements.gauges.value,
          producedQty: f.elements.producedQty.value, sampleSetQty: f.elements.sampleSetQty.value, producedOn: f.elements.producedOn.value || null,
          gkkReportNo: f.elements.gkkReportNo.value, sentQty: f.elements.sentQty.value, customerFeedback: f.elements.customerFeedback.value, note: f.elements.note.value,
          machineId: f.elements.machineId.value,
          ...(!s && gen.group && gen.prefix ? { customerGroupCode: gen.group, codePrefix: gen.prefix } : {}),
        };
        s = s ? await put(`/api/planning/samples/${s.id}`, body) : await post('/api/planning/samples', body);
      }
      onDone(); // ilk olusturmadan sonra da diyalog acik kalir: s artik dolu, draw() "duzenle" goruntusune gecer
      draw();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== basilan form (EYS.FR.012) */

/** Kâğıt formun düzeninde (A4 dikey) tek kayıt. @param {object} s */
function sampleFormHtml(s) {
  const row = (label, value, cls = '') => `<tr><th scope="row">${escapeHtml(label)}</th><td class="${cls}">${value === '' || value == null ? '&nbsp;' : escapeHtml(String(value))}</td></tr>`;
  const sec = (label) => `<tr class="pl-nf-sec"><th colspan="2">${escapeHtml(label)}</th></tr>`;
  return (
    '<div class="pl-form">' +
    `<div class="pl-f-head"><div class="pl-f-title">NUMUNE TALEP / TAKİP FORMU</div><div class="pl-f-no"><span class="pl-f-label">SERİ NO</span> ${escapeHtml(s.code)}<br>` +
    `<span class="pl-f-label">TARİH</span> ${dateText(s.requestedOn)}</div></div>` +
    '<table class="pl-nf-t"><tbody>' +
    sec('Numune tanımlama') +
    row('MÜŞTERİ', s.customer) + row('MÜŞTERİ NUMUNE KODU', s.customerSampleCode) + row('MÜŞTERİ ÜRÜN KODU', s.customerCode) +
    row('ALEN ÜRÜN KODU', s.stockCode) + row('NUMUNE MİKTARI', s.sampleQty) + row('TESLİM TARİHİ', s.dueDate ? dateText(s.dueDate) : null) +
    sec('Numune üretim bilgileri') +
    row('FİYAT TEKLİF NET AĞIRLIĞI (gr)', decInput(s.quoteNetG)) + row('NUMUNE NET AĞIRLIĞI (gr)', decInput(s.sampleNetG)) +
    row('ÜRETİM SÜRESİ (sn)', decInput(s.productionSec)) + row('HAMMADDE', s.material) + row('ALTERNATİF HAMMADDE', s.altMaterial) +
    row('KULLANILAN MASTAR/LAR', s.gauges) + row('ÜRETİM MİKTARI', s.producedQty) + row('AYRILAN ÖRNEK MİKTARI', s.sampleSetQty) +
    row('ÜRETİM TARİHİ', s.producedOn ? dateText(s.producedOn) : null) + row('TEZGAH', s.machineId) +
    row('GKK RAPOR NO', s.gkkReportNo) + row('GÖNDERİLEN MİKTAR', s.sentQty) +
    sec('Müşteri geri bildirim') +
    row('GERİ BİLDİRİM', s.customerFeedback, 'pl-nf-note') +
    sec('Sonuç') +
    row('SERİ ÜRETİM ONAY TARİHİ', s.status === 'onaylandi' ? dateText(s.decidedOn) : null) +
    row('RET SEBEBİ VE MÜŞTERİ RAPOR NO', s.status === 'reddedildi' ? s.decisionNote : null, 'pl-nf-note') +
    '</tbody></table>' +
    `<p class="pl-f-foot">EYS.FR.012 · YAYIN TAR: 20.09.2024 · REV NO: -- · REV TARİHİ: -- · Sistemden basıldı ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p>` +
    '</div>'
  );
}

/** Tek bir numune formunu görüntüle ve yazdır (A4 dikey). @param {object} s */
function openSampleForm(s) {
  const m = openModal({ title: `Numune formu · ${s.code}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    sampleFormHtml(s);
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}
