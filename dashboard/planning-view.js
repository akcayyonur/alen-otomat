/**
 * Planlama uygulamasinin kabugu (YALNIZ yonetici): #/planlama, #/planlama/isemirleri | urunler | siparisler | programlar.
 * Planlama, Telemetri'den AYRI bir uygulamadir (apps.js): kendi yan menusu vardir (renderPlanningNav), tezgah listesi yoktur.
 * Bolumler ayri modullerdedir; burada yan menu, bolum basligi, ozet satiri ve Excel CSV'si iceri alma penceresi bulunur.
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

const ALL = ['admin', 'operator'];
const ADMIN = ['admin'];
const TABS = Object.freeze([
  { key: 'tezgahbasi', label: 'Tezgah başı', sub: 'başlat, bitir, duruş nedeni', hint: 'Tezgah başına üretimdeki iş emri, bekleyenler ve duruş nedenleri. Duruşun süresi tezgahtan ölçülür; yalnız nedenini seçersiniz.', roles: ALL, plain: true, render: renderShop },
  { key: 'paketleme', label: 'Paketleme', sub: 'kasa adedi gir', hint: 'Kasa kapandıktan sonra paketlemede belli bir adetle paketlenen kesin adedi girin; kasa kartı buradan da yeniden basılır.', roles: ALL, plain: true, render: renderPacking },
  { key: 'isemirleri', label: 'İş emirleri', sub: 'aç, düzenle, form', hint: 'Siparişten ya da siparişsiz iş emri açın; tezgah atayın, formu yazdırın.', roles: ADMIN, render: renderWorkOrders },
  { key: 'verimlilik', label: 'Verimlilik', sub: 'tezgah, ürün, matris, duruşlar', hint: 'Verimlilik (kazanılan süre ÷ ayrılan süre), kullanılabilirlik ve performans; tezgah × gün × vardiya matrisi, günlük üretim kartları ve duruş nedeni dakikaları.', roles: ADMIN, plain: true, render: renderEfficiency },
  { key: 'hammadde', label: 'Hammadde', sub: 'ihtiyaç, sarfiyat, Mikro fişi', hint: 'Hammadde ihtiyacı, gerçekleşen sarfiyat (sayaç × brüt gramaj, kg) ve Mikro sarfiyat fişi takibi.', roles: ADMIN, plain: true, render: renderMaterial },
  { key: 'urunler', label: 'Ürün kartları', sub: 'hammadde, gramaj, süre', hint: 'Ürün kartları: hammadde, tam boy, net/brüt ağırlık ve planlanan çevrim süresi.', roles: ADMIN, render: renderProducts },
  { key: 'siparisler', label: 'Siparişler', sub: 'müşteri sipariş no ile ara', hint: 'Siparişler ve satırları; satırdan doğrudan iş emri açılır.', roles: ADMIN, render: renderOrders },
  { key: 'programlar', label: 'Program eşleme', sub: 'program ↔ ürün', hint: 'Tornalarda çalışmış programları ürün kartlarıyla eşleyin.', roles: ADMIN, render: renderPrograms },
]);

const roleOf = () => getSession()?.user?.role ?? 'viewer';
/** Rolun gorebildigi bolumler (sunucu da yetkiyi ayrica zorlar). */
export const planningTabsFor = (role = roleOf()) => TABS.filter((t) => t.roles.includes(role)).map((t) => t.key);
/** Giriste acilan bolum: operator tezgah basini, yonetici is emirlerini gorur. */
export const defaultPlanningTab = (role = roleOf()) => (role === 'operator' ? 'tezgahbasi' : 'isemirleri');

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
const KIND_LABEL = Object.freeze({ isemri: 'iş emirleri listesi', siparis: 'sipariş dosyası' });
const MAX_UPLOAD = 64 * 1024 * 1024;
const nf = new Intl.NumberFormat('tr-TR');
/** Sayi metni (bos/yok 0). */
const n = (v) => nf.format(v ?? 0);

/** @param {HTMLElement} host @param {string} [tab] */
export function renderPlanning(host, tab = defaultPlanningTab()) {
  const mine = TABS.filter((t) => t.roles.includes(roleOf()));
  const current = mine.find((t) => t.key === tab) ?? mine[0];
  const admin = roleOf() === 'admin';
  // Ice aktarma ve sayilar yalniz yonetici + planlama bolumlerinde; tezgah basi (operator ekrani) sade kalir
  const showAdminBar = admin && !current.plain;
  host.innerHTML =
    '<section class="dt-block">' +
    `<div class="dt-block-head"><div><h3>${escapeHtml(current.label)}</h3><p class="hint">${escapeHtml(current.hint)}</p></div>` +
    (showAdminBar ? '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="import">CSV içeri al…</button></div>' : '') + '</div>' +
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

function resultHtml(r) {
  const kind = KIND_LABEL[r.format] ?? r.format;
  const tally = r.format === 'isemri'
    ? `${n(r.totalRows)} iş emri satırı okundu → <b>${n(r.products.added)}</b> yeni ürün kartı, <b>${n(r.products.updated)}</b> güncellendi, ${n(r.products.unchanged)} değişmedi`
    : `${n(r.totalRows)} sipariş satırı okundu → <b>${n(r.added)}</b> yeni, <b>${n(r.updated)}</b> güncellendi, ${n(r.unchanged)} değişmedi; ` +
      `ürün kartları: ${n(r.products.added)} yeni, ${n(r.products.updated)} güncellendi` +
      (r.staleMarked > 0 ? `; dosyada olmayan <b>${n(r.staleMarked)}</b> eski satır gizlendi (yanlışlıkla ise tam dosyayı yeniden yükleyin, satırlar geri gelir)` : '');
  return `<div class="notice"><b>${escapeHtml(kind)}</b> tanındı (${escapeHtml(r.encoding)}, ayırıcı "${escapeHtml(r.delimiter)}"). ${tally}` +
    `${r.skipped > 0 ? ` ${n(r.skipped)} satır atlandı (boş ya da geçersiz).` : ''}</div>` +
    (r.warnings.length > 0
      ? `<h4 class="sub">Uyarılar (${r.warnings.length})</h4><ul class="checks">${r.warnings.map((w) =>
        `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(w)}</div></li>`).join('')}</ul>`
      : '<p class="hint">Uyarı yok.</p>');
}

function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel CSV içeri al' });
  m.body.innerHTML =
    '<p class="hint">Excel\'de ilgili sayfayı <b>Farklı Kaydet → CSV UTF-8</b> ile kaydedip seçin. Dosya türü başlıklardan kendiliğinden tanınır:</p>' +
    '<ul class="pl-list"><li><b>İş emirleri listesi</b> (PLANLANAN sayfası: ALEN KOD, MAMÜL ADI, MÜŞTERİ KODU …) → <b>ürün kartları</b> (her ürün için en son iş emrindeki değerler)</li>' +
    '<li><b>Sipariş dosyası</b> (_SIPARIS sayfası: Mamul_Kodu, Evrak_No, Must_Sip_No …) → <b>sipariş satırları</b> ve ürün kartlarında eksik alanlar (tam boy, hammadde, ağırlıklar)</li></ul>' +
    '<p class="hint">Aynı dosyayı tekrar yüklemek güvenlidir. Elle düzenlediğiniz ürün kartlarının dolu alanları ezilmez. Büyük dosya (Excel\'in boş satırları dahil) sorun değil.</p>' +
    '<input type="file" accept=".csv,text/csv,.txt" data-role="file" aria-label="CSV dosyası">' +
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
    if (!file) { err.textContent = 'Önce bir CSV dosyası seçin.'; err.hidden = false; return; }
    if (file.size > MAX_UPLOAD) { err.textContent = `Dosya çok büyük (${Math.round(file.size / 1048576)} MB; en fazla 64 MB). Excel'de yalnızca dolu satırları kaydedin.`; err.hidden = false; return; }
    go.disabled = true;
    go.textContent = 'Yükleniyor…';
    try {
      const params = new URLSearchParams({ filename: file.name, ...($('hide-old').checked ? {} : { keepOld: '1' }) });
      const r = await api(`/api/planning/import?${params}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file });
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
