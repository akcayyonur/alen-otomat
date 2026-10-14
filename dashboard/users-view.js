/**
 * Ayarlar > Kullanicilar (YALNIZ yonetici): hesap ekle/sil, sifre belirle, son giris olaylari.
 * Roller: yonetici (her sey) ve izleyici (yalniz izleme). Sifre ozetleri sunucudan zaten gelmez.
 */
import { escapeHtml, dateTime } from './format.js';
import { api, post } from './lib-common.js';
import { getSession, openFormDialog, roleLabel } from './auth-view.js';

const EVENT_LABEL = Object.freeze({
  login_ok: 'giriş yaptı',
  login_fail: 'hatalı giriş',
  login_locked: 'kilitlendi (çok deneme)',
  logout: 'çıkış yaptı',
  setup: 'ilk kurulum',
  user_created: 'hesap açıldı',
  user_deleted: 'hesap silindi',
  password_set: 'şifre belirlendi',
  password_changed: 'şifresini değiştirdi',
  password_change_fail: 'şifre değiştirme başarısız',
});

const del = (path) => api(path, { method: 'DELETE' });
const put = (path, obj) => api(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

/** @param {HTMLElement} host `[data-role="users"]` bolumu */
export async function renderUsers(host) {
  if (!host) return;
  host.innerHTML = '<div class="dt-block-head"><h3>Kullanıcılar</h3></div><p class="empty">Yükleniyor…</p>';
  let users;
  let events;
  try {
    [{ users }, { events }] = await Promise.all([api('/api/users'), api('/api/auth/audit?limit=15')]);
  } catch (err) {
    host.innerHTML = `<div class="dt-block-head"><h3>Kullanıcılar</h3></div><p class="notice notice-sim">Kullanıcılar alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const me = getSession()?.user?.username?.toLowerCase();

  host.innerHTML =
    '<div class="dt-block-head"><h3>Kullanıcılar</h3>' +
    '<span class="hint" style="margin:0">Yönetici her şeyi görür. <b>İzleyici</b> yalnızca canlı izlemeyi görür: ' +
    'program kütüphanesi, ayarlar ve tezgahlardaki "Programlar" paneli ona kapalıdır.</span></div>' +
    '<p data-role="msg" class="notice" hidden></p>' +
    '<div class="table-wrap"><table class="tbl"><thead><tr><th>Kullanıcı</th><th>Rol</th><th>Oluşturuldu</th><th>Son giriş</th><th></th></tr></thead><tbody>' +
    users.map((u) =>
      `<tr><td class="mono"><b>${escapeHtml(u.username)}</b>${u.username.toLowerCase() === me ? ' <span class="chip chip-info">siz</span>' : ''}</td>` +
      `<td><span class="chip chip-${u.role === 'admin' ? 'warn' : 'none'}">${escapeHtml(roleLabel(u.role))}</span></td>` +
      `<td>${escapeHtml(dateTime(u.createdAt))}</td><td>${u.lastLoginAt ? escapeHtml(dateTime(u.lastLoginAt)) : '—'}</td>` +
      `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="pw" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Şifre belirle</button> ` +
      `<button type="button" class="icon-btn icon-btn-sm" data-act="del" data-id="${u.id}" data-name="${escapeHtml(u.username)}"${u.username.toLowerCase() === me ? ' disabled title="Kendi hesabınızı silemezsiniz"' : ''}>Sil</button></td></tr>`).join('') +
    '</tbody></table></div>' +

    '<h4 class="sub">Yeni hesap</h4>' +
    '<form class="fld-grid" data-role="new-user" autocomplete="off">' +
    '<label class="fld"><span>Kullanıcı adı</span><input name="username" required minlength="3" maxlength="32" autocomplete="off" placeholder="ör. izleyici1"></label>' +
    '<label class="fld"><span>Şifre (en az 8 karakter)</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>' +
    '<label class="fld"><span>Rol</span><select name="role"><option value="viewer">İzleyici (yalnızca izleme)</option><option value="operator">Operatör (fabrika bilgisayarı: iş emri başlat/bitir, duruş nedeni)</option><option value="admin">Yönetici (her şey)</option></select></label>' +
    '<div class="fld" style="justify-content:flex-end"><button type="submit" class="icon-btn btn-primary">Hesap ekle</button></div></form>' +

    '<h4 class="sub">Son giriş olayları</h4>' +
    (events.length === 0 ? '<p class="empty">Henüz olay yok.</p>' :
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>Zaman</th><th>Kullanıcı</th><th>Olay</th><th>Adres</th><th>Ayrıntı</th></tr></thead><tbody>' +
      events.map((e) =>
        `<tr><td>${escapeHtml(dateTime(e.ts))}</td><td class="mono">${escapeHtml(e.username ?? '—')}</td>` +
        `<td>${escapeHtml(EVENT_LABEL[e.event] ?? e.event)}</td><td class="mono">${escapeHtml(e.ip ?? '—')}</td><td>${escapeHtml(e.detail ?? '')}</td></tr>`).join('') +
      '</tbody></table></div>');

  const msg = (text, ok = true) => {
    const el = host.querySelector('[data-role="msg"]');
    el.hidden = !text;
    el.className = `notice${ok ? '' : ' notice-sim'}`;
    el.textContent = text ?? '';
  };

  host.querySelector('[data-role="new-user"]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    try {
      await post('/api/users', { username: String(f.get('username')).trim(), password: String(f.get('password')), role: f.get('role') });
      await renderUsers(host);
      host.querySelector('[data-role="msg"]').hidden = false;
      host.querySelector('[data-role="msg"]').textContent = `"${String(f.get('username')).trim()}" hesabı oluşturuldu.`;
    } catch (err) {
      msg(err.message, false);
    }
  });

  // `onclick` ATAMASI: bu bolum her cizildiginde ayni eleman kullanilir; addEventListener dinleyicileri biriktirirdi.
  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const id = Number(btn.dataset.id);
    const name = btn.dataset.name;
    if (btn.dataset.act === 'pw') {
      openFormDialog({
        title: `Şifre belirle: ${name}`,
        intro: 'Bu kullanıcının tüm açık oturumları kapanır; yeni şifreyle yeniden girmesi gerekir.',
        fields: [{ name: 'password', label: 'Yeni şifre', type: 'password', hint: 'En az 8 karakter.' }],
        submitLabel: 'Şifreyi belirle',
        onSubmit: async (v) => { await put(`/api/users/${id}/password`, { password: v.password }); },
      });
    } else if (btn.dataset.act === 'del') {
      if (!window.confirm(`"${name}" hesabı silinsin mi? Açık oturumları da kapanır.`)) return;
      del(`/api/users/${id}`).then(() => renderUsers(host)).catch((err) => msg(err.message, false));
    }
  };
}
