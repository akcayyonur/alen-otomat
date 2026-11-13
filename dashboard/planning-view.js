/**
 * Planlama uygulamasinin kabugu: #/planlama, #/planlama/tezgahbasi | paketleme | hurda | isemirleri | gkk | ilkonay | olcuraporlari | verimlilik | hammadde | urunler | siparisler | programlar.
 * Roller: yonetici hepsini; operator (fabrika PC'si) tezgah basi, paketleme, GKK, ilk onay, olcu raporlari; izleyici (viewer) tezgah basi, is emirleri,
 * GKK, ilk onay ve olcu raporlarini YALNIZ OKUR (yetkiyi sunucu verir, burasi yalniz gorunum).
 * Planlama, Telemetri'den AYRI bir uygulamadir (apps.js): kendi yan menusu vardir (renderPlanningNav), tezgah listesi yoktur.
 * Bolumler ayri modullerdedir; burada yan menu, bolum basligi, ozet satiri ve Excel (.xlsx / CSV) iceri alma penceresi bulunur.
 *
 * Hammadde ve verimlilik sonraki asamalarda yeni bolum olarak eklenir (PLANLAMA-TASARIM.md).
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { getSession, closedSections } from './auth-view.js';
import { openModal } from './planning-common.js';
import { renderProducts } from './planning-products.js';
import { renderOrders } from './planning-orders.js';
import { renderPrograms } from './planning-programs.js';
import { renderWorkOrders } from './planning-workorders.js';
import { renderShop } from './planning-shop.js';
import { renderPacking } from './planning-packing.js';
import { renderQuarantine } from './planning-hurda.js';
import { renderMaterial } from './planning-material.js';
import { renderEfficiency } from './planning-efficiency.js';
import { renderSchedule } from './planning-schedule.js';
import { renderGkk } from './planning-gkk.js';
import { renderApprovals } from './planning-approvals.js';
import { renderSamples } from './planning-numune.js';
import { renderMeasureReports } from './planning-reports.js';
import { renderDevices } from './planning-devices.js';
import { renderMaintenance } from './planning-maintenance.js';
import { renderDrawingTracking } from './planning-drawing-tracking.js';
import { showSourceStatus, runRefresh, openSourcesDialog } from './planning-sources.js';
import { showMikroStatus, runMikroRefresh } from './planning-mikro.js';
import { openFolderDialog } from './planning-docs.js';
import { renderPriceStudies } from './planning-price.js';
import { tabsForUser, defaultTabFor } from './planning-tabs.js';

const TABS = Object.freeze([
  { key: 'tezgahbasi', label: 'Tezgah başı', sub: 'başlat, bitir, duruş nedeni', hint: 'Duruş süresi tezgahtan ölçülür; yalnız nedenini seçersiniz.', plain: true, render: renderShop },
  { key: 'paketleme', label: 'Paketleme', sub: 'paketleme formu (EYS.FR.007)', hint: 'Koli içi adet ürün başına öğrenilir ve önerilir.', plain: true, render: renderPacking },
  { key: 'hurda', label: 'Hurda girişi', sub: 'karantina giriş-çıkış (EYS.FR.043)', hint: 'Üretimde fark edilen hurda karantinaya çekilir; tashih EYS.FR.049 ile kaydedilir.', plain: true, render: renderQuarantine },
  { key: 'isemirleri', label: 'İş emirleri', sub: 'satıra bas: form · düzenle', hint: 'Satıra basınca form açılır; "Düzenle" ile değiştirin.', render: renderWorkOrders },
  { key: 'gkk', label: 'GKK rapor no', sub: 'hammadde → rapor numarası', hint: 'Giriş kalite kontrol rapor no takibi (EYS.FR.011).', plain: true, importer: true, render: renderGkk },
  { key: 'ilkonay', label: 'İlk onay raporu', sub: 'ilk baskı onay listesi', hint: 'İlk baskı onay listesi (EYS.FR.013).', plain: true, importer: true, render: renderApprovals },
  { key: 'numune', label: 'Numune takip', sub: 'numune talep/takip formu', hint: 'Müşteriye numune üretilip gönderilmesi ve onay/ret takibi (EYS.FR.012).', plain: true, render: renderSamples },
  { key: 'olcuraporlari', label: 'Ölçü raporları', sub: 'kalite kontrol ve paketleme', hint: 'Saatlik ölçümler; kalite kontrole ve paketlemeye giden rapor.', plain: true, render: renderMeasureReports },
  { key: 'olcucihazlari', label: 'Ölçüm cihazları takip', sub: 'mastar, kumpas, kalibrasyon (EYS.LS.006)', hint: 'Satır rengi kalibrasyon vaktine göre: yeşil/sarı/kırmızı.', plain: true, render: renderDevices },
  { key: 'bakim', label: 'Bakım', sub: 'makine tipi → bakım kalemi (EYS.FR.016)', hint: 'Periyodu yönetici ayarlar; usta yalnızca tik atar.', plain: true, render: renderMaintenance },
  { key: 'programlar', label: 'Program eşleme', sub: 'program ↔ ürün', hint: 'Öneriler onay bekler; eşleme adedi belirlemez.', render: renderPrograms },
  { key: 'urunler', label: 'Ürün kartları', sub: 'hammadde, gramaj, süre', hint: '', render: renderProducts },
  { key: 'teknikresim', label: 'Teknik resim takip', sub: 'resim no, rev no, tarihler (EYS.LS.007)', hint: 'Rev no sistem tarafından otomatik artırılır.', plain: true, render: renderDrawingTracking },
  { key: 'siparisler', label: 'Siparişler', sub: 'müşteri sipariş no ile ara', hint: '', render: renderOrders },
  { key: 'hammadde', label: 'Hammadde', sub: 'ihtiyaç, sarfiyat, Mikro fişi', hint: 'Sayaç × brüt gramaj; Mikro fişi elle takip edilir.', plain: true, render: renderMaterial },
  { key: 'verimlilik', label: 'Verimlilik', sub: 'tezgah, ürün, matris, duruşlar', hint: 'Kazanılan süre ÷ ayrılan süre.', plain: true, render: renderEfficiency },
  { key: 'cizelgeleme', label: 'Çizelgeleme', sub: 'tezgah önerisi (OR-Tools)', hint: 'Öneri asla otomatik uygulanmaz.', plain: true, render: renderSchedule },
  { key: 'fiyat', label: 'Fiyat çalışması', sub: 'ürün kartından önce: resim → hammadde/süre', hint: 'Ürün kartına otomatik dönüşmez; yönetici dolu kaydı görüp Mikro\'da kendisi açar.', plain: true, render: renderPriceStudies },
]);

const userOf = () => getSession()?.user ?? null;
/** Kullanicinin gorebildigi VE bu kurulumda kapali olmayan bolumler (menu ve ekran bunu kullanir). */
const visibleTabs = () => { const mine = new Set(tabsForUser(userOf(), closedSections())); return TABS.filter((t) => mine.has(t.key)); };
/** Kullanicinin gorebildigi bolumler (sunucu da yetkiyi ayrica zorlar). */
export const planningTabsFor = (user = userOf()) => tabsForUser(user, closedSections());
/** Giriste acilan bolum: admin is emirlerini, digerleri gorebildiklerinden ilkini gorur. */
export const defaultPlanningTab = (user = userOf()) => defaultTabFor(user, closedSections());

/**
 * Yan menu duzeni (2026-11-04, kullanici karari — 15 sekme tek duz listede cok oldu): benzer bolumler
 * acilir-kapanir gruplarda. Siparisler kasitli tek basina (`label:null`), grup sarmalayici almaz. Bir
 * rolun bir grupta YALNIZ 1 gorebildigi sekme varsa (ya da `label` yoksa) grup basligi hic gosterilmez,
 * dugme duz listelenir — tek elemanli bir grubu acip kapamanin anlami yok.
 * **Tezgah başı ve Siparişler en üstte, tek başına (2026-11-06, kullanıcı isteği):** en sık açılan iki
 * ekran — tezgah başı en çok kullanıcı tarafından, siparişler aranarak — artık grup içine gömülü değil,
 * ilk ikisi. `tezgahbasi` `g-uretim` grubundan çıkarıldı.
 */
const NAV_LAYOUT = Object.freeze([
  { id: null, label: null, keys: ['tezgahbasi'] },
  { id: null, label: null, keys: ['siparisler'] },
  { id: 'g-depo', label: 'Depo', keys: ['paketleme', 'hurda'] },
  { id: 'g-uretim', label: 'Üretim', keys: ['isemirleri', 'numune', 'hammadde', 'fiyat'] },
  { id: 'g-kalite', label: 'Kalite', keys: ['gkk', 'ilkonay', 'olcuraporlari', 'olcucihazlari', 'bakim'] },
  { id: 'g-urunler', label: 'Ürünler', keys: ['programlar', 'urunler', 'teknikresim'] },
  { id: 'g-analiz', label: 'Analiz', keys: ['verimlilik', 'cizelgeleme'] },
]);
/** Hangi gruplar acik: modul seviyesinde hatirlanir (nav her sekme degisiminde yeniden cizilir, kapanmasin). */
const openGroups = new Set();

/** Yan menu (app.js cagirir): bolum dugmeleri (gruplu); secili bolum isaretlenir. Adresler #/planlama/<bolum>. */
export function renderPlanningNav(nav, tab = defaultPlanningTab()) {
  const mine = visibleTabs();
  const current = mine.find((t) => t.key === tab) ?? mine[0];
  const mineKeys = new Set(mine.map((t) => t.key));
  const byKey = new Map(mine.map((t) => [t.key, t]));
  nav.hidden = mine.length < 2 && !userOf()?.isAdmin; // tek bolumlu rol: menu gereksiz

  const btn = (t) =>
    `<button class="mi${t.key === current.key ? ' is-active' : ''}" type="button" data-tab="${t.key}" aria-current="${t.key === current.key}">` +
    `<span class="mi-main"><span class="mi-name">${escapeHtml(t.label)}</span><span class="mi-sub">${escapeHtml(t.sub)}</span></span></button>`;

  nav.innerHTML =
    '<p class="sidebar-label">Planlama</p>' +
    NAV_LAYOUT.map((g) => {
      const visible = g.keys.filter((k) => mineKeys.has(k));
      if (visible.length === 0) return '';
      if (!g.label || visible.length === 1) return visible.map((k) => btn(byKey.get(k))).join('');
      if (visible.includes(current.key)) openGroups.add(g.id); // aktif sekmenin grubu hep acik kalir
      const open = openGroups.has(g.id);
      return `<details class="mi-grp" data-group="${g.id}"${open ? ' open' : ''}>` +
        `<summary class="mi-grp-h">${escapeHtml(g.label)}</summary>` +
        `<div class="mi-grp-b">${visible.map((k) => btn(byKey.get(k))).join('')}</div></details>`;
    }).join('');

  if (!nav.dataset.wired) {
    nav.dataset.wired = '1';
    // acik/kapali durumu hatirlanir (details'in kendi `toggle` olayi kabarmaz, yakalama asamasinda dinlenir).
    nav.addEventListener('toggle', (ev) => {
      const d = ev.target;
      if (!d.matches?.('details.mi-grp')) return;
      if (d.open) openGroups.add(d.dataset.group); else openGroups.delete(d.dataset.group);
    }, true);
  }
}
const KIND_LABEL = Object.freeze({ isemri: 'iş emirleri listesi', siparis: 'sipariş dosyası', gkk: 'GKK rapor numaraları (EYS.FR.011)', ilkonay: 'ilk baskı onay listesi (EYS.FR.013)' });
const MAX_UPLOAD = 64 * 1024 * 1024;
const nf = new Intl.NumberFormat('tr-TR');
/** Sayi metni (bos/yok 0). */
const n = (v) => nf.format(v ?? 0);

/** @param {HTMLElement} host @param {string} [tab] */
export function renderPlanning(host, tab = defaultPlanningTab()) {
  const mine = visibleTabs();
  const current = mine.find((t) => t.key === tab) ?? mine[0];
  const admin = userOf()?.isAdmin === true;
  // Ice aktarma ve sayilar yalniz yonetici + planlama bolumlerinde; tezgah basi (operator ekrani) sade kalir.
  // GKK ve ilk onay bolumlerinde yalniz "CSV iceri al" dugmesi vardir (urun/siparis ozeti degil).
  const showAdminBar = admin && !current.plain;
  const showImport = admin && (!current.plain || current.importer === true);
  // Siparişler ve ürün kartları: Mikro'nun SIPARISLER sorgusu ikisini de tek seferde verdiği için "Mikro'dan yenile"
  // BİRİNCİL düğme (tek tıkla doğrudan okur) - "Kaynak dosyadan yenile" (Excel) ikincil kalır, YERİNİ almaz, elden çıkmaz.
  // GKK/ilk onay/iş emirleri/program eşleme Mikro'dan gelmez: o sekmelerde eskisi gibi Excel birincil.
  const mikroPrimary = showImport && (current.key === 'urunler' || current.key === 'siparisler');
  host.innerHTML =
    '<section class="dt-block">' +
    `<div class="dt-block-head"><div><h3>${escapeHtml(current.label)}</h3>${current.hint ? `<p class="hint">${escapeHtml(current.hint)}</p>` : ''}</div>` +
    (showImport
      ? '<div class="dt-actions">' +
        (mikroPrimary
          ? '<button type="button" class="icon-btn btn-primary" data-act="mikro-refresh" title="MikroAPI\'den canlı SQL ile sipariş + ürün kartı okur">Mikro\'dan yenile</button>' +
            '<button type="button" class="icon-btn" data-act="refresh" title="Mikro / GKK Excel dosyalarının durduğu klasörü okur, değişenleri uygular">Kaynak dosyadan yenile</button>'
          : '<button type="button" class="icon-btn btn-primary" data-act="refresh" title="Mikro / GKK Excel dosyalarının durduğu klasörü okur, değişenleri uygular">Kaynak dosyadan yenile</button>') +
        '<button type="button" class="icon-btn" data-act="sources">Kaynak klasörü…</button>' +
        (current.key === 'urunler'
          ? '<button type="button" class="icon-btn" data-act="docs-cizim" title="Teknik resim klasöründeki PDF\'leri ürün koduna göre ürün kartlarına bağlar">Teknik resimleri eşle…</button>' +
            '<button type="button" class="icon-btn" data-act="docs-etiket" title="Etiket klasöründeki dosyaları ürün koduna göre ürün kartlarına bağlar">Etiketleri eşle…</button>'
          : '') +
        '<button type="button" class="icon-btn" data-act="import">Excel içeri al…</button></div>'
      : '') + '</div>' +
    (showImport ? `<p class="hint-meta" data-role="source-status"></p>${mikroPrimary ? '<p class="hint-meta" data-role="mikro-status"></p>' : ''}` : '') +
    (showAdminBar ? '<div class="pl-kpis pl-kpis-summary" data-role="summary"></div>' : '') +
    '<div data-role="tab"></div></section>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  async function summary() {
    if (!showAdminBar) return;
    const el = $('summary');
    try {
      const s = await api('/api/planning/summary');
      el.innerHTML =
        `<div class="pl-kpi"><span class="pl-kpi-l">Ürün kartı</span><span class="pl-kpi-v">${n(s.products)}</span></div>` +
        `<div class="pl-kpi"><span class="pl-kpi-l">Sipariş</span><span class="pl-kpi-v">${n(s.orders)}` +
        (s.openOrderLines > 0 ? `<span class="pl-kpi-sub">${n(s.openOrderLines)} açık</span>` : '') + `</span></div>` +
        `<div class="pl-kpi"><span class="pl-kpi-l">Program eşli</span><span class="pl-kpi-v">${n(s.mappedPrograms)}</span></div>`;
    } catch (err) {
      el.innerHTML = `<p class="hint-meta is-attn">Özet alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  const mountTab = () => current.render($('tab'));
  const afterChange = () => { summary(); mountTab(); showSourceStatus(host); if (mikroPrimary) showMikroStatus(host); };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="import"]')) openImportDialog(afterChange);
    else if (ev.target.closest('[data-act="mikro-refresh"]')) runMikroRefresh({ onDone: afterChange });
    else if (ev.target.closest('[data-act="refresh"]')) runRefresh({ onDone: afterChange });
    else if (ev.target.closest('[data-act="sources"]')) openSourcesDialog({ onDone: () => showSourceStatus(host) });
    else if (ev.target.closest('[data-act="docs-cizim"]')) openFolderDialog('cizim', { onDone: mountTab });
    else if (ev.target.closest('[data-act="docs-etiket"]')) openFolderDialog('etiket', { onDone: mountTab });
  };
  summary();
  mountTab();
  // Kaynak klasorunde degisiklik var mi: ekran acilirken ve dakikada bir (Mikro dosyayi guncelledikce dugme "N degisiklik" der).
  clearInterval(host.sourceTimer);
  if (showImport) {
    showSourceStatus(host);
    if (mikroPrimary) showMikroStatus(host);
    host.sourceTimer = setInterval(() => { if (!host.querySelector('[data-role="source-status"]')) clearInterval(host.sourceTimer); else { showSourceStatus(host); if (mikroPrimary) showMikroStatus(host); } }, 60_000);
  }
}

/** Bir tablonun (CSV'nin tamamı ya da bir Excel sayfası) iceri alma sonucu. */
function tableResultHtml(r) {
  const kind = KIND_LABEL[r.format] ?? r.format;
  const tally = r.format === 'gkk' || r.format === 'ilkonay'
    ? `${n(r.totalRows)} kayıt okundu → <b>${n(r.added)}</b> yeni, <b>${n(r.updated)}</b> güncellendi, ${n(r.unchanged)} değişmedi` +
      (r.format === 'gkk' ? `; ${n(r.freeNumbers)} önceden basılmış boş numara atlandı. Sıradaki numara: <b class="mono">${escapeHtml(r.next?.no ?? '—')}</b>` : `. Sıradaki kod: <b class="mono">${escapeHtml(r.next?.code ?? '—')}</b>`)
    : r.format === 'isemri'
    ? `${n(r.totalRows)} iş emri satırı okundu → <b>${n(r.products.added)}</b> yeni ürün kartı, <b>${n(r.products.updated)}</b> güncellendi, ${n(r.products.unchanged)} değişmedi`
    : `${n(r.totalRows)} sipariş satırı okundu → <b>${n(r.added)}</b> yeni, <b>${n(r.updated)}</b> güncellendi, ${n(r.unchanged)} değişmedi; ` +
      `ürün kartları: ${n(r.products.added)} yeni, ${n(r.products.updated)} güncellendi` +
      (r.staleMarked > 0 ? `; dosyada olmayan <b>${n(r.staleMarked)}</b> eski satır gizlendi (yanlışlıkla ise tam dosyayı yeniden yükleyin, satırlar geri gelir)` : '');
  const source = r.encoding === 'xlsx' ? '' : ` (${escapeHtml(r.encoding)}, ayırıcı "${escapeHtml(r.delimiter)}")`;
  return `<div class="notice"><b>${escapeHtml(kind)}</b> tanındı${source}. ${tally}` +
    `${r.skipped > 0 ? ` ${n(r.skipped)} satır atlandı (boş ya da geçersiz).` : ''}</div>` +
    (r.warnings.length > 0
      ? `<h4 class="sub">Uyarılar (${r.warnings.length})</h4><ul class="checks">${r.warnings.map((w) =>
        `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(w)}</div></li>`).join('')}</ul>`
      : '<p class="hint">Uyarı yok.</p>');
}

/** CSV: tek tablo. .xlsx: her taninan sayfa ayri blok, taninmayan sayfalar "atlanan" listesinde (sebebiyle). */
function resultHtml(r) {
  if (r.format !== 'xlsx') return tableResultHtml(r);
  const skipped = r.skippedSheets ?? [];
  return (
    `<div class="notice"><b>Excel çalışma kitabı</b>: ${n(r.sheets.length)} sayfa içeri alındı` +
    `${skipped.length > 0 ? `, ${n(skipped.length)} sayfa atlandı (türü tanınmadı ya da boş)` : ''}.</div>` +
    r.sheets.map((s) => `<section class="pl-prog"><h4 class="sub">Sayfa: ${escapeHtml(s.sheet)}</h4>${tableResultHtml(s)}</section>`).join('') +
    (skipped.length > 0
      ? `<h4 class="sub">Atlanan sayfalar (${skipped.length})</h4><ul class="pl-list">${skipped.map((k) => `<li><b>${escapeHtml(k.name)}</b>: ${escapeHtml(k.reason)}</li>`).join('')}</ul>`
      : '')
  );
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel / CSV içeri al' });
  m.body.innerHTML =
    '<p class="hint">Excel dosyasını (<b>.xlsx</b>) olduğu gibi seçin: dosyadaki <b>tüm sayfalara</b> bakılır, tanınanlar içeri alınır, tanınmayanlar (ör. kâğıt form şablonu, sevkiyat sayfası) atlanır ve sonuçta listelenir. ' +
    'CSV de kabul edilir (tek sayfa; Excel\'de <b>Farklı Kaydet → CSV UTF-8</b>). Sayfa türü başlıklardan kendiliğinden tanınır:</p>' +
    '<ul class="pl-list"><li><b>İş emirleri listesi</b> (PLANLANAN sayfası: ALEN KOD, MAMÜL ADI, MÜŞTERİ KODU …) → <b>ürün kartları</b> (her ürün için en son iş emrindeki değerler)</li>' +
    '<li><b>Sipariş dosyası</b> (_SIPARIS sayfası: Mamul_Kodu, Evrak_No, Must_Sip_No …) → <b>sipariş satırları</b> ve ürün kartlarında eksik alanlar (tam boy, hammadde, ağırlıklar)</li>' +
    '<li><b>GKK rapor numarası takip formu</b> (EYS.FR.011: SIRA, ÜRÜN, RAPOR NO, ÜRETİCİ RAPOR TARİHİ, AÇIKLAMA) → <b>GKK rapor no</b> sekmesi; sayfa sonundaki önceden basılmış boş numaralar kayıt sayılmaz</li>' +
    '<li><b>İlk baskı onay / numune takip listesi</b> (EYS.FR.013: İLK BASKI ONAY KODU, ÜRÜN KODU, GK- KODU …) → <b>İlk onay raporu</b> sekmesi; ilk boş basılı kod sıradaki numara olur</li></ul>' +
    '<p class="hint">Aynı dosyayı tekrar yüklemek güvenlidir. Elle düzenlediğiniz ürün kartlarının dolu alanları ezilmez. Büyük dosya (Excel\'in boş satırları dahil) sorun değil. ' +
    'Uyarılardaki satır numaraları Excel\'deki satır numarasıdır. Eski <b>.xls</b> biçimi ve şifreli dosya okunamaz (şifresiz .xlsx olarak kaydedin).</p>' +
    '<input type="file" accept=".xlsx,.csv,text/csv,.txt" data-role="file" aria-label="Excel (.xlsx) ya da CSV dosyası">' +
    '<label class="chk"><input type="checkbox" data-role="hide-old"> Bu dosya <b>tam döküm</b>: dosyada olmayan eski sipariş satırlarını gizle ' +
    '<span class="hint" style="margin:0">(kısmi dosya yüklüyorsanız işaretlemeyin)</span></label>' +
    '<p class="notice notice-sim" data-role="err" hidden></p><div data-role="result"></div>' +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="go">İçeri al</button></div>';
  const $ = (r) => m.body.querySelector(`[data-role="${r}"]`);
  const go = m.body.querySelector('[data-act="go"]');

  go.addEventListener('click', async () => {
    const file = $('file').files[0];
    const err = $('err');
    err.hidden = true;
    $('result').innerHTML = '';
    if (!file) { err.textContent = 'Önce bir Excel (.xlsx) ya da CSV dosyası seçin.'; err.hidden = false; return; }
    if (file.size > MAX_UPLOAD) { err.textContent = `Dosya çok büyük (${Math.round(file.size / 1048576)} MB; en fazla 64 MB). Excel'de yalnızca dolu satırları kaydedin.`; err.hidden = false; return; }
    go.disabled = true;
    go.textContent = 'Yükleniyor…';
    try {
      const params = new URLSearchParams({ filename: file.name, ...($('hide-old').checked ? {} : { keepOld: '1' }) });
      // Sunucu turu icerikten anlar (.xlsx = ZIP); Content-Type yalniz bilgidir.
      // timeoutMs: 64 MB'a kadar dosya olabilir (bkz. MAX_UPLOAD); varsayilan 20 sn'lik api() zaman asimi cok kisa kalir.
      const r = await api(`/api/planning/import?${params}`, { method: 'POST', headers: { 'content-type': /\.xlsx$/i.test(file.name) ? XLSX_TYPE : 'text/csv' }, body: file, timeoutMs: 180_000 });
      $('result').innerHTML = resultHtml(r);
      onDone();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
    go.disabled = false;
    go.textContent = 'İçeri al';
  });
}
