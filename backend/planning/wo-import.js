/**
 * Eski (Excel) is emri sisteminden BIR KEZLIK gecis: "PLANLANAN" sayfasinin (is emirleri listesi) HER SATIRI gercek
 * bir `work_orders` kaydina doner. `importIsEmri` (importers.js) ayni sayfayi zaten okuyor ama yalniz URUN
 * KARTLARINI gunceller (stok kodu basina EN SON satir) - satir basina IS EMRI YARATMAZ; bu farkli bir ihtiyac,
 * onun icin ayri bir fonksiyon. Urun kartlari icin once importParsed(db, parsed, 'isemri', ...) ayrica calistirilmali
 * (ayni dosya, degisiklik yok) - bu fonksiyon urun kartini VARSAYAR, kendisi olusturmaz.
 *
 * Durum, satirin rengine gore belirlenir (kullanici karari, 2026-10-28): yesil (92D050) -> bitti, kirmizi (FF0000)
 * -> iptal, baska her sey (sari/renksiz) -> planlandi. "Bitti" satirlarda ADET hem hedef hem SONUC sayilir (eski
 * sistemde gercek uretilen adet forma elle yaziliyordu, bu dosyada ayri bir "gerceklesen" sutunu yok; kullanici onayi
 * - sistem gecisinden sonra hedef/gerceklesen yine makineden akacak).
 *
 * Tezgah ATANMAZ (MAKINA NO sutunu "CNC"/"BCNC" gibi genel kategori, belirli bir tezgah degil; urun sisteminde
 * tezgah secmeden is emri desteklenir). IDEMPOTENT: ayni ÜRETİM EMRİ NO zaten varsa satir ATLANIR (iki kez
 * calistirmak guvenli, yeni satir eklenmez / var olan degistirilmez).
 */
import { headerKey, foldTr, parseDate, parseNumber } from './normalize.js';

const idxOf = (headers) => new Map(headers.map((h, i) => [headerKey(h), i]));
const cellAt = (idx, row, key) => (idx.has(key) ? String(row[idx.get(key)] ?? '').trim() : '');
const positive = (n) => (n != null && n > 0 ? n : null);

/** Excel'de olculen gercek dolgu renkleri (xlsx-read.js rowFills, "RRGGBB"). */
const GREEN = '92D050'; // bitti
const RED = 'FF0000'; // iptal
// baska her renk (sari FFFF00 dahil) ve renksiz -> planlandi

/**
 * @param {import('./planning-db.js').PlanningDb} db
 * @param {{headers: string[], rows: string[][], rowFills: (string|null)[]}} parsed PLANLANAN sayfasi (xlsx-read.js readXlsx sheet)
 * @param {{by?: string|null, now?: number}} [ctx]
 * @returns {{totalRows: number, skipped: number, added: number, existing: number, byStatus: {bitti: number, planlandi: number, iptal: number}, warnings: string[]}}
 */
export function importHistoricalWorkOrders(db, parsed, { by = null, now = Date.now() } = {}) {
  const idx = idxOf(parsed.headers);
  const result = { totalRows: 0, skipped: 0, added: 0, existing: 0, byStatus: { bitti: 0, planlandi: 0, iptal: 0 }, warnings: [] };
  const floors = new Map();

  db.tx(() => {
    parsed.rows.forEach((row, i) => {
      const stock = cellAt(idx, row, 'ALENKOD');
      if (stock === '') { result.skipped += 1; return; } // ör. uzak bos satirdaki unutulmus "." (bilinen, zararsiz)

      const noDigits = cellAt(idx, row, 'URETIMEMRINO').replace(/\D/g, '');
      if (noDigits.length !== 10) {
        result.skipped += 1;
        result.warnings.push(`${stock}: iş emri no geçersiz ("${cellAt(idx, row, 'URETIMEMRINO')}"), atlandı.`);
        return;
      }
      const year = Number(noDigits.slice(0, 4));
      const seq = Number(noDigits.slice(4));
      const no = noDigits;
      result.totalRows += 1;
      if (db.getWorkOrder(no)) { result.existing += 1; return; } // idempotent: ikinci kosuda dokunulmaz

      const targetQty = Math.round(parseNumber(cellAt(idx, row, 'ADET')) ?? 0);
      if (!(targetQty > 0)) {
        result.skipped += 1;
        result.warnings.push(`${no}: ADET geçersiz/boş, atlandı.`);
        return;
      }

      const fill = (parsed.rowFills[i] ?? '').toUpperCase();
      const status = fill === GREEN ? 'bitti' : fill === RED ? 'iptal' : 'planlandi';
      const orderDate = parseDate(cellAt(idx, row, 'TARIH'));
      const dueDate = parseDate(cellAt(idx, row, 'TERMINTARIHI'));
      const alt = cellAt(idx, row, 'ALTERNATIFHM');
      const plannedSec = positive(parseNumber(cellAt(idx, row, 'URETIMSN')));

      db.insertWorkOrder({
        no, year, seq, machineId: null, codeKey: foldTr(stock), stockCode: stock, targetQty, dueDate,
        productName: cellAt(idx, row, 'MAMULADI') || null, customerCode: cellAt(idx, row, 'MUSTERIKODU') || null,
        material: cellAt(idx, row, 'HAMMADDE') || null, altMaterial: alt === '' || alt === '0' ? null : alt,
        netKg: positive(parseNumber(cellAt(idx, row, 'NETGR'))), grossKg: positive(parseNumber(cellAt(idx, row, 'BRUTGR'))),
        plannedSec, gkkReportNo: cellAt(idx, row, 'GKKRAPORNO') || null, firstApprovalNo: cellAt(idx, row, 'ILKRAPORNO') || null,
        now, by,
      });
      db.addWorkOrderEvent(no, 'olusturuldu', `${stock} · ${targetQty} adet · eski sistemden içeri aktarıldı`, { by, now });

      if (status === 'bitti') {
        const startedAt = orderDate ?? now;
        const finishedAt = Math.max(dueDate ?? startedAt, startedAt);
        // Dondurulmus sonuc: gercek telemetri YOK (eski sistemde elle), bu yuzden computeProgress() CAGRILMAZ - dogrudan
        // kurulur. produced=targetQty kullanici karari ("ADET = SONUÇ"); vardiya/program kirilimi bilinmiyor (bos).
        const resultJson = {
          from: startedAt, to: finishedAt, open: false, produced: targetQty, approxQty: 0, suspectEvents: 0, suspectQty: 0,
          firstTs: null, lastTs: null, shifts: [], cycle: { plannedSec, measuredAvgSec: null, measuredN: 0, intervalSec: null },
          sample: null, programs: [], warnings: [],
        };
        db.updateWorkOrder(no, {
          status: 'bitti', started_at: startedAt, started_by: by, started_person: null, start_total: null,
          finished_at: finishedAt, finished_by: by, finished_person: null, finish_total: null, result_json: JSON.stringify(resultJson),
        }, { by, now });
        db.addWorkOrderEvent(no, 'bitirildi', `${targetQty} adet · eski sistemden (hedef = sonuç)`, { by, now });
        result.byStatus.bitti += 1;
      } else if (status === 'iptal') {
        db.updateWorkOrder(no, { status: 'iptal', cancelled_at: now, cancel_reason: 'Eski sistemden içeri aktarıldı (iptal)' }, { by, now });
        db.addWorkOrderEvent(no, 'iptal', 'Eski sistemden içeri aktarıldı (iptal)', { by, now });
        result.byStatus.iptal += 1;
      } else {
        result.byStatus.planlandi += 1;
      }
      result.added += 1;
      floors.set(year, Math.max(floors.get(year) ?? 0, seq));
    });
    for (const [y, s] of floors) db.raiseSeqFloor(y, s);
  });
  return result;
}
