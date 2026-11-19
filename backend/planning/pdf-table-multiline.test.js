/**
 * Çok satıra yayılan kalemlerin (gerçek Konveyör/SAP sipariş formu) çapa satırında birleştirilmesi
 * (`pdf-table.js#mergeMultiLineRows`) — sentetik konumlarla; gerçek belgeden ölçülen y değerleri kullanıldı.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMultiLineRows } from './pdf-table.js';

const it = (y, row) => ({ y, row });

test('çok satırlı kalem: üst açıklama+kod, veri (çapa) satırı, alt açıklama TEK kalemde birleşir; blok arası en büyük boşluktan bölünür', () => {
  const { rows, carry } = mergeMultiLineRows([
    it(384.6, { description: 'PARÇASI G1/2' }), it(379.8, { code: '1050600045' }),
    it(358.4, { lineNo: '1', code: '1235-672', qty: '280', deliveryDate: '16.11.2026' }), it(348.1, { description: 'CW614N' }),
    it(318.0, { description: 'SOMUN G1' }), it(313.2, { code: '1050100073' }),
    it(297.4, { lineNo: '2', qty: '2.000', deliveryDate: '11.12.2026' }), it(292.9, { description: '8733702822' }), it(289.4, { code: '1235-694' }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { description: 'PARÇASI G1/2 CW614N', code: '1050600045 1235-672', lineNo: '1', qty: '280', deliveryDate: '16.11.2026' });
  assert.equal(rows[1].code, '1050100073 1235-694', 'kalem 2\'nin alt satırı kalem 3\'e kaymaz');
  assert.equal(rows[1].qty, '2.000');
  assert.equal(carry, null);
});

test('sayfa sonunda yarım kalan sonraki kalem: son çapanın altındaki BÜYÜK boşluktan sonrası `carry` olur, son kaleme karışmaz', () => {
  const { rows, carry } = mergeMultiLineRows([
    it(297.4, { lineNo: '2', qty: '2.000', deliveryDate: '11.12.2026' }), it(292.9, { description: '8733702822' }), it(289.4, { code: '1235-694' }),
    it(262.7, { description: 'PARÇASI G3/8' }), it(258.0, { code: '1050700057' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '1235-694');
  assert.deepEqual(carry, { description: 'PARÇASI G3/8', code: '1050700057' });
});

test('çapa yoksa (adet/tarih okunmayan satırlar) satırlar AYNEN kalır; uzak satır orphan olarak ayrı kalır', () => {
  const noAnchor = mergeMultiLineRows([it(100, { description: 'a' }), it(90, { description: 'b' })]);
  assert.deepEqual(noAnchor.rows, [{ description: 'a' }, { description: 'b' }]);
  const far = mergeMultiLineRows([it(500, { description: 'çok uzak' }), it(100, { qty: '5' })]);
  assert.equal(far.rows.length, 2, 'çapanın 40pt\'den uzağındaki üst satır çapaya eklenmez');
  assert.equal(far.carry, null);
});
