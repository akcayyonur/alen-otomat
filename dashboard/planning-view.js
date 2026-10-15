/**
 * Planlama uygulamasinin kabugu: #/planlama, #/planlama/tezgahbasi | paketleme | isemirleri | gkk | ilkonay | olcuraporlari | verimlilik | hammadde | urunler | siparisler | programlar.
 * Roller: yonetici hepsini; operator (fabrika PC'si) tezgah basi, paketleme, GKK, ilk onay, olcu raporlari; izleyici (viewer) tezgah basi, is emirleri,
 * GKK, ilk onay ve olcu raporlarini YALNIZ OKUR (yetkiyi sunucu verir, burasi yalniz gorunum).
 * Planlama, Telemetri'den AYRI bir uygulamadir (apps.js): kendi yan menusu vardir (renderPlanningNav), tezgah listesi yoktur.
 * Bolumler ayri modullerdedir; burada yan menu, bolum basligi, ozet satiri ve Excel (.xlsx / CSV) iceri alma penceresi bulunur.
 *
 * Hammadde ve verimlilik sonraki asamalarda yeni bolum olarak eklenir (PLANLAMA-TASARIM.md).
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { getSession } from './auth-view.js';
import { openModal, dateTimeText } from './planning-common.js';
import { renderProducts } from './planning-products.js';
import { renderOrders } from './planning-orders.js';
import { renderPrograms } from './planning-programs.js';
import { renderWorkOrders } from './planning-workorders.js';
import { renderShop } from './planning-shop.js';
import { renderPacking } from './planning-packing.js';
import { renderMaterial } from './planning-material.js';
import { renderEfficiency } from './planning-efficiency.js';
import { renderGkk } from './planning-gkk.js';
import { renderApprovals } from './planning-approvals.js';
import { renderMeasureReports } from './planning-reports.js';
import { TAB_ROLES, tabsForRole, defaultTabFor } from './planning-tabs.js';

const TABS = Object.freeze([
  { key: 'tezgahbasi', label: 'Tezgah başı', sub: 'başlat, bitir, duruş nedeni', hint: 'Tezgah başına üretimdeki iş emri, bekleyenler ve duruş nedenleri. Duruşun süresi tezgahtan ölçülür; yalnız nedenini seçersiniz.', roles: TAB_ROLES.tezgahbasi, plain: true, render: renderShop },
  { key: 'paketleme', label: 'Paketleme', sub: 'kasa adedi gir', hint: 'Kasa kapandıktan sonra paketlemede belli bir adetle paketlenen kesin adedi girin; kasa kartı buradan da yeniden basılır. Kartında ÜRÜN RET tikli kasalar paketlemeye gitmez ("Ret edilenler"de görünür).', roles: TAB_ROLES.paketleme, plain: true, render: renderPacking },
  { key: 'isemirleri', label: 'İş emirleri', sub: 'satıra bas: form · düzenle', hint: 'Satıra basınca iş emri formu (ve arka sayfada teknik resimler) açılır; "Düzenle" ile iş emri değiştirilir. Siparişten ya da siparişsiz yeni iş emri açılır.', roles: TAB_ROLES.isemirleri, render: renderWorkOrders },
  { key: 'gkk', label: 'GKK rapor no', sub: 'hammadde → rapor numarası', hint: 'Giriş kalite kontrol rapor numarası takip formu (EYS.FR.011): iş emrine yazılacak GK numarasını hammadde cinsinden bulun.', roles: TAB_ROLES.gkk, plain: true, importer: true, render: renderGkk },
  { key: 'ilkonay', label: 'İlk onay raporu', sub: 'ilk baskı onay / numune takip', hint: 'İlk baskı onay / numune takip listesi (EYS.FR.013): ilk parça onayı için numara alın; ürün, GK kodu, iş emri, tarih, operatör ve CNC no ile kaydedilir.', roles: TAB_ROLES.ilkonay, plain: true, importer: true, render: renderApprovals },
  { key: 'olcuraporlari', label: 'Ölçü raporları', sub: 'kalite kontrol ve paketleme', hint: 'İş emirlerine bağlı ölçü kontrolü raporları: saatlik ölçümler kaydedilir; kalite kontrole ve paketlemeye ürünle birlikte giden rapor buradan açılır ve basılır.', roles: TAB_ROLES.olcuraporlari, plain: true, render: renderMeasureReports },
  { key: 'verimlilik', label: 'Verimlilik', sub: 'tezgah, ürün, matris, duruşlar', hint: 'Verimlilik (kazanılan süre ÷ ayrılan süre), kullanılabilirlik ve performans; tezgah × gün × vardiya matrisi, günlük üretim kartları ve duruş nedeni dakikaları.', roles: TAB_ROLES.verimlilik, plain: true, render: renderEfficiency },
  { key: 'hammadde', label: 'Hammadde', sub: 'ihtiyaç, sarfiyat, Mikro fişi', hint: 'Hammadde ihtiyacı, gerçekleşen sarfiyat (sayaç × brüt gramaj, kg) ve Mikro sarfiyat fişi takibi.', roles: TAB_ROLES.hammadde, plain: true, render: renderMaterial },
  { key: 'urunler', label: 'Ürün kartları', sub: 'hammadde, gramaj, süre', hint: 'Ürün kartları: hammadde, tam boy, net/brüt ağırlık ve planlanan çevrim süresi.', roles: TAB_ROLES.urunler, render: renderProducts },
  { key: 'siparisler', label: 'Siparişler', sub: 'müşteri sipariş no ile ara', hint: 'Siparişler ve satırları; satırdan doğrudan iş emri açılır.', roles: TAB_ROLES.siparisler, render: renderOrders },
  { key: 'programlar', label: 'Program eşleme', sub: 'program ↔ ürün', hint: 'Tornalarda çalışmış programları ürünlerle eşleyin: önerileri onaylayın ya da ürünü kendiniz seçin. Eşleme adedi belirlemez, yalnız iş emri ve raporlarda doğru ürünü gösterir.', roles: TAB_ROLES.programlar, render: renderPrograms },
]);

const roleOf = () => getSession()?.user?.role ?? 'viewer';
/** Rolun gorebildigi bolumler (sunucu da yetkiyi ayrica zorlar). */
export const planningTabsFor = (role = roleOf()) => tabsForRole(role);
/** Giriste acilan bolum: operator ve izleyici tezgah basini, yonetici is emirlerini gorur. */
export const defaultPlanningTab = (role = roleOf()) => defaultTabFor(role);

/** Yan menu (app.js cagirir): bolum dugmeleri; secili bolum isaretlenir. Adresler #/planlama/<bolum>. */
export function renderPlanningNav(nav, tab = defaultPlanningTab()) {
  const mine = TABS.filter((t) => t.roles.includes(roleOf()));
  const current = mine.find((t) => t.key === tab) ?? mine[0];
  nav.hidden = mine.length < 2 && roleOf() !== 'admin'; // tek bolumlu operator: menu gereksiz
  nav.innerHTML =
    '<p class="sidebar-label">Planlama</p>' +
    mine.map((t) =>
      `<button class="mi${t.key === current.key ? ' is-active' : ''}" type="button" data-tab="${t.key}" aria-current="${t.key === current.key}">` +
      `<span class="mi-main"><span class="mi-name">${escapeHtml(t.label)}</span><span class="mi-sub">${escapeHtml(t.sub)}</span></span></button>`).join('');
}
const KIND_LABEL = Object.freeze({ isemri: 'iş emirleri listesi', siparis: 'sipariş dosyası', gkk: 'GKK rapor numaraları (EYS.FR.011)', ilkonay: 'ilk baskı onay listesi (EYS.FR.013)' });
const MAX_UPLOAD = 64 * 1024 * 1024;
const nf = new Intl.NumberFormat('tr-TR');
/** Sayi metni (bos/yok 0). */
const n = (v) => nf.format(v ?? 0);

/** @param {HTMLElement} host @param {string} [tab] */
export function renderPlanning(host, tab = defaultPlanningTab()) {
  const mine = TABS.filter((t) => t.roles.includes(roleOf()));
  const current = mine.find((t) => t.key === tab) ?? mine[0];
  const admin = roleOf() === 'admin';
  // Ice aktarma ve sayilar yalniz yonetici + planlama bolumlerinde; tezgah basi (operator ekrani) sade kalir.
  // GKK ve ilk onay bolumlerinde yalniz "CSV iceri al" dugmesi vardir (urun/siparis ozeti degil).
  const showAdminBar = admin && !current.plain;
  const showImport = admin && (!current.plain || current.importer === true);
  host.innerHTML =
    '<section class="dt-block">' +
    `<div class="dt-block-head"><div><h3>${escapeHtml(current.label)}</h3><p class="hint">${escapeHtml(current.hint)}</p></div>` +
    (showImport ? '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="import">Excel içeri al…</button></div>' : '') + '</div>' +
    (showAdminBar ? '<p class="hint" data-role="summary"></p>' : '') +
    '<div data-role="tab"></div></section>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  async function summary() {
    if (!showAdminBar) return;
    try {
      const s = await api('/api/planning/summary');
      const last = s.lastImports[0];
      $('summary').textContent =
        `${n(s.products)} ürün kartı · ${n(s.orders)} sipariş (${n(s.orderLines)} satır, ${n(s.openOrderLines)} açık) · ${n(s.mappedPrograms)} program eşli` +
        (last ? ` · son içeri alma: ${KIND_LABEL[last.kind] ?? last.kind}, ${dateTimeText(last.at)}${last.by ? ` (${last.by})` : ''}` : ' · henüz içeri alma yapılmadı');
    } catch (err) {
      $('summary').textContent = `Özet alınamadı: ${err.message}`;
    }
  }

  const mountTab = () => current.render($('tab'));
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="import"]')) openImportDialog(() => { summary(); mountTab(); });
  };
  summary();
  mountTab();
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
      const r = await api(`/api/planning/import?${params}`, { method: 'POST', headers: { 'content-type': /\.xlsx$/i.test(file.name) ? XLSX_TYPE : 'text/csv' }, body: file });
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
