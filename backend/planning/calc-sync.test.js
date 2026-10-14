/**
 * Is emri hesaplari iki yerde yasar: backend/planning/calc.js (sunucu, kayit) ve dashboard/planning-common.js (ekranda canli onizleme).
 * Ikisi ayrisirsa ekranda gorulen sayi ile kaydedilen sayi farkli olur; bu test esitligi sabitler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as srv from './calc.js';
import * as ui from '../../dashboard/planning-common.js';

test('sabitler ayni', () => {
  assert.equal(ui.BAR_USABLE_MM, srv.BAR_USABLE_MM);
  assert.equal(ui.CUT_ALLOWANCE_MM, srv.CUT_ALLOWANCE_MM);
});

test('hammadde, sure ve tezgah numarasi: ayni girdi -> ayni sonuc', () => {
  const girdiler = [
    { qty: 100, grossKg: 0.0123, lengthMm: 21 }, { qty: 1, grossKg: 0.5, lengthMm: 2898 }, { qty: 2500, grossKg: 0.00431, lengthMm: 17.5 },
    { qty: 0, grossKg: 1, lengthMm: 10 }, { qty: 10, grossKg: null, lengthMm: null }, { qty: 7, grossKg: 0.1, lengthMm: 0 },
  ];
  for (const g of girdiler) assert.deepEqual(ui.rawMaterial(g), srv.rawMaterial(g), JSON.stringify(g));
  for (const [q, s] of [[100, 24], [1, 0.4], [0, 20], [50, null], [12345, 23.7]]) assert.equal(ui.plannedHours(q, s), srv.plannedHours(q, s), `${q}x${s}`);
  for (const id of ['CNC-03', 'CNC-08', 'T 5', 'x', '', null, undefined]) assert.equal(ui.machineNumber(id), srv.machineNumber(id), String(id));
});
