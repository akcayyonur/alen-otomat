/**
 * Planlama > Çizelgeleme (yalnız yönetici): bekleyen (planlandı) iş emirlerini hangi tezgaha,
 * hangi sırayla vermenin ÖNERİSİ (Google OR-Tools / CP-SAT, ayrı Python süreci - backend/planning/schedule.js).
 * Önce gerçekte ÖLÇÜLEN çevrim süresi (yoksa ürün kartındaki planlanan) kullanılır. Hedef: önce
 * termin gecikmesi en aza indirilir, sonra toplam süre + tezgahlar arası yük dengesi + hammadde/
 * müşteri DEĞİŞİM SAYISI (süresi değil - gerçek veri yok) birlikte en aza indirilir.
 *
 * SONUÇ ASLA OTOMATİK UYGULANMAZ: önce gözden geçirilir, sonra onaylanan atamalar "Uygula" ile
 * mevcut iş emri güncelleme yoluna gönderilir (başlamış iş emri sessizce atlanır).
 */
import { escapeHtml, dur } from './format.js';
import { post } from './lib-common.js';
import { cellText, fmtNum, dateTimeText, chip, openModal } from './planning-common.js';

/** @param {HTMLElement} host */
export async function renderSchedule(host) {
  const st = { data: null, selected: new Set() };
  host.innerHTML = '<div data-role="body"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  const intro =
    '<p class="hint">Bekleyen (planlandı) iş emirlerini hangi tezgaha, hangi sırayla vermenin ÖNERİSİNİ çıkarır: önce gerçekte ÖLÇÜLEN çevrim süresi, yoksa ürün kartındaki planlanan kullanılır. ' +
    'Önce termin gecikmesi en aza indirilir; sonra toplam süre, tezgahlar arası yük dengesi ve hammadde/müşteri değişim <b>SAYISI</b> (süresi değil: gerçek ayar süresi verisi yok) birlikte en aza indirilir. ' +
    '<b>Sonuç asla otomatik uygulanmaz</b>: gözden geçirin, sonra onayladığınız atamaları uygulayın. Üretimdeki iş emirlerine dokunulmaz, tezgahları birbirinin yerine geçebilir sayar.</p>';

  function emptyHtml() {
    return `${intro}<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="suggest">Öneri oluştur…</button></div>`;
  }

  function metricsHtml(m) {
    const tile = (label, value, sub = '') => `<div class="pl-kpi"><span class="pl-kpi-l">${label}</span><span class="pl-kpi-v">${value}</span>${sub ? `<small class="hint">${sub}</small>` : ''}</div>`;
    return (
      '<div class="pl-kpis">' +
      tile('Toplam gecikme', m.totalTardinessSec > 0 ? `<b>${dur(m.totalTardinessSec)}</b> ${chip('bad', '▲', 'gecikme var')}` : dur(0)) +
      tile('Toplam süre (makespan)', dur(m.makespanSec)) +
      tile('Tezgahlar arası yük dengesizliği', dur(m.loadImbalanceSec)) +
      tile('Hammadde/müşteri değişim sayısı', fmtNum(m.changeoverCount), m.changeoverSkipped ? 'kuyruk çok büyük: bu terim hesaba katılmadı' : '') +
      '</div>'
    );
  }

  function rowsHtml(d) {
    if (d.warnings.length === 0 && d.assignments.length === 0) return '<p class="empty">Çizelgelenecek bekleyen iş emri yok.</p>';
    const warn = d.warnings.length > 0
      ? `<h4 class="sub">Uyarılar (${d.warnings.length})</h4><ul class="checks">${d.warnings.map((w) => `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(w)}</div></li>`).join('')}</ul>`
      : '';
    if (d.assignments.length === 0) return `${warn}<p class="empty">Çizelgelenecek bekleyen iş emri yok.</p>`;
    const allPicked = d.assignments.every((a) => st.selected.has(a.no));
    return (
      warn +
      `<div class="pl-bar"><button type="button" class="icon-btn btn-primary" data-act="apply"${st.selected.size === 0 ? ' disabled' : ''}>Seçilenleri uygula (${st.selected.size})…</button>` +
      `<button type="button" class="icon-btn" data-act="select-all">${allPicked ? 'Seçimi temizle' : 'Hepsini seç'}</button></div>` +
      '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th></th><th>İş emri</th><th>Ürün</th><th class="num">Hedef</th><th>Termin</th><th>Şu an</th><th>Önerilen tezgah</th><th>Tahmini başlangıç</th><th>Tahmini bitiş</th></tr></thead><tbody>' +
      d.assignments.map((a) => (
        `<tr data-no="${escapeHtml(a.no)}"><td><input type="checkbox" data-role="pick" aria-label="${escapeHtml(a.no)} seç"${st.selected.has(a.no) ? ' checked' : ''}></td>` +
        `<td class="mono"><b>${escapeHtml(a.no)}</b></td><td class="trunc" title="${escapeHtml(a.productName ?? '')}"><span class="mono">${cellText(a.stockCode)}</span> ${cellText(a.productName)}</td>` +
        `<td class="num">${fmtNum(a.targetQty)}</td><td>${a.dueDate ? escapeHtml(new Date(a.dueDate).toLocaleDateString('tr-TR')) : cellText(null)}</td>` +
        `<td class="mono">${cellText(a.currentMachineId)}</td><td class="mono"><b>${escapeHtml(a.machineId)}</b>${a.changesMachine ? ` ${chip('info', '→', 'değişiyor')}` : ''}</td>` +
        `<td>${escapeHtml(dateTimeText(a.startAt))}</td><td>${escapeHtml(dateTimeText(a.endAt))}</td></tr>`
      )).join('') + '</tbody></table></div>'
    );
  }

  function resultHtml() {
    return `${intro}<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="suggest">Öneriyi yenile…</button></div>${metricsHtml(st.data.metrics)}${rowsHtml(st.data)}`;
  }

  async function suggest() {
    $('body').innerHTML = `${intro}<p class="empty">Hesaplanıyor… (iş emri ve tezgah sayısına göre bir dakikaya kadar sürebilir)</p>`;
    try {
      st.data = await post('/api/planning/schedule/suggest', {});
      st.selected = new Set();
      $('body').innerHTML = resultHtml();
    } catch (err) {
      $('body').innerHTML = `${emptyHtml()}<p class="notice notice-sim">Öneri alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  function openApplyDialog() {
    const nos = [...st.selected];
    const rows = st.data.assignments.filter((a) => nos.includes(a.no));
    const m = openModal({ title: `Çizelgeleme önerisini uygula · ${nos.length} iş emri` });
    m.body.innerHTML =
      `<p class="notice">Seçilen ${nos.length} iş emrinin tezgah ataması değişecek. Arada başlatılmış ya da iptal edilmiş iş emri sessizce atlanır (sonuçta bildirilir); sıra/zamanlama bilgi amaçlıdır, yalnız tezgah ataması yazılır.</p>` +
      `<ul class="pl-list">${rows.map((r) => `<li><b>${escapeHtml(r.no)}</b> ${cellText(r.stockCode)}: ${escapeHtml(r.currentMachineId ?? '—')} → <b>${escapeHtml(r.machineId)}</b></li>`).join('')}</ul>` +
      '<p class="notice notice-sim" data-role="err" hidden></p><div data-role="result"></div>' +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="go">Uygula</button></div>';
    const $$ = (r) => m.body.querySelector(`[data-role="${r}"]`);
    m.body.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
    m.body.querySelector('[data-act="go"]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      $$('err').hidden = true;
      try {
        const r = await post('/api/planning/schedule/apply', { assignments: rows.map((x) => ({ no: x.no, machineId: x.machineId })) });
        $$('result').innerHTML = `<p class="notice">${r.applied.length} iş emri güncellendi.${r.skipped.length > 0 ? ` ${r.skipped.length} atlandı: ${r.skipped.map((s) => `${escapeHtml(s.no ?? '?')} (${escapeHtml(s.reason)})`).join('; ')}` : ''}</p>`;
        await suggest();
      } catch (e) {
        $$('err').textContent = e.message;
        $$('err').hidden = false;
        ev.target.disabled = false;
      }
    });
  }

  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="suggest"]')) { suggest(); return; }
    if (ev.target.closest('[data-act="apply"]')) { openApplyDialog(); return; }
    if (ev.target.closest('[data-act="select-all"]')) {
      if (st.selected.size === st.data.assignments.length) st.selected.clear();
      else st.selected = new Set(st.data.assignments.map((a) => a.no));
      $('body').innerHTML = resultHtml();
    }
  };
  host.onchange = (ev) => {
    if (ev.target.dataset?.role !== 'pick') return;
    const no = ev.target.closest('tr[data-no]').dataset.no;
    if (ev.target.checked) st.selected.add(no); else st.selected.delete(no);
    const btn = host.querySelector('[data-act="apply"]');
    if (btn) { btn.disabled = st.selected.size === 0; btn.textContent = `Seçilenleri uygula (${st.selected.size})…`; }
  };

  $('body').innerHTML = emptyHtml();
}
