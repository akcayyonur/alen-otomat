/**
 * Ayarlar > Roller (yalnız yönetici): admin-tanımlı roller. "admin" sabit roldür (her şey); burada
 * yaratılan her rol, shared/screens.js'teki her ekran için Kapalı / Görebilir / Yazabilir seçeneğiyle
 * tanımlanır. İş emirleri ve Ölçü raporları ekranları (writable:false) için "Yazabilir" seçeneği hiç
 * sunulmaz: bu, kullanıcı kararıyla yapısal bir kısıttır.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { openFormDialog } from './auth-view.js';
import { SCREENS } from './screens.js';

const del = (path) => api(path, { method: 'DELETE' });
const put = (path, obj) => api(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

const LEVEL_LABEL = Object.freeze({ '': 'Kapalı', read: 'Görebilir', write: 'Yazabilir' });

/** Bir rolun kısa özeti: "3 ekran: yazabilir; 2 ekran: görebilir". */
function summarize(grants) {
  const write = Object.values(grants).filter((v) => v === 'write').length;
  const read = Object.values(grants).filter((v) => v === 'read').length;
  if (write === 0 && read === 0) return 'hiçbir ekran açık değil';
  const parts = [];
  if (write > 0) parts.push(`${write} ekran: yazabilir`);
  if (read > 0) parts.push(`${read} ekran: görebilir`);
  return parts.join('; ');
}

/** @param {HTMLElement} host `[data-role="roles"]` bolumu @param {() => void} [onChanged] rol olusturulunca/silinince cagirilir (Kullanicilar bolumundeki rol secimi tazelensin diye) */
export async function renderRoles(host, onChanged = () => {}) {
  if (!host) return;
  host.innerHTML = '<div class="dt-block-head"><h3>Roller</h3></div><p class="empty">Yükleniyor…</p>';
  let roles;
  let users;
  try {
    [{ roles }, { users }] = await Promise.all([api('/api/roles'), api('/api/users')]);
  } catch (err) {
    host.innerHTML = `<div class="dt-block-head"><h3>Roller</h3></div><p class="notice notice-sim">Roller alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const countOf = (roleId) => users.filter((u) => u.roleId === roleId).length;

  host.innerHTML =
    '<div class="dt-block-head"><h3>Roller</h3>' +
    '<span class="hint" style="margin:0">"admin" sabit roldür (her şey). Diğer hesaplar burada tanımladığınız bir role bağlıdır: ' +
    'her ekran için Kapalı / Görebilir / Yazabilir seçersiniz. İş emirleri ve Ölçü raporları her zaman salt okunurdur.</span>' +
    '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="new">Yeni rol…</button></div></div>' +
    '<p data-role="msg" class="notice" hidden></p>' +
    (roles.length === 0 ? '<p class="empty">Henüz rol yok. "Yeni rol…" ile oluşturun (ör. "İmalat").</p>' :
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>Rol</th><th>Kaç hesap</th><th>Yetkiler</th><th></th></tr></thead><tbody>' +
      roles.map((r) =>
        `<tr><td class="mono"><b>${escapeHtml(r.name)}</b></td><td class="num">${countOf(r.id)}</td><td>${escapeHtml(summarize(r.grants))}</td>` +
        `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="edit" data-id="${r.id}">Düzenle…</button> ` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="del" data-id="${r.id}" data-name="${escapeHtml(r.name)}">Sil…</button></td></tr>`).join('') +
      '</tbody></table></div>');

  const msg = (text, ok = true) => {
    const el = host.querySelector('[data-role="msg"]');
    el.hidden = !text;
    el.className = `notice${ok ? '' : ' notice-sim'}`;
    el.textContent = text ?? '';
  };

  const refresh = () => { renderRoles(host, onChanged); onChanged(); };
  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'new') return openRoleDialog({ onDone: refresh });
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'edit') {
      const role = roles.find((r) => r.id === id);
      return openRoleDialog({ role, onDone: refresh });
    }
    if (btn.dataset.act === 'del') {
      if (!window.confirm(`"${btn.dataset.name}" rolü silinsin mi? Bu role atanmış hesap varsa silinemez.`)) return;
      del(`/api/roles/${id}`).then(refresh).catch((err) => msg(err.message, false));
    }
  };
}

/** Rol kutuları için kısa radyo grubu (writable:false'ta "Yazabilir" hiç yok). */
function screenRow(s, level) {
  const levels = s.writable ? ['', 'read', 'write'] : ['', 'read'];
  return (
    `<tr><td>${escapeHtml(s.label)}</td><td class="nowrap">` +
    levels.map((lv) =>
      `<label class="chk-inline"><input type="radio" name="g_${s.id}" value="${lv}"${level === lv ? ' checked' : ''}> ${LEVEL_LABEL[lv]}</label>`)
      .join(' ') + '</td></tr>'
  );
}

/** @param {{role?: object, onDone: () => void}} opts role verilmezse "yeni rol" */
function openRoleDialog({ role = null, onDone }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  const grants = role?.grants ?? {};
  dlg.innerHTML =
    '<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">Rol</span>' +
    `<h3>${role ? `Rolü düzenle: ${escapeHtml(role.name)}` : 'Yeni rol'}</h3></div>` +
    '<button type="button" class="icon-btn" data-act="cancel">Vazgeç</button></header>' +
    '<form class="modal-body" autocomplete="off">' +
    `<label class="fld"><span>Rol adı</span><input name="name" value="${escapeHtml(role?.name ?? '')}" maxlength="40" required autocomplete="off" placeholder="ör. İmalat"></label>` +
    '<p class="hint">Her ekran için erişimi seçin. "İş emirleri" ve "Ölçü raporları" her zaman salt okunurdur.</p>' +
    '<div class="table-wrap"><table class="tbl tbl-pl"><tbody>' +
    SCREENS.map((s) => screenRow(s, grants[s.id] ?? '')).join('') +
    '</tbody></table></div>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">${role ? 'Kaydet' : 'Rolü oluştur'}</button></div></form></div>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = dlg.querySelector('[data-role="err"]');
    const btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    const name = form.elements.name.value.trim();
    const g = {};
    for (const s of SCREENS) {
      const v = form.elements[`g_${s.id}`]?.value ?? '';
      if (v === 'read' || v === 'write') g[s.id] = v;
    }
    try {
      if (role) await put(`/api/roles/${role.id}`, { name, grants: g });
      else await post('/api/roles', { name, grants: g });
      close();
      await onDone();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  dlg.showModal();
  form.querySelector('input[name="name"]').focus();
}
