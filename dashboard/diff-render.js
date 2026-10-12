/**
 * Satir farkini HTML tablo olarak cizer (program editoru "gozden gecir" adimi ve toplu alimdaki "cakisma" ekrani).
 * Saf mantik diff.js'te; burasi yalnizca gorunum. Renk tek basina anlam tasimaz: her satirda +/− isareti vardir.
 */
import { escapeHtml, num } from './format.js';
import { diffLines, countChanges, hunks } from './diff.js';

const MAX_DIFF_ROWS = 600;

/** Gorunmeyen sondaki bosluklari "·" ile gosterir: yalniz bosluk farki olan satirlar ayirt edilebilsin. */
function visText(t) {
  const body = t.replace(/[ \t]+$/, '');
  const tail = t.slice(body.length);
  return `${escapeHtml(body)}${tail ? `<span class="diff-ws" title="satır sonunda boşluk">${'·'.repeat(tail.length)}</span>` : ''}` || '&nbsp;';
}

/**
 * @param {string} oldText eski metin (satirlar \n ile; CRLF'ler once LF'e indirilmis olmali)
 * @param {string} newText yeni metin
 * @param {{context?: number, maxRows?: number, cutNote?: string}} [opt]
 * @returns {{html: string, added: number, removed: number, coarse: boolean}} degisiklik yoksa html bos
 */
export function diffTable(oldText, newText, { context = 3, maxRows = MAX_DIFF_ROWS, cutNote = 'gösterilmiyor' } = {}) {
  const { ops, coarse } = diffLines(oldText.split('\n'), newText.split('\n'));
  const { added, removed } = countChanges(ops);
  if (added + removed === 0) return { html: '', added, removed, coarse };

  let rows = 0;
  let cut = 0;
  const body = hunks(ops, context).map((g) => {
    const first = g.ops.find((o) => o.a != null);
    const firstB = g.ops.find((o) => o.b != null);
    const head = `<tr class="diff-hunk"><td colspan="4">eski ${first ? `satır ${first.a}` : '—'} · yeni ${firstB ? `satır ${firstB.b}` : '—'}</td></tr>`;
    const lines = [];
    for (const o of g.ops) {
      if (rows >= maxRows) { cut += 1; continue; }
      rows += 1;
      const cls = o.t === '+' ? 'diff-add' : o.t === '-' ? 'diff-del' : '';
      const sign = o.t === '+' ? '+' : o.t === '-' ? '−' : '';
      const word = o.t === '+' ? 'eklendi' : o.t === '-' ? 'silindi' : 'değişmedi';
      lines.push(`<tr class="${cls}"><td class="ln">${o.a ?? ''}</td><td class="ln">${o.b ?? ''}</td>` +
        `<td class="sg"${sign ? ` aria-label="${word}"` : ''}>${sign}</td><td class="tx">${visText(o.text)}</td></tr>`);
    }
    return head + lines.join('');
  }).join('');

  const html = `<div class="diff-wrap"><table class="diff" aria-label="Değişiklik farkı"><tbody>${body}</tbody></table></div>` +
    (cut > 0 ? `<p class="hint">… ${num(cut)} satır daha var, ${escapeHtml(cutNote)}.</p>` : '');
  return { html, added, removed, coarse };
}
