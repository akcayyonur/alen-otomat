/**
 * Giris sistemi (arayuz): giris / ilk kurulum ekrani, oturum durumu, ust cubukta kullanici + cikis,
 * sifre degistirme ve 401 korumasi (oturum bitince sayfa giris ekranina doner).
 *
 * Roller: admin (her sey) ve viewer (yalniz izleme: program kutuphanesi, ayarlar ve tezgahtaki
 * "Programlar" paneli GIZLENIR; sunucu bu uclari zaten reddeder, buradaki gizleme yalniz kolaylik).
 * Bu dosya baska dashboard modullerini import etmez (dongu olmasin); herkes buradan oturumu okur.
 */
import { escapeHtml } from './format.js';

const ROLE_LABEL = Object.freeze({ admin: 'yönetici', viewer: 'izleyici' });

/** @type {{authenticated: boolean, authDisabled?: boolean, user?: {username: string, role: string}}|null} */
let session = null;

export const getSession = () => session;
export const isAdmin = () => session?.user?.role === 'admin';
export const authDisabled = () => session?.authDisabled === true;
export const roleLabel = (role) => ROLE_LABEL[role] ?? role;

/* ------------------------------------------------------------------------- ag */

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Hata (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchSession() {
  const res = await fetch('/api/session', { cache: 'no-store' });
  return res.json();
}

/* --------------------------------------------------------------------- 401 korumasi */

let reloading = false;
function sessionEnded() {
  if (reloading) return;
  reloading = true;
  try { sessionStorage.setItem('cnc-session-ended', '1'); } catch { /* gizli sekme */ }
  location.reload();
}

/** Oturum bitince (401) tum sayfa giris ekranina doner; kullanici hicbir ekranda "bos" kalmaz. */
function installFetchGuard() {
  if (window.__cncFetchGuard) return;
  window.__cncFetchGuard = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    if (res.status === 401) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.startsWith('/api/') && !/^\/api\/(auth\/(login|setup)|session)$/.test(url.pathname)) sessionEnded();
    }
    return res;
  };
}

/** Canli akis koptugunda cagrilir: oturum bittiyse giris ekranina don, yalniz ag sorunuysa dokunma. */
export async function checkSessionAfterStreamError() {
  try {
    const s = await fetchSession();
    if (!s.authenticated) sessionEnded();
  } catch { /* sunucuya ulasilamiyor: akis kendi yeniden baglanma mantigini surdurur */ }
}

/* ------------------------------------------------------------------ giris ekrani */

function gateHtml(s, notice) {
  const brand = '<span class="eyebrow">CNC-TLM-001 · Canlı Telemetri</span><h1>CNC Telemetri</h1>';
  if (s.setupRequired && !s.setupAllowed) {
    return `${brand}<p class="notice notice-sim"><b>Henüz hesap yok.</b> İlk yönetici hesabı yalnızca <b>sunucu bilgisayarında</b>, ` +
      `<code>http://localhost:${location.port || 80}</code> adresinden oluşturulabilir. Uzaktan ya da başka bir bilgisayardan oluşturulamaz.</p>`;
  }
  if (s.setupRequired) {
    return `${brand}<p class="notice">İlk kurulum: <b>yönetici hesabını</b> oluşturun. Bu hesap her şeyi görür ve yapar; ` +
      'izleyici hesaplarını sonra Ayarlar ekranından açarsınız.</p>' +
      '<form class="auth-form" data-form="setup" autocomplete="off">' +
      '<label class="fld"><span>Kullanıcı adı</span><input name="username" value="admin" autocomplete="username" required minlength="3" maxlength="32"></label>' +
      '<label class="fld"><span>Şifre (en az 8 karakter)</span><input name="password" type="password" autocomplete="new-password" required minlength="8"></label>' +
      '<label class="fld"><span>Şifre (tekrar)</span><input name="password2" type="password" autocomplete="new-password" required minlength="8"></label>' +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      '<button type="submit" class="icon-btn btn-primary">Yönetici hesabını oluştur</button></form>';
  }
  return `${brand}${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}` +
    '<form class="auth-form" data-form="login">' +
    '<label class="fld"><span>Kullanıcı adı</span><input name="username" autocomplete="username" required autofocus maxlength="32"></label>' +
    '<label class="fld"><span>Şifre</span><input name="password" type="password" autocomplete="current-password" required></label>' +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    '<button type="submit" class="icon-btn btn-primary">Giriş yap</button></form>';
}

/** Giris/kurulum ekranini gosterir; basarili olunca yeni oturum durumuyla cozulur. */
function showGate(s) {
  return new Promise((resolve) => {
    let notice = null;
    try {
      if (sessionStorage.getItem('cnc-session-ended')) {
        notice = 'Oturum süresi doldu ya da kapatıldı. Lütfen yeniden giriş yapın.';
        sessionStorage.removeItem('cnc-session-ended');
      }
    } catch { /* gizli sekme */ }

    const gate = document.createElement('div');
    gate.className = 'auth-gate';
    gate.innerHTML = `<div class="auth-card">${gateHtml(s, notice)}</div>`;
    document.body.append(gate);
    gate.querySelector('input')?.focus();

    const form = gate.querySelector('form');
    if (!form) return; // hesap yok ve burasi sunucu degil: yalniz bilgi gosterilir
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const err = gate.querySelector('[data-role="err"]');
      const btn = form.querySelector('button');
      err.hidden = true;
      if (form.dataset.form === 'setup' && f.get('password') !== f.get('password2')) {
        err.textContent = 'İki şifre aynı değil.';
        err.hidden = false;
        return;
      }
      btn.disabled = true;
      try {
        await postJson(form.dataset.form === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
          username: String(f.get('username')).trim(), password: String(f.get('password')),
        });
        gate.remove();
        resolve(await fetchSession());
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        form.querySelector('input[name="password"]').value = '';
        btn.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------ form penceresi (ortak) */

/**
 * Kucuk form penceresi. `fields`: [{name, label, type?, value?, hint?}]. `onSubmit(degerler)` hata fırlatırsa
 * mesaj pencerede gosterilir, basarili olursa pencere kapanir.
 */
export function openFormDialog({ title, intro = '', fields, submitLabel, onSubmit }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML =
    '<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">Hesap</span>' +
    `<h3>${escapeHtml(title)}</h3></div><button type="button" class="icon-btn" data-act="cancel">Vazgeç</button></header>` +
    '<form class="modal-body" autocomplete="off">' +
    (intro ? `<p class="notice">${escapeHtml(intro)}</p>` : '') +
    fields.map((f) =>
      `<label class="fld"><span>${escapeHtml(f.label)}</span><input name="${escapeHtml(f.name)}" type="${f.type ?? 'text'}" ` +
      `value="${escapeHtml(f.value ?? '')}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" required>` +
      `${f.hint ? `<small class="hint">${escapeHtml(f.hint)}</small>` : ''}</label>`).join('') +
    '<p class="notice notice-sim" data-role="err" hidden></p>' +
    `<div class="dt-actions"><button type="submit" class="icon-btn btn-primary">${escapeHtml(submitLabel)}</button></div></form></div>`;
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
    try {
      await onSubmit(Object.fromEntries(new FormData(form).entries()));
      close();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  dlg.showModal();
  form.querySelector('input')?.focus();
}

function openPasswordDialog() {
  openFormDialog({
    title: 'Şifremi değiştir',
    intro: 'Şifre değişince diğer cihazlardaki oturumlarınız kapanır.',
    fields: [
      { name: 'current', label: 'Mevcut şifre', type: 'password' },
      { name: 'next', label: 'Yeni şifre', type: 'password', hint: 'En az 8 karakter.' },
      { name: 'next2', label: 'Yeni şifre (tekrar)', type: 'password' },
    ],
    submitLabel: 'Şifreyi değiştir',
    onSubmit: async (v) => {
      if (v.next !== v.next2) throw new Error('Yeni şifreler aynı değil.');
      await postJson('/api/auth/password', { current: v.current, next: v.next });
    },
  });
}

/* ------------------------------------------------------------------ ust cubuk */

function mountTopbar() {
  const chip = document.getElementById('user-chip');
  const out = document.getElementById('logout-btn');
  if (!chip || !out || !session?.user) return;
  const u = session.user;
  chip.hidden = false;
  if (session.authDisabled) {
    chip.textContent = 'giriş kapalı (geliştirme)';
    chip.title = 'AUTH_DISABLED=1: bu sunucuda giriş sistemi kapalı, herkes yönetici.';
    return;
  }
  chip.textContent = `${u.username} · ${roleLabel(u.role)}`;
  chip.title = 'Şifremi değiştir';
  chip.addEventListener('click', openPasswordDialog);
  out.hidden = false;
  out.addEventListener('click', async () => {
    out.disabled = true;
    try { await postJson('/api/auth/logout'); } catch { /* oturum zaten bitmis olabilir */ }
    location.reload();
  });
}

/* ------------------------------------------------------------------- baslatma */

/** Giris yapilana dek bekler (giris ekranini gosterir), sonra oturumu dondurur. */
export async function initAuth() {
  installFetchGuard();
  let s = await fetchSession();
  while (!s.authenticated) s = await showGate(s);
  session = s;
  mountTopbar();
  return session;
}
