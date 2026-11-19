/**
 * PDF içindeki SİPARİŞ TABLOSUNU satır+sütun olarak çıkarır (`pdf-text.js`'in verdiği, konumlu ama
 * sütunsuz SATIRLAR üzerine; bkz. §6 "Mail'den otomatik sipariş girişi"). Sütun sınırları belirli bir
 * müşteriye göre SABİT KODLANMAZ — sayfadaki BAŞLIK satırından (bilinen anahtar kelimelerle) çıkarılır;
 * böylece yeni bir müşteri geldiğinde (aynı genel düzende bir tablo olduğu sürece) kod değişikliği
 * GEREKMEZ. Gerçek Siamp (tek satırlı, temiz) ve Konveyör (11 satır, çok sayfalı) örnekleriyle doğrulandı.
 *
 * BİLEREK YAPILMAYAN: çıkarılan satırlar MÜKEMMEL değildir (ör. bir hücre birden çok satıra sarmışsa ya
 * da aynı Y'ye denk gelen iki ayrı alt-satır birleşmişse karışabilir) — bu modül "makul bir TASLAK" verir,
 * kesinlik iddia etmez; yanlış çıkan alanlar onay ekranından elle düzeltilir (projenin "öneri, hiçbir zaman
 * kendiliğinden uygulanmaz" ilkesi burada da geçerli).
 */
import { foldTr } from './normalize.js';
import { groupRunsIntoLines } from './pdf-text.js';

/** Alan adı -> anahtar kelimeler (foldTr + boşluksuz karşılaştırılır). `strong`: başlık bandını TESPİT eder; zayıf olanlar yalnız bant içinde sütun etiketler. */
const HEADER_KEYWORDS = [
  // NUMARASIMALZEME: iki satira yayilmis "Malzeme" (ust) + "Numarasi" (alt) basligi tek hucrede ters sirayla birlesiyor
  // (gercek Konveyor/SAP siparis formu, 2026-11-18).
  { field: 'code', strong: true, keys: ['URUNKODU', 'MALZEMEKODU', 'MALZEMENUMARASI', 'NUMARASIMALZEME'] },
  { field: 'description', strong: true, keys: ['URUNADI', 'TANIM', 'MALZEMEACIKLAMASI', 'ACIKLAMA'] },
  { field: 'qty', strong: true, keys: ['MIKTAR', 'SIPARISMIKTARI', 'KALANMIKTAR'] },
  // GIRISTARIHI (2026-11-18, gerçek HAVANA/SAS0003812 belgesi): bu belgede "Beklenen" bir ÜST alt-başlık
  // satırında ayrı duruyor, "Giriş Tarihi" ana başlık satırında TEK BAŞINA — BEKLENENGIRISTARIHI hiç
  // eşleşmiyordu (iki ayrı hücre asla birleşmiyor), kendi anahtarı gerekti.
  { field: 'deliveryDate', strong: true, keys: ['TESLIMTARIHI', 'TESLIMATTARIHI', 'BEKLENENGIRISTARIHI', 'GIRISTARIHI'] },
  { field: 'custOrderNo', strong: true, keys: ['SIPARISNUMARASI', 'SIPARISNO', 'EBANUMARASI'] },
  // FIYAT (Siamp "BR FİYATI"/"TOP. FİYATI") ve TUTAR (Konveyör "Tutar"/"Net Tutar") AYNI alana ("price") duser:
  // iki ayri sutun (birim fiyat + satir toplami) olsa bile sadece SOLDAKİ (en kucuk x) kayit edilir, digeri bu
  // alanin siniri icinde kalip veri hucresinde art arda GELIR ("0,5400 2.700,00" gibi) - extractPriceToken
  // (incoming-orders.js) ilk virgullu sayiyi alip digerini atar, bu yuzden AYRI bir "lineTotal" alani GEREKMEDI.
  // SIRA KRITIK: bu alan 'deliveryDate'den SONRA gelmeli — gercek HAVANA/SAS0003812 belgesinde "Tutar" ve
  // "Giriş Tarihi" basliklari TEK hucrede birlesiyor ("TutarGirişTarihi"), 'TUTAR' erken kontrol edilirse
  // deliveryDate'in kendi anahtari ('GIRISTARIHI') hic denenmeden bu alan kazanirdi (gercek testle bulunup
  // bu siralamayla onlendi, 2026-11-18).
  { field: 'price', strong: true, keys: ['FIYAT', 'TUTAR'] },
  // "No" genelde SATIR NUMARASIDIR (1, 2, 3...), urun kodu degil (gercek Konveyor formu). Baska bir kod sutunu YOKSA
  // eski davranis korunur: lineNo -> code (bkz. extractOrderTable).
  { field: 'lineNo', strong: false, keys: ['NO'] },
  { field: 'unit', strong: false, keys: ['BR', 'BIRIM', 'OLCUBIRIMI'] },
  { field: 'currency', strong: false, keys: ['PBR', 'PARABIRIMI'] },
];

const FOOTER_SIGNS = ['TOPLAMTUTAR', 'TOPLAMFIYAT', 'KDV', 'NETTUTAR', 'ONEMLINOT', 'ONAYLAR', 'ODEMEKOSUL', 'TESLIMSART'];

const fold = (s) => foldTr(String(s ?? '')).replace(/\s+/g, '');

/**
 * Bazı PDF üreticileri (ör. "PDF olarak yazdır" ile çıkan bir satınalma belgesi — gerçek HAVANA/SAS0003812
 * örneği, 2026-11-18'de bulundu) HER HARFİ ayrı bir metin gösterme komutuyla yazıyor: `groupRunsIntoLines`
 * bu durumda satır başına onlarca TEK HARFLİK hücre döndürür ("S","a","t","ı","n"...), başlık anahtar
 * kelimesi hiçbir pencerede (`MAX_HEADER_WINDOW`, en çok 3 hücre) bulunamaz — `extractOrderTable` hiç tablo
 * bulamaz (gerçek dosyada doğrulandı: 0 satır). Komşu hücreler arasındaki X boşluğu GERÇEK dosyada ÖLÇÜLDÜ:
 * aynı sözcük/alan İÇİ boşluk hep ≤ ~19pt (ara sıra bir sayı grubu sonrası ~12-19pt'e çıkabiliyor), SÜTUNLAR
 * ARASI boşluk hep ≥ ~29pt (çoğu 60-180pt) — net bir ayrım var, `CELL_BREAK_PT` bu ikisinin ortasından seçildi.
 * Komşu hücreler bu eşiğin ALTINDAKİ boşlukla TEK bir "kelime/alan" hücresinde birleştirilir.
 *
 * Zaten SÖZCÜK/ETİKET düzeyinde gelen normal PDF'lerde (Siamp/Konveyör, mevcut testler) gerçek sözcükler/
 * sütun etiketleri arası boşluk bundan HER ZAMAN büyüktür (ayrı tablo sütunları) — bu yüzden birleştirme
 * onlar için pratikte bir NO-OP'tur (testlerle doğrulandı, davranış değişmedi). Font genişlik tablosu
 * olmadan bu YİNE DE kusursuz sözcük ayrımı DEĞİLDİR (bkz. `pdf-text.js` dosya başı) — ama anahtar kelime
 * araması zaten ALT DİZGE eşleştirdiği için (bir kelimenin fazladan metinle birleşmesi zararsızdır) ve veri
 * satırı kurma da artık hücre başına gereksiz boşluk eklemediği için (bkz. aşağıdaki kullanım yeri) pratikte
 * yeterlidir; kusurlu çıkan alanlar zaten onay ekranından elle düzeltilir (projenin "taslak, kesinlik iddia
 * etmez" ilkesi).
 */
const CELL_BREAK_PT = 24;

export function mergeCharacterCells(cells) {
  if (cells.length < 2) return cells;
  const out = [{ ...cells[0] }];
  let lastX = cells[0].x; // ONCEKİ GİRDİ hücresinin x'i (birleşen hücrenin İLK üyesininki DEĞİL — aksi halde boşluk
  // birikir ve gerçek bir kelime, aralarında hiçbir büyük boşluk olmadığı halde birkaç karakterde bir KOPARDI;
  // gerçek HAVANA PDF'inde bulunup düzeltildi: "HAVANA" "HAVA"+"NASA"+"NAYİ" diye üçe bölünüyordu).
  for (let i = 1; i < cells.length; i += 1) {
    const gap = cells[i].x - lastX; // onceki hucrenin genisligi bilinmiyor (font metrigi yok) - ardisik baslangic noktalari arasi fark, kaba ama CELL_BREAK_PT'yi secmeye yetecek kadar net bir ayrim veriyor
    if (gap <= CELL_BREAK_PT) out[out.length - 1].text += cells[i].text;
    else out.push({ ...cells[i] });
    lastX = cells[i].x;
  }
  return out;
}

// En uzun gercek anahtar kelime 3 sozcuk ("Beklenen Giris Tarihi"): pencere bunu asmaz.
const MAX_HEADER_WINDOW = 3;

/**
 * Bir satırın (cells) hangi alan anahtar kelimelerini içerdiğini bulur. Tek hücre yeterlidir (dijital PDF'te
 * çoğu zaman tüm etiket tek `Tj`'dir) — AMA Tesseract OCR kelime KUTULARI verir, "ÜRÜN KODU" gibi bir başlık
 * OCR'da "ÜRÜN" ve "KODU" diye AYRI hücrelere bölünür (bkz. `pdf-text.js` dosya başı "sözcük ayrımı" notu;
 * gerçek taranmış Ayvaz PDF'inde bulundu).
 *
 * Satır SOLDAN SAĞA, AÇGÖZLÜ ve ÇAKIŞMASIZ taranır: her konumda ÖNCE tek hücre (genişlik 1 — TÜM anahtar
 * kelimeler, zayıf dahil, ESKİ davranışla BİREBİR) denenir; eşleşmezse genişlik 2, sonra 3 (yalnız GÜÇLÜ
 * anahtar kelimeler) denenir. Bir eşleşme bulununca o kadar hücre TÜKETİLİR (bir sonraki arama bunların
 * SONRASINDAN devam eder) — İLK BULUNAN (en KISA) eşleşme alınır, en UZUN değil. **Bu sıra ve tüketim
 * kritik:** "en uzun pencere önce" ya da "tüketmeden ilerle" denendiğinde, tam eşleşen bir hücrenin bitişiğindeki
 * BAŞKA bir tam eşleşmenin kuyruk harfleri kazayla bir sonraki/önceki anahtar kelimeyle ÇAKIŞIYORDU (ör. tek
 * hücrelik "ÜRÜN KODU" + bitişik "ÜRÜN ADI" birleşince "URUNKODU**URUNADI**" oluşuyor ve bu da 'description'
 * anahtar kelimesini YANLIŞ x'te (ilk hücrenin x'i) eşlerdi) — gerçek testle bulunup düzeltildi.
 *
 * Genişlik ≥2 pencerede yalnız GÜÇLÜ (strong) anahtar kelimeler aranır: zayıf olanlar ("NO", "BR", "PBR") tek
 * başına genişlik-1'de zaten denendiği için bir daha aranmaz — iki hücrenin tesadüfi bitişiminde kısa bir alt
 * dizge ("BR" gibi) oluşsa bile YANLIŞLIKLA eşleşmez (testle doğrulandı).
 * @returns {{field:string,x:number,strong:boolean}[]}
 */
function matchesInLine(line) {
  const out = [];
  const { cells } = line;
  let i = 0;
  while (i < cells.length) {
    const maxW = Math.min(MAX_HEADER_WINDOW, cells.length - i);
    let found = null;
    for (let w = 1; w <= maxW && !found; w += 1) {
      const joined = fold(cells.slice(i, i + w).map((c) => c.text).join(''));
      if (joined === '') continue;
      const candidates = w === 1 ? HEADER_KEYWORDS : HEADER_KEYWORDS.filter((h) => h.strong);
      for (const h of candidates) {
        if (!h.keys.some((k) => joined.includes(k))) continue;
        // Pencere (w>=2) eslesmesi, anahtar kelime GERCEKTEN birden cok hucreye yayiliyorsa gecerlidir. Daha dar bir
        // alt-pencere (ilk w-1 ya da son w-1 hucre) zaten iceriyorsa, bu ilk hucrenin x'ine YANLIS oturur
        // (gercek Konveyor: "Pyp Ogesi"+"Miktar" -> MIKTAR, Pyp Ogesi'nin x'inde bulunuyordu); alt-pencere kendi konumunda bulunur.
        if (w > 1) {
          const sub = (a, b) => fold(cells.slice(i + a, i + b).map((c) => c.text).join(''));
          if (h.keys.some((k) => sub(0, w - 1).includes(k) || sub(1, w).includes(k))) continue;
        }
        found = { field: h.field, strong: h.strong, width: w };
        break;
      }
    }
    if (found) { out.push({ field: found.field, x: cells[i].x, strong: found.strong }); i += found.width; }
    else i += 1;
  }
  return out;
}

/** Bir sipariş adedi gibi görünen metin mi ("280", "2.000", "5.000,00")? */
const QTY_RE = /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$|^\d+(?:[.,]\d+)?$/;
const DATE_RE = /\d{1,2}[./]\d{1,2}[./]\d{4}/;
/** Bir kalemin en uzak satırı, çapa (veri) satırından en fazla bu kadar pt uzakta olabilir. */
const MAX_MERGE_DY = 40;
/** Son çapanın altındaki satırlar arasında bundan büyük boşluk = sonraki kalemin (sayfa sonunda yarım kalan) satırları. */
const TRAIL_BREAK_PT = 20;

/**
 * Bazı formlar (SAP tarzı, gerçek Konveyör) BİR kalemi alt alta birkaç satıra yayar: üstte açıklama + malzeme no,
 * ortada asıl VERİ satırı (satır no, adet, birim, tarih, fiyat), altta açıklama devamı. Her satırı ayrı kalem saymak
 * kalem sayısını katlar ve adet/tarihi koddan koparır. Burada "çapa" satırı (adet ya da teslim tarihi okunan satır)
 * bulunur; çapa olmayan satırlar DİKEY olarak en yakın çapaya eklenir (alan alan, yukarıdan aşağıya birleştirilir).
 * Hiç çapa yoksa ya da satır çapaya MAX_MERGE_DY'den uzaksa satır AYNEN bırakılır (eski davranış).
 * @param {{y:number,row:Record<string,string>}[]} items yukarıdan aşağıya (y azalan) sıralı
 * @returns {{rows: Record<string,string>[], carry: (Record<string,string>|null)}}
 */
export function mergeMultiLineRows(items) {
  const isAnchor = ({ row }) => QTY_RE.test(String(row.qty ?? '').trim()) || DATE_RE.test(String(row.deliveryDate ?? ''));
  const anchors = items.filter(isAnchor);
  if (anchors.length === 0) return { rows: items.map((i) => i.row), carry: null };
  const groups = new Map(anchors.map((a) => [a, [a]]));
  const orphans = [];
  const give = (anchor, it) => { if (Math.abs(anchor.y - it.y) <= MAX_MERGE_DY) groups.get(anchor).push(it); else orphans.push(it); };
  const idx = anchors.map((a) => items.indexOf(a));
  // ilk capanin USTUNDEKI satirlar ilk capaya, son capanin ALTINDAKILER son capaya
  for (let i = 0; i < idx[0]; i += 1) give(anchors[0], items[i]);
  // son capanin ALTINDAKILER: capanin hemen altindaki (kucuk bosluklu) satirlar son capaya; ilk BUYUK bosluktan (TRAIL_BREAK_PT)
  // sonrasi SAYFA SONUNDA yarim kalmis bir SONRAKI kalemin ust satirlaridir (gercek Konveyor: 3. kalemin aciklama+kod
  // satirlari 1. sayfada, veri satiri 2. sayfada) -> `carry` olarak dondurulur, sonraki sayfanin ilk satirina eklenir.
  const lastAnchor = anchors[anchors.length - 1];
  const carryItems = [];
  let prev = lastAnchor;
  for (let i = idx[idx.length - 1] + 1; i < items.length; i += 1) {
    const it = items[i];
    if (carryItems.length === 0 && prev.y - it.y <= TRAIL_BREAK_PT) give(lastAnchor, it);
    else carryItems.push(it);
    prev = it;
  }
  // iki capa ARASINDAKI satirlar: aralarindaki EN BUYUK dikey bosluktan bolunur (ust parca ustteki capaya, alt parca alttakine).
  // Kalemler esit aralikli olmadigindan (gercek Konveyor: 3-30pt) "en yakin capa" yanlis atar; blok ARASI bosluk her zaman en buyuktur.
  for (let k = 0; k + 1 < anchors.length; k += 1) {
    const between = items.slice(idx[k] + 1, idx[k + 1]);
    if (between.length === 0) continue;
    const seq = [anchors[k], ...between, anchors[k + 1]];
    let cut = 1;
    let widest = -1;
    for (let g = 1; g < seq.length; g += 1) {
      const gap = seq[g - 1].y - seq[g].y;
      if (gap > widest) { widest = gap; cut = g; }
    }
    between.forEach((it, i) => give(i + 1 < cut ? anchors[k] : anchors[k + 1], it));
  }
  const merged = [];
  for (const [anchor, members] of groups) {
    members.sort((p, q) => q.y - p.y); // yukaridan asagiya
    const row = {};
    for (const m of members) for (const [k, v] of Object.entries(m.row)) row[k] = row[k] ? `${row[k]} ${v}` : v;
    merged.push({ y: anchor.y, row });
  }
  const rows = [...merged, ...orphans].sort((p, q) => q.y - p.y).map((i) => i.row);
  let carry = null;
  if (carryItems.length) {
    carry = {};
    for (const m of carryItems) for (const [k, v] of Object.entries(m.row)) carry[k] = carry[k] ? `${carry[k]} ${v}` : v;
  }
  return { rows, carry };
}

/**
 * Konumlu metin parçalarından (bkz. `pdf-text.js#extractPdfText`) sipariş tablosunu çıkarır.
 * @param {{x:number,y:number,size:number,text:(string|null)}[]} runs
 * @returns {{headerFields: Record<string,number>, rows: Record<string,string>[]} | null} tablo bulunamazsa `null`
 */
export function extractOrderTable(runs) {
  const lines = groupRunsIntoLines(runs).map((l) => ({ ...l, cells: mergeCharacterCells(l.cells) }));
  // 1) basliga en yakin ardisik satirlardan "bant" olustur (en az bir STRONG eslesme + sonraki/onceki satir(lar) da esleserse genisler)
  const lineMatches = lines.map((l) => matchesInLine(l));
  let bestBand = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lineMatches[i].some((m) => m.strong)) continue;
    let j = i;
    while (j + 1 < lines.length && lineMatches[j + 1].length > 0 && lines[j].y - lines[j + 1].y < 15) j += 1;
    const fields = new Set();
    for (let k = i; k <= j; k += 1) for (const m of lineMatches[k]) if (m.strong) fields.add(m.field);
    if (!bestBand || fields.size > bestBand.fields.size) bestBand = { start: i, end: j, fields };
  }
  if (!bestBand) return null;

  // 2) bant icindeki TUM eslesmelerden (zayif dahil) alan -> en kucuk x (sutun sol kenari)
  const colX = new Map();
  for (let k = bestBand.start; k <= bestBand.end; k += 1) {
    for (const m of lineMatches[k]) {
      if (!colX.has(m.field) || m.x < colX.get(m.field)) colX.set(m.field, m.x);
    }
  }
  // Ayri bir kod sutunu bulunamadiysa "No" sutunu eskisi gibi kod sayilir.
  if (!colX.has('code') && colX.has('lineNo')) { colX.set('code', colX.get('lineNo')); colX.delete('lineNo'); }
  const cols = [...colX.entries()].sort((a, b) => a[1] - b[1]); // [[field, x], ...] soldan saga
  const headerFields = Object.fromEntries(cols);
  // sutun SINIRI = ardisik baslik x'lerinin ORTA NOKTASI: veri hucresi, baslik metninin tam hizasindan
  // (farkli hizalama/dolgu yuzunden) biraz kaymis olsa bile en yakin sutuna dogru atanir (gercek Siamp
  // orneginde "ÜRÜN ADI" veri hucresinin, kendi baslik x'inden biraz SOLDA basladigi bulundu).
  const bounds = cols.map(([field], i) => ({ field, lo: i === 0 ? -Infinity : (cols[i - 1][1] + cols[i][1]) / 2 }));

  // 3) veri satirlari: bantin ALTINDA (Y kucuk), bir "altbilgi" isaretine kadar
  const items = [];
  for (let i = bestBand.end + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const flat = fold(line.cells.map((c) => c.text).join(''));
    if (FOOTER_SIGNS.some((s) => flat.includes(s))) break;
    if (line.cells.length === 0) continue;
    const row = {};
    for (const cell of line.cells) {
      let field = bounds[0].field;
      for (const b of bounds) if (b.lo <= cell.x) field = b.field; else break;
      row[field] = row[field] ? `${row[field]} ${cell.text}` : cell.text;
    }
    items.push({ y: line.y, row });
  }
  // 4) birden cok satira yayilan kalemleri veri (capa) satirinda birlestir
  const { rows, carry } = mergeMultiLineRows(items);
  return { headerFields, rows, carry };
}

// Belgenin KENDI sipariş numarası (tablo İÇİNDEKİ her satırda tekrar eden bir sütun DEĞİL — sayfanın üst
// METADATA bloğunda BİR KEZ yazılan müşteri PO numarası). Yalnız GERÇEK Konveyör/SAP sipariş formunda
// görülen etiket (2026-11-19, gerçek `4100018539.PDF`: "Satınalma Siparişi / Eba Numarası" sütun başlığı,
// altındaki satırda değeri) — TANINMAYAN bir belgede bu etiket hiç aranmaz/bulunmaz, null döner.
const DOC_ORDER_NO_KEYWORDS = ['SATINALMASIPARISI', 'EBANUMARASI'];

/**
 * `extractOrderTable`'ın aksine SAYFANIN TÜM satırlarına bakar (ürün tablosuyla sınırlı değil — bu etiket
 * tablonun ÜSTÜNDE, sayfa başlığı civarında). Etiket satırı bulununca SONRAKİ birkaç satırda "6+ rakamla
 * başlayan" İLK hücre PO numarası sayılır: aynı satırda görülen tarih (`11.11.2026`, noktalarla bölündüğü
 * için hiçbir parçası 6 rakama ulaşmaz) ve revizyon no (`01`, 1-2 hane) biçimce doğal olarak elenir — ayrıca
 * bir sütun hizalaması GEREKMEDİ (gerçek belgede doğrulandı).
 * @param {{x:number,y:number,size:number,text:(string|null)}[]} runs
 * @returns {string|null}
 */
export function extractDocOrderNo(runs) {
  const lines = groupRunsIntoLines(runs).map((l) => ({ ...l, cells: mergeCharacterCells(l.cells) }));
  const labelIdx = lines.findIndex((l) => {
    const flat = fold(l.cells.map((c) => c.text).join(''));
    return DOC_ORDER_NO_KEYWORDS.some((k) => flat.includes(k));
  });
  if (labelIdx === -1) return null;
  const valueLines = lines.slice(labelIdx + 1, Math.min(lines.length, labelIdx + 5));
  for (const line of valueLines) {
    for (const cell of line.cells) {
      // `mergeCharacterCells` komsu degerleri (tarih + PO no) BOSLUKSUZ TEK hucrede birlestirebiliyor
      // (gercek belgede oldugu gibi, "11.11.20264100018539 / 01" - tarih hucresi `gg.aa.yyyy` sabit
      // uzunlukta oldugu icin TAM OLARAK onun ARDINDAN gelen rakamlar PO no'dur; `\d{4}` (yil) SABIT
      // uzunlukta oldugundan asiri acgozlu eslesip PO no'nun basindan rakam calmaz).
      const afterDate = /\d{2}\.\d{2}\.\d{4}(\d{6,})/.exec(String(cell.text ?? ''));
      if (afterDate) return afterDate[1];
    }
  }
  for (const line of valueLines) {
    for (const cell of line.cells) {
      // tarihle hic fuzyon olmamissa (ayri hucre): herhangi bir yerde 6+ ardisik rakam yeterli - tarihin
      // kendisi noktalarla boldugu icin hic 6 rakama ulasamaz, yanlislikla eslesme riski yok.
      const m = /(\d{6,})/.exec(String(cell.text ?? ''));
      if (m) return m[1];
    }
  }
  return null;
}
