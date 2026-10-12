/**
 * Program editorunun satir farki (dashboard/diff.js): DOM'suz saf islev, Node'da sinanir.
 * Degismez: ops'tan eski metin (= ve -) ve yeni metin (= ve +) AYNEN geri uretilebilmeli;
 * yoksa kullaniciya yanlis bir "ne degisti" gosterilmis olur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, countChanges, hunks } from '../dashboard/diff.js';

const eski = (ops) => ops.filter((o) => o.t !== '+').map((o) => o.text);
const yeni = (ops) => ops.filter((o) => o.t !== '-').map((o) => o.text);

function dogrula(a, b) {
  const { ops } = diffLines(a, b);
  assert.deepEqual(eski(ops), a, 'eski metin geri uretilebilmeli');
  assert.deepEqual(yeni(ops), b, 'yeni metin geri uretilebilmeli');
  // satir numaralari 1 tabanli ve artan
  const aNo = ops.filter((o) => o.a != null).map((o) => o.a);
  const bNo = ops.filter((o) => o.b != null).map((o) => o.b);
  assert.deepEqual(aNo, a.map((_, i) => i + 1));
  assert.deepEqual(bNo, b.map((_, i) => i + 1));
  return ops;
}

test('diff: ayni metin -> degisiklik yok', () => {
  const ops = dogrula(['G0', 'M99'], ['G0', 'M99']);
  assert.deepEqual(countChanges(ops), { added: 0, removed: 0 });
  assert.deepEqual(hunks(ops), []);
});

test('diff: ortaya satir ekleme, silme, degistirme', () => {
  const a = ['O1', 'G0 X0.', 'G1 Z-5.', 'M99'];
  assert.deepEqual(countChanges(dogrula(a, ['O1', 'G0 X0.', 'G4 X1.', 'G1 Z-5.', 'M99'])), { added: 1, removed: 0 });
  assert.deepEqual(countChanges(dogrula(a, ['O1', 'G1 Z-5.', 'M99'])), { added: 0, removed: 1 });
  const ops = dogrula(a, ['O1', 'G0 X1.', 'G1 Z-5.', 'M99']);
  assert.deepEqual(countChanges(ops), { added: 1, removed: 1 });
  assert.deepEqual(ops.filter((o) => o.t === '-').map((o) => o.text), ['G0 X0.']);
  assert.deepEqual(ops.filter((o) => o.t === '+').map((o) => o.text), ['G0 X1.']);
});

test('diff: bastan/sondan ekleme, bos metinler, tamamen farkli metin', () => {
  assert.deepEqual(countChanges(dogrula(['b'], ['a', 'b', 'c'])), { added: 2, removed: 0 });
  assert.deepEqual(countChanges(dogrula([], ['a', 'b'])), { added: 2, removed: 0 });
  assert.deepEqual(countChanges(dogrula(['a', 'b'], [])), { added: 0, removed: 2 });
  assert.deepEqual(countChanges(dogrula(['a', 'b'], ['x', 'y', 'z'])), { added: 3, removed: 2 });
  assert.deepEqual(diffLines([], []).ops, []);
});

test('diff: tekrarlayan satirlar (NC icin tipik) dogru hizalanir', () => {
  const a = ['M99', '', '$2', 'N11', 'M99', '', ''];
  const b = ['M99', '', '$2', 'N11', 'G4 X1.', 'M99', '', ''];
  const ops = dogrula(a, b);
  assert.deepEqual(countChanges(ops), { added: 1, removed: 0 });
});

test('diff: rastgele metinlerde her zaman iki yone dogru (500 deneme)', () => {
  let tohum = 12345;
  const rnd = (n) => { tohum = (tohum * 1103515245 + 12345) & 0x7fffffff; return tohum % n; };
  const sozluk = ['G0 X0.', 'G1 Z-1.', 'M99', '', '$1', '$2', 'N11', 'G4 X1.'];
  for (let k = 0; k < 500; k += 1) {
    const a = Array.from({ length: rnd(14) }, () => sozluk[rnd(sozluk.length)]);
    const b = Array.from({ length: rnd(14) }, () => sozluk[rnd(sozluk.length)]);
    dogrula(a, b);
  }
});

test('diff: cok buyuk degisiklikte LCS yapilmaz (coarse) ama sonuc yine dogru', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `eski ${i}`);
  const b = Array.from({ length: 2500 }, (_, i) => `yeni ${i}`);
  const { ops, coarse } = diffLines(a, b);
  assert.equal(coarse, true);
  assert.deepEqual(eski(ops), a);
  assert.deepEqual(yeni(ops), b);
});

test('hunks: degisiklikler baglamla gruplanir, uzak degisiklikler ayri parca olur', () => {
  const a = Array.from({ length: 40 }, (_, i) => `satir ${i + 1}`);
  const b = [...a];
  b[2] = 'DEGISTI 3';
  b[35] = 'DEGISTI 36';
  const { ops } = diffLines(a, b);
  const g = hunks(ops, 3);
  assert.equal(g.length, 2);
  assert.ok(g[0].ops.some((o) => o.t === '+' && o.text === 'DEGISTI 3'));
  assert.ok(g[1].ops.some((o) => o.t === '+' && o.text === 'DEGISTI 36'));
  assert.ok(g[0].ops.length <= 3 + 2 + 3 + 1, 'baglam 3 satirla sinirli');
  assert.equal(hunks(ops, 40).length, 1, 'genis baglam tek parcaya birlestirir');
});
