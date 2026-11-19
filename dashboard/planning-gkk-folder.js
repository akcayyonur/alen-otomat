/**
 * Planlama > GKK rapor no > "Klasörden kalite raporu eşle…" (yalnız yönetici, TEK SEFERLİK):
 * hammaddenin üretici kalite sertifikası PDF'leri bir klasöre konur, dosya adında HANGİ GK RAPOR
 * NUMARASI olduğu yazar (ör. "AA24 X 13 - PB3 - GK25.093.pdf"); "Eşle" klasörü tarar ve dosyaları, o
 * rapor numarasıyla eşleşen GKK kaydına/kayıtlarına bağlar (2026-11-19 düzeltmesi: hammadde cinsine
 * DEĞİL, rapor numarasına — aynı hammaddenin farklı teslimatları farklı sertifika taşıyabilir).
 * Hesaplar sunucuda (backend/planning/gkk-folder.js); burası yalnız gösterir. doc-folder.js'teki
 * (teknik resim/etiket) "ayarla -> eşle" penceresiyle AYNI desen, ama daha basit (tek klasör, "yeni
 * sürümleri güncelle" yok).
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, openModal } from './planning-common.js';

const nf = new Intl.NumberFormat('tr-TR');
const n = (v) => nf.format(v ?? 0);

/** En fazla 60 kayıt gelir (sunucu keser değil ama biz burada kırpıyoruz, diğer klasör pencereleriyle AYNI). */
const list = (title, items, fmt, total = items.length) => (items.length === 0 ? '' :
  `<h4 class="sub">${escapeHtml(title)} (${n(total)})</h4><ul class="pl-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}${total > items.length ? `<li class="hint">… ve ${n(total - items.length)} tane daha</li>` : ''}</ul>`);

function resultHtml(r) {
  let head;
  if (r.scanned === 0) head = `<div class="notice notice-sim"><b>Klasörde dosya yok.</b> Kalite raporu PDF'lerini şu klasöre koyun: <span class="mono">${escapeHtml(r.dir)}</span></div>`;
  else if (r.reports === 0) head = `<div class="notice"><b>Yeni eşleme yok.</b> ${n(r.scanned)} dosya tarandı; ${n(r.alreadyHad)} rapor numarasında kalite raporu zaten var.</div>`;
  else head = `<div class="notice"><b>${n(r.reports)} rapor numarasına kalite raporu bağlandı</b> (${n(r.scanned)} dosya tarandı).</div>`;
  return head +
    list('Bağlananlar', r.attached, (a) => `<b>${escapeHtml(a.reportNo)}</b> — ${escapeHtml(a.files.join(', '))}`, r.reports) +
    list('Eşleşmeyen dosyalar', r.unmatched, (u) => `<span class="mono">${escapeHtml(u.name)}</span> — ${escapeHtml(u.reason)}`, r.unmatchedTotal) +
    list('Kabul edilmeyen dosyalar', r.rejected, (u) => `<span class="mono">${escapeHtml(u.name)}</span> — ${escapeHtml(u.error)}`) +
    list('Hâlâ kalite raporu olmayan rapor numaraları', r.missing.sample, (reportNo) => escapeHtml(reportNo), r.missing.total) +
    (r.truncated ? '<p class="notice notice-sim">Klasör çok büyük: ilk 20.000 girdi tarandı.</p>' : '');
}

/** @param {{onDone?: () => void}} [opts] onDone: eşleme yapılınca (liste tazelensin) */
export function openGkkFolderDialog({ onDone = () => {} } = {}) {
  const m = openModal({ title: 'Klasörden kalite raporu eşle', wide: true });

  async function draw(message = '') {
    let st;
    try { st = await api('/api/planning/gkk-folder'); } catch (e) { m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p>`; return; }
    m.body.innerHTML =
      '<p class="hint">Hammaddenin üretici kalite sertifikası (GKK) <b>PDF</b> dosyalarını bu klasöre koyun (alt klasör olabilir). Dosya adında ' +
      '<b>o teslimatın GK rapor numarası</b> yazmalı (ör. <span class="mono">AA24 X 13 - PB3 - GK25.093.pdf</span>) — listedeki rapor numarasıyla eşleşen kısım bulunur. ' +
      'Aynı rapor numarasını paylaşan kayıtlar aynı dosyayı görür; <b>aynı hammaddenin farklı rapor numaraları (ayrı teslimat) ayrı dosya sayılır.</b> ' +
      '<b>Tek seferliktir:</b> zaten kalite raporu olan rapor numarasına yeniden dokunulmaz.</p>' +
      '<p class="hint"><b>Önemli:</b> sunucu bir Windows görevi olarak çalışır; ağ paylaşımı (<span class="mono">\\\\sunucu\\paylasim</span>) ona kapalı olabilir. Mümkünse <b>yerel bir klasör</b> kullanın.</p>' +
      `${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}` +
      '<div class="pl-bar"><label class="fld-inline" style="flex:1">Klasör yolu ' +
      `<input type="text" data-role="dir" value="${escapeHtml(st.dir ?? '')}" spellcheck="false" autocomplete="off" style="width:100%" placeholder="${escapeHtml(st.defaultDir ?? 'C:\\\\CNC-Telemetri\\\\data\\\\gkk-rapor')}"></label>` +
      '<button type="button" class="icon-btn" data-act="save">Kaydet</button>' +
      `${st.isDefault ? '' : '<button type="button" class="icon-btn" data-act="default">Varsayılana dön</button>'}</div>` +
      `<p class="hint">Varsayılan klasör: <span class="mono">${escapeHtml(st.defaultDir ?? '—')}</span>${st.isDefault ? ' (şu an bu kullanılıyor)' : ''}</p>` +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      (!st.exists ? '<p class="notice notice-sim">Klasör bulunamadı.</p>'
        : `<p><b>${n(st.files)}</b> dosya · <b>${n(st.without)}</b> / ${n(st.reports)} rapor numarasında kalite raporu yok${st.truncated ? ' · klasör çok büyük, ilk 20.000 girdi' : ''}</p>`) +
      '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="match"' + (st.exists ? '' : ' disabled') + '>Eşle</button></div>';

    const err = m.body.querySelector('[data-role="err"]');
    const save = async (value) => {
      try { await put('/api/planning/gkk-folder/dir', { dir: value }); await draw('Klasör kaydedildi.'); } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    m.body.querySelector('[data-act="save"]').addEventListener('click', () => save(m.body.querySelector('[data-role="dir"]').value));
    m.body.querySelector('[data-act="default"]')?.addEventListener('click', () => save(''));
    m.body.querySelector('[data-act="match"]').addEventListener('click', () => run());
  }

  async function run() {
    m.body.innerHTML = '<p class="hint">Klasör taranıyor ve dosyalar eşleniyor…</p>';
    try {
      const r = await post('/api/planning/gkk-folder/match', {});
      m.body.innerHTML = resultHtml(r) + '<div class="dt-actions"><button type="button" class="icon-btn" data-act="back">Klasör ayarına dön</button></div>';
      m.body.querySelector('[data-act="back"]').addEventListener('click', () => draw());
      onDone();
    } catch (e) {
      m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p><div class="dt-actions"><button type="button" class="icon-btn" data-act="back">Geri</button></div>`;
      m.body.querySelector('[data-act="back"]').addEventListener('click', () => draw());
    }
  }

  draw();
}
