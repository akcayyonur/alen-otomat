/**
 * Ayarlar ekrani - tezgah tanimlari ve surucu secimi.
 *
 * Urun tek bir markaya bagli degil: her tezgah bir SURUCUYE baglanir ve surucu
 * o markanin protokolunu konusan Edge Agent'i temsil eder. Ajani yazilmamis bir
 * surucu listede gorunur ama SECILEMEZ - musteriye tutulamayacak soz verilmesin.
 */
import { escapeHtml, num } from './format.js';

const STATUS_META = {
  supported: { label: 'Destekleniyor', cls: 'ok', icon: '✓' },
  experimental: { label: 'Deneysel', cls: 'warn', icon: '~' },
  planned: { label: 'Henüz yok', cls: 'none', icon: '—' },
};

/** Duzenleme sirasindaki taslak - kaydedilene kadar sunucuya gitmez. */
let draft = null;
let config = null;
let dirty = false;
let message = null;

export function resetConfigView() {
  draft = null;
  config = null;
  dirty = false;
  message = null;
}

export async function renderConfig(host, onSaved) {
  if (config === null) {
    host.innerHTML = '<p class="empty">Ayarlar yükleniyor…</p>';
    try {
      config = await fetch('/api/config').then((r) => r.json());
      draft = config.machines.map((m) => ({ ...m }));
    } catch (err) {
      host.innerHTML = `<p class="notice">Ayarlar alınamadı: ${escapeHtml(err.message)}</p>`;
      return;
    }
  }

  const selectable = config.drivers.filter((d) => d.selectable);
  const defaultDriver = config.defaults.driverId ?? selectable[0]?.id ?? '';

  host.innerHTML =
    '<header class="dt-head">' +
    '<div><span class="eyebrow">Yapılandırma</span>' +
    '<h2>Tezgahlar ve sürücüler</h2>' +
    '<p class="dt-sub">Her tezgah bir sürücüye bağlanır. Sürücü, o panelin protokolünü ' +
    'konuşan Edge Agent\'ı belirler.</p></div>' +
    '</header>' +

    (config.readOnly
      ? '<p class="notice">Yapılandırma yazımı kapalı (<code>CONFIG_READONLY=1</code>). ' +
        'Değişiklikler kaydedilemez.</p>'
      : '<p class="notice">Bu ekranda kimlik doğrulama <b>yok</b> — ofis ağındaki herkes ' +
        'tezgah tanımlarını değiştirebilir. Dashboard ofis ağı dışına açılacaksa ' +
        '<code>CONFIG_READONLY=1</code> ile yazımı kapatın.</p>') +

    (message
      ? `<p class="notice ${message.ok ? '' : 'notice-sim'}">${escapeHtml(message.text)}</p>`
      : '') +

    '<section class="dt-block">' +
    '<div class="dt-block-head"><h3>Sürücüler</h3>' +
    `<span class="hint" style="margin:0">${num(selectable.length)} / ${num(config.drivers.length)} seçilebilir</span>` +
    '</div>' +
    '<div class="drv-grid">' + config.drivers.map(driverCard).join('') + '</div>' +
    '</section>' +

    '<section class="dt-block">' +
    '<div class="dt-block-head"><h3>Tezgahlar</h3>' +
    '<div class="dt-actions">' +
    '<button type="button" class="icon-btn" data-act="add">+ Tezgah ekle</button>' +
    `<button type="button" class="icon-btn" data-act="save"${config.readOnly || !dirty ? ' disabled' : ''}>` +
    `${dirty ? 'Kaydet *' : 'Kaydet'}</button>` +
    '</div></div>' +
    '<div class="table-wrap">' + machineTable(draft, config.drivers, defaultDriver) + '</div>' +
    '<p class="hint">Sürücüsü boş bırakılan tezgah <code>defaults.driverId</code> ' +
    `(<b>${escapeHtml(defaultDriver)}</b>) kullanır. IP\'ler kablo çekimi sırasında doldurulacak.</p>` +
    '</section>';

  wire(host, onSaved);
}

function driverCard(d) {
  const meta = STATUS_META[d.status] ?? STATUS_META.planned;
  return (
    `<article class="drv drv-${meta.cls}">` +
    '<header>' +
    `<h4>${escapeHtml(d.label)}</h4>` +
    `<span class="drv-badge drv-badge-${meta.cls}">${meta.icon} ${escapeHtml(meta.label)}</span>` +
    '</header>' +
    `<p class="drv-vendor">${escapeHtml(d.vendor)}</p>` +
    '<dl class="drv-meta">' +
    `<div><dt>Protokol</dt><dd>${escapeHtml(d.protocol)}</dd></div>` +
    (d.ports?.length
      ? `<div><dt>Portlar</dt><dd class="mono">${d.ports.map((p) => escapeHtml(p)).join(', ')}</dd></div>`
      : d.defaultPort
        ? `<div><dt>Port</dt><dd class="mono">${escapeHtml(d.defaultPort)}</dd></div>`
        : '') +
    (d.reads?.length
      ? `<div><dt>Okunan alan</dt><dd>${num(d.reads.length)}</dd></div>`
      : '') +
    (d.verifiedOn
      ? `<div><dt>Doğrulandı</dt><dd>${escapeHtml(d.verifiedOn)}</dd></div>`
      : '') +
    '</dl>' +
    // Neye karsi dogrulandigi onemli: simulator ile gercek tezgah ayni sey degil.
    (d.verifiedAgainst
      ? `<p class="drv-note"><b>Neye karşı:</b> ${escapeHtml(d.verifiedAgainst)}</p>`
      : '') +
    (d.verifiedOn_detay
      ? `<details><summary>Doğrulama ayrıntısı</summary><p>${escapeHtml(d.verifiedOn_detay)}</p></details>`
      : '') +
    (d.requires?.length
      ? '<details><summary>Gereksinimler</summary><ul>' +
        d.requires.map((r) => `<li>${escapeHtml(r)}</li>`).join('') + '</ul></details>'
      : '') +
    (d.notes ? `<p class="drv-note">${escapeHtml(d.notes)}</p>` : '') +
    '</article>'
  );
}

function machineTable(machines, drivers, defaultDriver) {
  return (
    '<table class="tbl tbl-edit"><thead><tr>' +
    '<th>Kimlik</th><th>Ad</th><th>Sürücü</th><th>IP</th><th>Port</th>' +
    '<th>Kimlik bilgisi</th><th></th>' +
    '</tr></thead><tbody>' +
    machines.map((m, i) => {
      const resolved = m.driverId ?? defaultDriver;
      return '<tr>' +
        `<td><input data-row="${i}" data-key="id" value="${escapeHtml(m.id ?? '')}" size="9" class="mono"></td>` +
        `<td><input data-row="${i}" data-key="name" value="${escapeHtml(m.name ?? '')}"></td>` +
        `<td><select data-row="${i}" data-key="driverId">` +
        `<option value=""${m.driverId ? '' : ' selected'}>(varsayılan)</option>` +
        drivers.map((d) =>
          `<option value="${escapeHtml(d.id)}"${d.id === m.driverId ? ' selected' : ''}` +
          `${d.selectable ? '' : ' disabled'}>` +
          `${escapeHtml(d.label)}${d.selectable ? '' : ' — ajanı yok'}</option>`).join('') +
        '</select>' +
        (m.driverId ? '' : `<span class="inherit">${escapeHtml(resolved)}</span>`) +
        '</td>' +
        `<td><input data-row="${i}" data-key="ip" value="${escapeHtml(m.ip ?? '')}" placeholder="192.168.1.101" size="13" class="mono"></td>` +
        `<td><input data-row="${i}" data-key="port" value="${escapeHtml(m.port ?? '')}" placeholder="5566" size="6" class="mono"></td>` +
        '<td><label class="chk">' +
        `<input type="checkbox" data-row="${i}" data-key="identified"${m.identified ? ' checked' : ''}>` +
        ' toplandı</label></td>' +
        `<td><button type="button" class="icon-btn" data-act="del" data-row="${i}" ` +
        `aria-label="${escapeHtml(m.id ?? '')} tezgahını kaldır">Kaldır</button></td>` +
        '</tr>';
    }).join('') +
    '</tbody></table>'
  );
}

/**
 * Dinleyiciler kaba BIR KEZ baglanir. renderConfig her cagrildiginda innerHTML
 * degisiyor; dinleyici her seferinde eklenirse birikir ve tek tiklama birden
 * cok kez islenir.
 */
function wire(host, onSaved) {
  if (host.dataset.wired === '1') return;
  host.dataset.wired = '1';

  host.addEventListener('input', (ev) => {
    const t = ev.target;
    const row = t.dataset?.row;
    if (row === undefined) return;
    const i = Number(row);
    const key = t.dataset.key;
    draft[i][key] = t.type === 'checkbox' ? t.checked : t.value;
    if (!dirty) {
      dirty = true;
      const save = host.querySelector('[data-act="save"]');
      if (save) { save.disabled = config.readOnly; save.textContent = 'Kaydet *'; }
    }
  });

  host.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'add') {
      const n = draft.length + 1;
      draft.push({ id: `CNC-${String(n).padStart(2, '0')}`, name: `Tezgah ${n}`, ip: null, identified: false });
      dirty = true;
      message = null;
      renderConfig(host, onSaved);
      return;
    }

    if (act === 'del') {
      const i = Number(btn.dataset.row);
      const m = draft[i];
      if (!confirm(`"${m.name || m.id}" tezgahı yapılandırmadan kaldırılsın mı?\n\n` +
        'Kayıtlı geçmişi silinmez; listede "kaldırıldı" olarak görünmeye devam eder.')) return;
      draft.splice(i, 1);
      dirty = true;
      message = null;
      renderConfig(host, onSaved);
      return;
    }

    if (act === 'save') {
      btn.disabled = true;
      btn.textContent = 'Kaydediliyor…';
      try {
        const res = await fetch('/api/config/machines', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ machines: draft }),
        });
        const body = await res.json();
        if (!res.ok) {
          message = {
            ok: false,
            text: (body.errors ?? [body.error ?? 'bilinmeyen hata']).join(' · '),
          };
        } else {
          message = { ok: true, text: `${body.saved} tezgah kaydedildi.` };
          dirty = false;
          config = null; // sunucudan tazesini al
        }
      } catch (err) {
        message = { ok: false, text: `Kaydedilemedi: ${err.message}` };
      }
      await renderConfig(host, onSaved);
      if (message?.ok) onSaved?.();
    }
  });
}
