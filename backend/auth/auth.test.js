/**
 * Kimlik dogrulama: sifre ozeti, hesap kurallari, giris/oturum/kilitleme (zaman enjekte edilir),
 * oturum suresi (admin 12 sa / viewer 30 gun), sifre degisince oturumlarin kapanmasi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePassword } from './password.js';
import { AuthDb } from './auth-db.js';
import { Auth, AuthError, IDLE_MS, ABSOLUTE_MS, ROLES } from './auth.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function kur() {
  const clock = { t: 1_700_000_000_000 };
  const db = new AuthDb(':memory:');
  const auth = new Auth({ db, now: () => clock.t });
  return { db, auth, clock };
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof AuthError && e.status === status && (!re || re.test(e.message)));

/* ------------------------------------------------------------------------ sifre */

test('sifre: scrypt ozeti dogrulanir, yanlis sifre ve bozuk kayit reddedilir, ayni sifre iki ozet farkli', async () => {
  const h1 = await hashPassword('doğru-şifre-123');
  const h2 = await hashPassword('doğru-şifre-123');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2, 'tuz her seferinde farkli');
  assert.equal(await verifyPassword('doğru-şifre-123', h1), true);
  assert.equal(await verifyPassword('yanlis-sifre', h1), false);
  assert.equal(await verifyPassword('', h1), false);
  for (const bozuk of [null, '', 'düz metin', 'scrypt$1$1$1$a$b', 'scrypt$16384$8$1$AAAA$AAAA', `${h1}$fazla`, 'bcrypt$x$y$z$a$b']) {
    assert.equal(await verifyPassword('x', bozuk), false, String(bozuk));
  }
  // asiri parametre (bellek bombasi) reddedilir, hesaplanmaz
  assert.equal(await verifyPassword('x', 'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
});

test('sifre kurali: en az 8, en cok 200 karakter, bos olamaz', () => {
  assert.equal(validatePassword('1234567'), 'Şifre en az 8 karakter olmalı.');
  assert.equal(validatePassword('12345678'), null);
  assert.match(validatePassword('x'.repeat(201)), /en fazla 200/);
  assert.match(validatePassword('        '), /boşluk/);
  assert.match(validatePassword(undefined), /yok/);
});

/* ----------------------------------------------------------------------- hesaplar */

test('ilk kurulum: hesap yokken yonetici olusur, sonra kapanir', async () => {
  const { auth } = kur();
  assert.equal(auth.setupRequired, true);
  const u = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  assert.equal(u.role, 'admin');
  assert.equal(auth.setupRequired, false);
  await rejects(auth.setup({ username: 'baska', password: 'sifre-12345' }), 409, /zaten yapılmış/);
});

test('hesap kurallari: kullanici adi, rol, sifre, tekrarlanan ad (buyuk/kucuk harf duyarsiz)', async () => {
  const { auth } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  await rejects(auth.createUser({ username: 'a', password: 'sifre-12345', role: 'viewer' }, { actor: admin }), 400, /3-32/);
  await rejects(auth.createUser({ username: 'ali veli', password: 'sifre-12345', role: 'viewer' }, { actor: admin }), 400);
  await rejects(auth.createUser({ username: 'ali', password: 'kisa', role: 'viewer' }, { actor: admin }), 400, /en az 8/);
  await rejects(auth.createUser({ username: 'ali', password: 'sifre-12345', role: 'root' }, { actor: admin }), 400, /Rol geçersiz/);
  const v = await auth.createUser({ username: 'Izleyici', password: 'sifre-12345', role: 'viewer' }, { actor: admin });
  assert.equal(v.role, 'viewer');
  await rejects(auth.createUser({ username: 'izleyici', password: 'sifre-12345', role: 'viewer' }, { actor: admin }), 409, /zaten var/);
  assert.deepEqual(auth.listUsers().map((x) => x.username), ['admin', 'Izleyici']);
  assert.ok(!JSON.stringify(auth.listUsers()).includes('scrypt'), 'sifre ozeti listede GORUNMEZ');
});

test('silme: kendini ve son yoneticiyi silemez; silinen kullanicinin oturumlari gider', async () => {
  const { auth, db } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  const viewer = await auth.createUser({ username: 'izleyici', password: 'sifre-12345', role: 'viewer' }, { actor: admin });
  const { token } = await auth.login('izleyici', 'sifre-12345', { ip: '10.0.0.5' });
  assert.ok(auth.authenticate(token));

  // kendi hesabini silemez
  assert.throws(() => auth.deleteUser(admin.id, { actor: admin }), (e) => e.status === 400 && /Kendi hesabınızı/.test(e.message));
  // tek yonetici varken (baskasi silmeye calissa bile) silinemez
  assert.throws(() => auth.deleteUser(admin.id, { actor: viewer }), (e) => e.status === 400 && /Son yönetici/.test(e.message));
  assert.equal(db.countAdmins(), 1);

  // ikinci yonetici varsa digeri silinebilir; geriye bir yonetici kalir
  const ikinci = await auth.createUser({ username: 'admin2', password: 'sifre-12345', role: 'admin' }, { actor: admin });
  auth.deleteUser(admin.id, { actor: ikinci });
  assert.equal(db.countAdmins(), 1);
  assert.throws(() => auth.deleteUser(ikinci.id, { actor: viewer }), (e) => e.status === 400 && /Son yönetici/.test(e.message));

  auth.deleteUser(viewer.id, { actor: ikinci });
  assert.equal(auth.authenticate(token), null, 'silinen kullanicinin oturumu gecersiz');
  assert.throws(() => auth.deleteUser(9999, { actor: ikinci }), (e) => e.status === 404);
});

/* -------------------------------------------------------------- giris ve oturum */

test('giris: dogru sifre oturum verir, yanlis sifre ve olmayan kullanici AYNI mesajla reddedilir', async () => {
  const { auth, db } = kur();
  await auth.setup({ username: 'admin', password: 'sifre-12345' });
  const r = await auth.login('ADMIN', 'sifre-12345', { ip: '10.0.0.5', userAgent: 'test' });
  assert.equal(r.user.username, 'admin');
  assert.equal(r.maxAgeSec, IDLE_MS.admin / 1000);
  assert.ok(r.token.length >= 40);
  assert.equal(db.countSessions(), 1);
  assert.ok(!('passwordHash' in r.user), 'sifre ozeti donmez');

  const a = await auth.login('admin', 'yanlis-sifre', { ip: '10.0.0.6' }).catch((e) => e);
  const b = await auth.login('yok-boyle-biri', 'yanlis-sifre', { ip: '10.0.0.7' }).catch((e) => e);
  assert.equal(a.status, 401);
  assert.equal(a.message, b.message, 'kullanici adi sizdirilmaz');
  assert.equal(a.message, 'Kullanıcı adı ya da şifre hatalı.');
});

test('belirtec veritabaninda ozet olarak saklanir (ham belirtec yok)', async () => {
  const { auth, db } = kur();
  await auth.setup({ username: 'admin', password: 'sifre-12345' });
  const { token } = await auth.login('admin', 'sifre-12345');
  const hepsi = db.db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
  assert.equal(hepsi.length, 1);
  assert.notEqual(hepsi[0], token);
  assert.match(hepsi[0], /^[0-9a-f]{64}$/);
  assert.ok(auth.authenticate(token));
  assert.equal(auth.authenticate(`${token}x`), null);
  assert.equal(auth.authenticate(''), null);
  assert.equal(auth.authenticate(undefined), null);
});

test('kilitleme: ayni adres+kullanici 5 hatadan sonra kilitlenir (dogru sifre bile), 15 dk sonra acilir', async () => {
  const { auth, clock } = kur();
  await auth.setup({ username: 'admin', password: 'sifre-12345' });
  for (let i = 0; i < 5; i += 1) {
    await rejects(auth.login('admin', 'yanlis', { ip: '10.0.0.9' }), 401);
  }
  const kilit = await auth.login('admin', 'sifre-12345', { ip: '10.0.0.9' }).catch((e) => e);
  assert.equal(kilit.status, 429);
  assert.ok(kilit.retryAfterSec > 0 && kilit.retryAfterSec <= 900);
  assert.match(kilit.message, /dakika sonra/);

  // baska adresten giris sorunsuz (yalniz o adres kilitli)
  assert.ok((await auth.login('admin', 'sifre-12345', { ip: '10.0.0.10' })).token);

  clock.t += 15 * 60_000 + 1000;
  assert.ok((await auth.login('admin', 'sifre-12345', { ip: '10.0.0.9' })).token, '15 dakika sonra kilit acik');
});

test('kilitleme: ayni adresten FARKLI kullanici adlariyla deneme de (20) kilitler', async () => {
  const { auth } = kur();
  await auth.setup({ username: 'admin', password: 'sifre-12345' });
  for (let i = 0; i < 20; i += 1) {
    await rejects(auth.login(`kullanici${i}`, 'x', { ip: '10.0.0.11' }), 401);
  }
  const kilit = await auth.login('admin', 'sifre-12345', { ip: '10.0.0.11' }).catch((e) => e);
  assert.equal(kilit.status, 429);
});

test('oturum suresi: admin 12 saat bosta kalinca, viewer 30 gun; kullanim suresini kaydirir; mutlak ust sinir', async () => {
  const { auth, clock } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  await auth.createUser({ username: 'izleyici', password: 'sifre-12345', role: 'viewer' }, { actor: admin });
  const a = await auth.login('admin', 'sifre-12345');
  const v = await auth.login('izleyici', 'sifre-12345');

  clock.t += 11 * 3_600_000;
  assert.ok(auth.authenticate(a.token), '11 saat: acik (ve sure kayar)');
  clock.t += 11 * 3_600_000;
  assert.ok(auth.authenticate(a.token), 'son kullanimdan 11 saat sonra yine acik: kayan sure');
  assert.ok(auth.authenticate(v.token));

  clock.t += 13 * 3_600_000;
  assert.equal(auth.authenticate(a.token), null, 'admin 13 saat bostaydi: kapandi');
  assert.ok(auth.authenticate(v.token), 'viewer hala acik');

  // viewer: her 20 gunde bir kullanirsa (bosta kalma 30 gunu asmaz) mutlak 90 gun sinirina kadar acik kalir
  for (let i = 0; i < 4; i += 1) { clock.t += 20 * 86_400_000; assert.ok(auth.authenticate(v.token), `${i + 1}. adim`); }
  clock.t += 20 * 86_400_000; // girisin uzerinden ~101 gun
  assert.equal(auth.authenticate(v.token), null, 'mutlak ust sinir (90 gun) asildi, bosta kalmamis olsa da');
  assert.equal(ABSOLUTE_MS.viewer, 90 * 86_400_000);
});

test('operator rolu: hesap acilir, oturum suresi viewer gibi uzun (30 gun / 90 gun), gecersiz rol reddedilir', async () => {
  const { auth, clock } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  assert.deepEqual([...ROLES], ['admin', 'viewer', 'operator']);
  const op = await auth.createUser({ username: 'fabrika', password: 'sifre-12345', role: 'operator' }, { actor: admin });
  assert.equal(op.role, 'operator');
  await rejects(auth.createUser({ username: 'baska', password: 'sifre-12345', role: 'ustayonetici' }, { actor: admin }), 400, /admin, viewer ya da operator/);
  const o = await auth.login('fabrika', 'sifre-12345');
  assert.equal(o.maxAgeSec, 30 * 86_400, 'fabrika PC\'si surekli acik: cerez omru 30 gun');
  clock.t += 25 * 86_400_000;
  assert.ok(auth.authenticate(o.token), 'bosta 25 gun: acik');
  assert.equal(ABSOLUTE_MS.operator, 90 * 86_400_000);
  assert.equal(IDLE_MS.operator, 30 * 86_400_000);
  assert.equal(auth.listUsers().find((u) => u.username === 'fabrika').role, 'operator');
});

test('veritabani gecisi: "operator"den once olusmus auth.db (CHECK yalniz admin/viewer) acilinca tablo yeniden kurulur, hesap ve oturum korunur', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-gecis-'));
  const file = join(dir, 'auth.db');
  try {
    const eski = new DatabaseSync(file);
    eski.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login_at INTEGER);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ip TEXT, user_agent TEXT);
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT, event TEXT NOT NULL, ip TEXT, detail TEXT);
      INSERT INTO users (username, role, password_hash, created_at) VALUES ('yonetici', 'admin', 'x', 1), ('izleyici', 'viewer', 'y', 2);
      INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('abc', 2, 5, 6);
    `);
    assert.throws(() => eski.exec("INSERT INTO users (username, role, password_hash, created_at) VALUES ('op', 'operator', 'z', 3)"), /CHECK/, 'eski kisit operator\'u reddediyordu');
    eski.close();

    const db = new AuthDb(file);
    assert.deepEqual(db.listUsers().map((u) => [u.id, u.username, u.role]), [[2, 'izleyici', 'viewer'], [1, 'yonetici', 'admin']], 'kimlikler ve roller aynen (liste kullanici adina gore)');
    assert.ok(db.getSession('abc'), 'oturum silinmedi (tablo yeniden kurulurken CASCADE calismadi)');
    const auth = new Auth({ db });
    const op = await auth.createUser({ username: 'fabrika', password: 'sifre-12345', role: 'operator' }, { actor: { username: 'yonetici', role: 'admin' } });
    assert.equal(op.role, 'operator');
    assert.equal(op.id, 3, 'kimlik sirasi korunur');
    db.db.close();
    // ikinci acilis gecis gerektirmez ve veriyi bozmaz
    const db2 = new AuthDb(file);
    assert.equal(db2.listUsers().length, 3);
    db2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acik akis denetimi: isValid sureyi UZATMAZ, cikis ve sifre sifirlama gecersiz kilar', async () => {
  const { auth, clock } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  const viewer = await auth.createUser({ username: 'izleyici', password: 'sifre-12345', role: 'viewer' }, { actor: admin });
  const a = await auth.login('admin', 'sifre-12345');
  const aHash = auth.authenticate(a.token).tokenHash;
  assert.equal(auth.isValid(aHash), true);
  clock.t += 13 * 3_600_000; // yalniz akis acikti, istek yok
  assert.equal(auth.isValid(aHash), false, 'akis suresi uzatmaz: admin 12 saati asinca kesilir');

  const v = await auth.login('izleyici', 'sifre-12345');
  auth.logout(v.token);
  assert.equal(auth.authenticate(v.token), null, 'cikis yapilan oturum gecersiz');

  const v2 = await auth.login('izleyici', 'sifre-12345');
  await auth.setPassword(viewer.id, 'yeni-sifre-999', { actor: admin });
  assert.equal(auth.authenticate(v2.token), null, 'yonetici sifreyi sifirlayinca oturumlar kapanir');
  assert.ok((await auth.login('izleyici', 'yeni-sifre-999')).token);
  await rejects(auth.login('izleyici', 'sifre-12345'), 401);
});

test('kendi sifreni degistir: eskisi gerekir, DIGER oturumlar kapanir, bu kalir', async () => {
  const { auth } = kur();
  await auth.setup({ username: 'admin', password: 'sifre-12345' });
  const a1 = await auth.login('admin', 'sifre-12345');
  const a2 = await auth.login('admin', 'sifre-12345');
  const kimlik1 = auth.authenticate(a1.token);

  await rejects(auth.changeOwnPassword(kimlik1, 'yanlis-eski', 'yeni-sifre-999'), 400, /Mevcut şifre/);
  await rejects(auth.changeOwnPassword(kimlik1, 'sifre-12345', 'kisa'), 400, /en az 8/);
  await auth.changeOwnPassword(kimlik1, 'sifre-12345', 'yeni-sifre-999');
  assert.ok(auth.authenticate(a1.token), 'degistiren oturum acik kalir');
  assert.equal(auth.authenticate(a2.token), null, 'diger oturum kapandi');
  await rejects(auth.login('admin', 'sifre-12345'), 401);
  assert.ok((await auth.login('admin', 'yeni-sifre-999')).token);
});

test('denetim kaydi: giris/cikis/hesap olaylari yazilir, sifre ASLA yazilmaz', async () => {
  const { auth } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'gizli-sifre-77' }, { ip: '127.0.0.1' });
  await auth.login('admin', 'yanlis-deneme-1', { ip: '10.0.0.5' }).catch(() => {});
  const { token } = await auth.login('admin', 'gizli-sifre-77', { ip: '10.0.0.5' });
  await auth.createUser({ username: 'izleyici', password: 'baska-sifre-55', role: 'viewer' }, { actor: admin, ip: '10.0.0.5' });
  auth.logout(token, { ip: '10.0.0.5' });
  const olaylar = auth.recentAudit(20);
  assert.deepEqual(olaylar.map((e) => e.event).reverse(), ['setup', 'login_fail', 'login_ok', 'user_created', 'logout']);
  const metin = JSON.stringify(olaylar);
  for (const gizli of ['gizli-sifre-77', 'yanlis-deneme-1', 'baska-sifre-55', 'scrypt$']) {
    assert.ok(!metin.includes(gizli), `${gizli} kayitta olmamali`);
  }
});

test('purge: suresi dolan oturumlar silinir, gecerliler kalir', async () => {
  const { auth, db, clock } = kur();
  const admin = await auth.setup({ username: 'admin', password: 'sifre-12345' });
  await auth.createUser({ username: 'izleyici', password: 'sifre-12345', role: 'viewer' }, { actor: admin });
  await auth.login('admin', 'sifre-12345');
  await auth.login('izleyici', 'sifre-12345');
  assert.equal(db.countSessions(), 2);
  clock.t += 13 * 3_600_000;
  assert.equal(auth.purge(), 1, 'yalniz admin oturumu (12 saati asti)');
  assert.equal(db.countSessions(), 1);
});

test('purge: eski basarisiz giris sayaclari bellekten atilir (cok adresten deneme bellegi sisirmez)', async () => {
  const { auth, clock } = kur();
  await auth.setup({ username: 'admin', password: 'sifre-12345' });
  for (let i = 0; i < 30; i += 1) await auth.login('admin', 'yanlis', { ip: `10.1.0.${i}` }).catch(() => {});
  assert.ok(auth.userFails.size >= 30 && auth.ipFails.size >= 30);
  clock.t += 16 * 60_000;
  auth.purge();
  assert.equal(auth.userFails.size, 0);
  assert.equal(auth.ipFails.size, 0);
});
