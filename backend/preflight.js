/**
 * Surum kontrolu - HER SEYDEN ONCE calismali.
 *
 * Backend `node:sqlite` kullaniyor; bu modul Node 22.5 ile geldi. Daha eski bir
 * surumde calistirilirsa Node'un kendi hatasi anlasilmaz oluyor
 * ("No such built-in module: node:sqlite"), insan da Node surumunu aramiyor.
 *
 * server.js bunu ILK import olarak alir: ES modulleri import sirasina gore
 * degerlendirildigi icin store.js -> db.js -> node:sqlite zinciri baslamadan
 * once burasi calisir ve okunur bir mesaj verir.
 */
const GEREKEN = [22, 5, 0];

function surum() {
  return process.versions.node.split('.').map((n) => parseInt(n, 10));
}

const [maj, min] = surum();
const [gMaj, gMin] = GEREKEN;

if (maj < gMaj || (maj === gMaj && min < gMin)) {
  console.error('');
  console.error('  Node surumu yetersiz.');
  console.error('');
  console.error(`    kurulu  : v${process.versions.node}`);
  console.error(`    gereken : v${GEREKEN.join('.')} ve uzeri`);
  console.error('');
  console.error('  Sebep: veritabani icin Node\'un gomulu `node:sqlite` modulu');
  console.error('  kullaniliyor, bu modul 22.5 ile geldi. Dis bagimlilik yok,');
  console.error('  bu yuzden `npm install` sorunu cozmez - Node guncellenmeli.');
  console.error('');
  console.error('  https://nodejs.org adresinden LTS surumu kur.');
  console.error('');
  process.exit(1);
}
