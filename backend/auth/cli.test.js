/**
 * Kurtarma araci (backend/auth-cli.js): sifre sifirlama, hesap ekleme/silme, hatali kullanim.
 * Gercek surec + gecici veritabani; sifre standart girdiden (boru) verilir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthDb } from './auth-db.js';
import { Auth } from './auth.js';
import { verifyPassword } from './password.js';

const KOK = fileURLToPath(new URL('../..', import.meta.url));
let dizin;
let dbDosyasi;

const cli = (args, girdi = '') => spawnSync(process.execPath, [join(KOK, 'backend', 'auth-cli.js'), ...args], {
  cwd: KOK, input: girdi, encoding: 'utf8', env: { ...process.env, AUTH_DB_FILE: dbDosyasi },
});

before(async () => {
  dizin = mkdtempSync(join(tmpdir(), 'cnc-auth-cli-'));
  dbDosyasi = join(dizin, 'auth.db');
  const db = new AuthDb(dbDosyasi);
  const auth = new Auth({ db });
  await auth.setup({ username: 'admin', password: 'eski-sifre-123' });
  db.close();
});
after(() => { try { rmSync(dizin, { recursive: true, force: true }); } catch { /* kilitli olabilir */ } });

test('listele: hesaplari gosterir, sifre ozeti gostermez', () => {
  const r = cli(['listele']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /admin\s+admin/);
  assert.ok(!r.stdout.includes('scrypt'));
});

test('sifre: unutulan yonetici sifresi sifirlanir, eski sifre gecmez, acik oturumlar kapanir', async () => {
  const db = new AuthDb(dbDosyasi);
  const auth = new Auth({ db });
  const { token } = await auth.login('admin', 'eski-sifre-123');
  assert.ok(auth.authenticate(token));
  db.close();

  const r = cli(['sifre', 'admin'], 'yeni-sifre-4567\n');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /şifresi değiştirildi/);

  const db2 = new AuthDb(dbDosyasi);
  const a2 = new Auth({ db: db2 });
  assert.equal(a2.authenticate(token), null, 'acik oturum kapandi');
  assert.equal(await verifyPassword('eski-sifre-123', db2.getUserWithHash('admin').passwordHash), false);
  assert.equal(await verifyPassword('yeni-sifre-4567', db2.getUserWithHash('admin').passwordHash), true);
  db2.close();
});

test('ekle / sil: izleyici hesabi acilir ve silinir; kisa sifre ve gecersiz rol reddedilir', () => {
  const kisa = cli(['ekle', 'izleyici', 'viewer'], 'kisa\n');
  assert.equal(kisa.status, 1);
  assert.match(kisa.stderr, /en az 8/);
  const rol = cli(['ekle', 'izleyici', 'root'], 'uzun-sifre-123\n');
  assert.equal(rol.status, 1);
  assert.match(rol.stderr, /admin", "viewer" ya da "operator/);

  const ok = cli(['ekle', 'izleyici', 'viewer'], 'uzun-sifre-123\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(cli(['listele']).stdout, /izleyici\s+viewer/);

  assert.equal(cli(['sil', 'izleyici']).status, 0);
  assert.doesNotMatch(cli(['listele']).stdout, /izleyici/);
  const yok = cli(['sil', 'olmayan']);
  assert.equal(yok.status, 1);
  assert.match(yok.stderr, /bulunamadı/);
});

test('son yonetici silinemez; hatali kullanimda yardim metni ve kod 2', () => {
  const son = cli(['sil', 'admin']);
  assert.equal(son.status, 1);
  assert.match(son.stderr, /Son yönetici/);
  const yardim = cli([]);
  assert.equal(yardim.status, 2);
  assert.match(yardim.stdout, /Kullanım/);
});
