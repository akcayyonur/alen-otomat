/**
 * Satir satir fark (diff): program editorunde "kaydetmeden once neyi degistirdim" ekrani.
 * DOM'a dokunmaz (Node testi var: backend/diff.test.js).
 *
 * Yontem: ortak bas/son satirlar atilir, ortadaki parca icin en uzun ortak altdizi (LCS).
 * Cok buyuk degisiklikte (orta parca carpimi > SINIR) LCS yapilmaz: orta parca topluca
 * "silindi + eklendi" gosterilir (`coarse: true`) - yine DOGRU ama daha az ayrintili.
 */
const LCS_CELL_LIMIT = 4_000_000;

/**
 * @param {string[]} a eski satirlar
 * @param {string[]} b yeni satirlar
 * @returns {{ops: {t: '=' | '-' | '+', a?: number, b?: number, text: string}[], coarse: boolean}}
 *   `a`/`b`: 1 tabanli satir numaralari (eski/yeni metindeki).
 */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ t: '=', a: i + 1, b: i + 1, text: a[i] });

  const n = endA - start;
  const m = endB - start;
  let coarse = false;
  if (n === 0 || m === 0 || n * m > LCS_CELL_LIMIT) {
    coarse = n > 0 && m > 0;
    for (let i = start; i < endA; i += 1) ops.push({ t: '-', a: i + 1, text: a[i] });
    for (let j = start; j < endB; j += 1) ops.push({ t: '+', b: j + 1, text: b[j] });
  } else {
    // lcs[i][j]: a[start+i..] ile b[start+j..] icin en uzun ortak altdizi uzunlugu
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = a[start + i] === b[start + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ t: '=', a: start + i + 1, b: start + j + 1, text: a[start + i] });
        i += 1; j += 1;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        ops.push({ t: '-', a: start + i + 1, text: a[start + i] });
        i += 1;
      } else {
        ops.push({ t: '+', b: start + j + 1, text: b[start + j] });
        j += 1;
      }
    }
    for (; i < n; i += 1) ops.push({ t: '-', a: start + i + 1, text: a[start + i] });
    for (; j < m; j += 1) ops.push({ t: '+', b: start + j + 1, text: b[start + j] });
  }

  for (let k = 0; k < a.length - endA; k += 1) {
    ops.push({ t: '=', a: endA + k + 1, b: endB + k + 1, text: a[endA + k] });
  }
  return { ops, coarse };
}

/** Eklenen / silinen satir sayisi. */
export function countChanges(ops) {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === '+') added += 1;
    else if (o.t === '-') removed += 1;
  }
  return { added, removed };
}

/**
 * Degisen satirlari `context` satirlik baglamla gruplar (git diff gibi). Degisiklik yoksa [].
 * @returns {{ops: object[]}[]}
 */
export function hunks(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === '=') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k += 1) keep[k] = true;
  });
  const out = [];
  let cur = null;
  ops.forEach((o, i) => {
    if (!keep[i]) { cur = null; return; }
    if (!cur) { cur = { ops: [] }; out.push(cur); }
    cur.ops.push(o);
  });
  return out;
}
