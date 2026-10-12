/**
 * Hesap kurtarma / yonetim araci: SUNUCU BILGISAYARINDA, komut satirindan (yonetici sifresi unutulursa).
 * Veritabanina dogrudan yazar (giris gerektirmez), bu yuzden yalniz sunucu bilgisayarina erisimi olan kisi kullanabilir.
 *
 *   node backend\auth-cli.js listele
 *   node backend\auth-cli.js sifre <kullanici>            yeni sifreyi sorar (yazarken gorunmez)
 *   node backend\auth-cli.js ekle <kullanici> <admin|viewer>   yeni hesap, sifreyi sorar
 *   node backend\auth-cli.js sil <kullanici>
 *
 * Calisma dizini kurulum klasoru olmali (data\auth.db oradan okunur) ya da AUTH_DB_FILE verilmeli.
 * Sifre terminal degilse (ornegin boru ile) standart girdiden TEK SATIR olarak okunur: betiklerde kullanilabilir.
 * Sifre degisince / hesap silinince o kullanicinin tum acik oturumlari kapanir.
 */
import { createInterface } from 'node:readline';
import './preflight.js';
import { AuthDb } from './auth/auth-db.js';
import { Auth, AuthError, ROLES } from './auth/auth.js';

const DB_FILE = process.env.AUTH_DB_FILE ?? 'data/auth.db';

function oku(soru) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin });
      let bitti = false;
      const sonuc = (deger) => { if (!bitti) { bitti = true; resolve(deger); } };
      // close olayi line'dan sonra da tetiklenir: ilk gelen kazanir (bos satirla ezilmesin).
      rl.once('line', (line) => { sonuc(line); rl.close(); });
      rl.once('close', () => sonuc(''));
      return;
    }
    process.stdout.write(soru);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let sifre = '';
    const bitir = (deger) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(deger);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return bitir(sifre);
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') sifre = sifre.slice(0, -1);
        else sifre += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function sifreIste() {
  const a = await oku('Yeni şifre (en az 8 karakter): ');
  if (!process.stdin.isTTY) return a;
  const b = await oku('Yeni şifre (tekrar): ');
  if (a !== b) throw new AuthError('İki şifre aynı değil.', 400);
  return a;
}

const [komut, ad, rol] = process.argv.slice(2);
const db = new AuthDb(DB_FILE);
const auth = new Auth({ db });

try {
  const bul = (isim) => {
    const u = db.listUsers().find((x) => x.username.toLowerCase() === String(isim ?? '').toLowerCase());
    if (!u) throw new AuthError(`Kullanıcı bulunamadı: ${isim}`, 404);
    return u;
  };

  if (komut === 'listele') {
    const users = db.listUsers();
    if (users.length === 0) console.log('Hesap yok (ilk yönetici hesabı dashboard\'dan, localhost üzerinden oluşturulur).');
    for (const u of users) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(8)} son giriş: ${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('tr-TR') : '—'}`);
  } else if (komut === 'sifre' && ad) {
    const u = bul(ad);
    await auth.setPassword(u.id, await sifreIste(), { actor: { username: 'auth-cli' } });
    console.log(`"${u.username}" şifresi değiştirildi; açık oturumları kapatıldı.`);
  } else if (komut === 'ekle' && ad && rol) {
    if (!ROLES.includes(rol)) throw new AuthError(`Rol "admin" ya da "viewer" olmalı.`, 400);
    const u = await auth.createUser({ username: ad, password: await sifreIste(), role: rol }, { actor: { username: 'auth-cli' } });
    console.log(`"${u.username}" (${u.role}) oluşturuldu.`);
  } else if (komut === 'sil' && ad) {
    const u = bul(ad);
    auth.deleteUser(u.id, { actor: { id: -1, username: 'auth-cli' } });
    console.log(`"${u.username}" silindi.`);
  } else {
    console.log('Kullanım:\n  node backend\\auth-cli.js listele\n  node backend\\auth-cli.js sifre <kullanici>\n  node backend\\auth-cli.js ekle <kullanici> <admin|viewer>\n  node backend\\auth-cli.js sil <kullanici>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`HATA: ${err.message}`);
  process.exitCode = err instanceof AuthError ? 1 : 3;
} finally {
  db.close();
}
