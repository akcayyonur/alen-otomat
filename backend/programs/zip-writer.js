/**
 * Minik, bagimliliksiz ZIP yazici (yalnizca yazma; okuma yok). `node:zlib`'in yerlesik
 * `deflateRawSync`/`crc32`'si disinda hicbir seye ihtiyaci yok - "sifir dis bagimlilik" kurali.
 *
 * Kutuphaneyi (bir tezgahin ya da ortak kutuphanenin tum programlarini) bir flash/USB'ye
 * tasinabilecek tek dosyaya paketlemek icin (`library.js` `exportZip`, uc `GET /api/library/export.zip`).
 * ZIP32 (store/deflate, tek disk) - bu kullanim icin yeterli: en fazla birkac yuz kucuk NC dosyasi.
 */
import { deflateRawSync, crc32 } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800; // dosya adi UTF-8 (Turkce karakterli musteri klasoru olabilir)

/** JS Date -> MS-DOS tarih/saat çifti (ZIP'in bekledigi bicim). 1980 oncesi -> 1980-01-01. */
function dosDateTime(date) {
  const d = date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const dosDate = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: dosDate };
}

/**
 * @param {{path: string, content: Buffer, mtime?: Date}[]} entries - `path` ileri-slash'li (ör. "MUSTERI/AD.NC"),
 *   kok dosya icin musteri yok.
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
    const content = entry.content;
    const crc = crc32(content) >>> 0; // crc32 imzali dondurebilir; ZIP alani imzasiz 32-bit
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const deflated = deflateRawSync(content);
    const store = deflated.length >= content.length; // kucuk/zaten sikisik icerikte buyumesin
    const method = store ? 0 : 8;
    const data = store ? content : deflated;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // versiyon gerekli (2.0 - deflate destegi)
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra uzunlugu
    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_SIG, 0);
    centralHeader.writeUInt16LE(20, 4); // "yazan" versiyon
    centralHeader.writeUInt16LE(20, 6); // gerekli versiyon
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // yorum
    centralHeader.writeUInt16LE(0, 34); // disk no
    centralHeader.writeUInt16LE(0, 36); // ic ozellikler
    centralHeader.writeUInt32LE(0, 38); // dis ozellikler
    centralHeader.writeUInt32LE(offset, 42); // yerel basligin konumu
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4); // disk no
  end.writeUInt16LE(0, 6); // merkezi dizinin bulundugu disk
  end.writeUInt16LE(entries.length, 8); // bu diskteki girdi sayisi
  end.writeUInt16LE(entries.length, 10); // toplam girdi sayisi
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16); // merkezi dizinin basladigi konum
  end.writeUInt16LE(0, 20); // yorum uzunlugu

  return Buffer.concat([...localParts, centralDir, end]);
}
