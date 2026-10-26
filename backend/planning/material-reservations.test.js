/**
 * Hammadde rezervasyonu (planlama F asamasi): saf hesaplar — rezerve kg, depo stogu + acik rezervasyonlar -> serbest kg. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeStockByMaterial, reservedKgOf, RESERVATION_STATUS } from './material-reservations.js';

test('reservedKgOf: hedef adet x brut gramaj, 3 ondalige yuvarlanir', () => {
  assert.equal(reservedKgOf(100, 0.039), 3.9);
  assert.equal(reservedKgOf(7, 0.0392), 0.274);
});

test('RESERVATION_STATUS: durum degerleri', () => {
  assert.deepEqual(RESERVATION_STATUS, { OPEN: 'ayrildi', RESOLVED: 'tuketildi', RELEASED: 'serbest-birakildi' });
});

test('serbest stok: rezervasyon yokken serbest = stok', () => {
  const r = freeStockByMaterial([{ materialKey: 'HM614.YU23.00', name: 'Pirinç çubuk', stockKg: 200 }], []);
  assert.deepEqual(r, [{ materialKey: 'HM614.YU23.00', name: 'Pirinç çubuk', stockKg: 200, reservedKg: 0, unenteredKg: 0, freeKg: 200 }]);
});

test('serbest stok: acik (ayrildi) ve Mikro\'ya girilmemis (tuketildi) rezervasyonlar ikisi de duser', () => {
  const stock = [{ materialKey: 'HM614.YU23.00', name: 'Pirinç çubuk', stockKg: 200 }];
  const res = [{ materialKey: 'HM614.YU23.00', reservedKg: 50, unenteredKg: 30 }];
  const r = freeStockByMaterial(stock, res);
  assert.equal(r[0].freeKg, 120, '200 - 50 (ayrildi) - 30 (tuketildi, fis girilmemis)');
});

test('serbest stok: material_stock satiri yoksa (eslesmedi) freeKg null, rezervasyon yine de listelenir', () => {
  const r = freeStockByMaterial([], [{ materialKey: 'HM-BILINMEYEN', reservedKg: 10, unenteredKg: 0 }]);
  assert.deepEqual(r, [{ materialKey: 'HM-BILINMEYEN', name: null, stockKg: null, reservedKg: 10, unenteredKg: 0, freeKg: null }]);
});

test('serbest stok: stokKg null (hic satir yok) iken bile ayrica rezervasyonu olmayan hammadde freeKg = stockKg (0 degil, null olabilir)', () => {
  const r = freeStockByMaterial([{ materialKey: 'HM-X', name: null, stockKg: null }], []);
  assert.equal(r[0].freeKg, null);
});

test('siralama: en kritik (en az serbest) once; esitlikte hammadde koduna gore', () => {
  const stock = [
    { materialKey: 'HM-A', stockKg: 100 }, { materialKey: 'HM-B', stockKg: 10 }, { materialKey: 'HM-C', stockKg: 10 },
  ];
  const r = freeStockByMaterial(stock, []);
  assert.deepEqual(r.map((x) => x.materialKey), ['HM-B', 'HM-C', 'HM-A']);
});
