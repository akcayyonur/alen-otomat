/**
 * Planlama > MIKRO API (yalniz yonetici): Kaynak klasorune (Excel) PARALEL — Mikro'nun kendi PC'sindeki MikroAPI servisinden
 * canli SQL ile sipariş satırlarını VE ürün kartı ipuçlarını (HM/BR/NT/SN/TAM BOY, ayni sorguda) okur. Hesaplar sunucuda
 * (backend/planning/mikro.js); burasi yalniz gosterir. Excel akışı devre dışı bırakılmaz, ikisi paralel kalır.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { openModal, dateTimeText, fmtNum } from './planning-common.js';

const nf = new Intl.NumberFormat('tr-TR');
const n = (v) => nf.format(v ?? 0);

function statusText(st) {
  if (!st.configured) return { short: 'MikroAPI yapılandırılmadı (ortam değişkenleri eksik).', full: '' };
  const last = st.last ? `son senkron: ${dateTimeText(st.last.at)}${st.last.by ? ` (${st.last.by})` : ''} · ${n(st.last.rows)} satır` : 'henüz senkronize edilmedi';
  return { short: `${st.host}:${st.port} · ${last}`, full: '' };
}

/** Basliktaki durum satirini gunceller. @param {HTMLElement} host planlama kabugu */
export async function showMikroStatus(host) {
  const line = host.querySelector('[data-role="mikro-status"]');
  if (!line) return null;
  try {
    const st = await api('/api/planning/mikro');
    const txt = statusText(st);
    line.textContent = txt.short;
    if (txt.full) line.title = txt.full; else line.removeAttribute('title');
    return st;
  } catch (err) {
    line.textContent = `MikroAPI durumu alınamadı: ${err.message}`;
    return null;
  }
}

const lineText = (x) => `<span class="mono">${escapeHtml(x.docNo)}</span> · ${escapeHtml(x.stockCode)} · ${fmtNum(x.qty)} adet${x.remaining == null ? '' : ` · kalan ${fmtNum(x.remaining)}`}`;
const productText = (x) => `<b>${escapeHtml(x.stockCode)}</b>${x.fields?.length ? ` — ${escapeHtml(x.fields.join(', '))}` : ''}`;

function listBlock(title, items, total, fmt) {
  if (!total) return '';
  const more = total - items.length;
  return `<h4 class="sub">${escapeHtml(title)} (${n(total)})</h4><ul class="pl-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}` +
    `${more > 0 ? `<li class="hint">… ve ${n(more)} kayıt daha</li>` : ''}</ul>`;
}

function mikroResultHtml(r) {
  const t = r.totals;
  const c = r.changes;
  const changed = t.lines.added + t.lines.updated + t.products.added + t.products.updated;
  let head;
  if (r.rows === 0) head = '<div class="notice notice-sim"><b>Mikro\'dan hiç satır gelmedi.</b> SIPARISLER sorgusu boş döndü.</div>';
  else if (changed === 0) head = `<div class="notice"><b>${n(r.rows)} satır okundu</b>, uygulamadaki kayıtlarda değişiklik çıkmadı.</div>`;
  else head = `<div class="notice"><b>${n(r.rows)} satır okundu.</b> ${[
    t.lines.added + t.lines.updated > 0 ? `Siparişler: <b>${n(t.lines.added)}</b> yeni satır, <b>${n(t.lines.updated)}</b> güncellendi.` : '',
    t.products.added + t.products.updated > 0 ? `Ürün kartları: <b>${n(t.products.added)}</b> yeni, <b>${n(t.products.updated)}</b> güncellendi.` : '',
  ].filter(Boolean).join(' ')}</div>`;

  const protectedBlock = t.products.protected > 0
    ? `<h4 class="sub">Elle düzenlenmiş kartlarda Mikro farkı — dokunulmadı (${n(t.products.protected)})</h4>` +
      `<p class="hint">Bu kartlar elle düzenlendiği için Mikro'daki değişiklik uygulanmadı.</p><ul class="pl-list">${c.products.protected.map((x) => `<li>${productText(x)}</li>`).join('')}</ul>`
    : '';
  const warnings = (r.warnings ?? []).slice(0, 10);
  const warnBlock = warnings.length > 0
    ? `<h4 class="sub">Uyarılar</h4><ul class="checks">${warnings.map((w) => `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(w)}</div></li>`).join('')}</ul>`
    : '';
  return (
    head +
    listBlock('Yeni sipariş satırları', c.lines.added, t.lines.added, lineText) +
    listBlock('Güncellenen sipariş satırları (kalan miktar, termin ...)', c.lines.updated, t.lines.updated, lineText) +
    listBlock('Yeni ürün kartları', c.products.added, t.products.added, productText) +
    listBlock('Güncellenen ürün kartları (Mikro\'da değişen alanlar)', c.products.updated, t.products.updated, productText) +
    protectedBlock + warnBlock
  );
}

/** MikroAPI'den canli okur, degisenleri uygular ve sonucu bir pencerede gosterir. */
export async function runMikroRefresh({ onDone = () => {} } = {}) {
  const m = openModal({ title: "Mikro'dan al", wide: true });
  m.body.innerHTML = '<p class="hint">MikroAPI\'den sipariş + ürün kartı verisi okunuyor…</p>';
  try {
    const r = await post('/api/planning/mikro/refresh', {});
    m.body.innerHTML = mikroResultHtml(r) +
      '<p class="hint">Bu, "Kaynak klasörü" (Excel) akışının YERİNE değil, yanına çalışır; ikisi de ayrı ayrı denenebilir.</p>';
    onDone();
  } catch (e) {
    m.body.innerHTML = `<p class="notice notice-sim">${escapeHtml(e.message)}</p>` +
      (e.code === 'mikro-not-configured' ? '<p class="hint">Ortam değişkenleri (MIKRO_API_HOST, MIKRO_FIRMA_KODU …) sunucuda ayarlanmamış.</p>' : '');
  }
}
