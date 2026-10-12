/**
 * Dashboard modullerinin hepsi sunucunun statik dosya beyaz listesinde (STATIC_FILES) olmali.
 * Liste "path traversal'a kapali" olsun diye acik tutuldu; yeni bir .js modulu eklenip listeye
 * unutulursa tarayicida 404 alir ve TUM ekran (import zinciri) calismaz. Bu test onu yakalar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const kok = fileURLToPath(new URL('..', import.meta.url));
const dashboard = join(kok, 'dashboard');
const sunucu = readFileSync(join(kok, 'backend', 'server.js'), 'utf8');

const liste = new Map(
  [...sunucu.matchAll(/'(\/[\w.-]*)':\s*\['\.\.\/dashboard\/([\w.-]+)'/g)].map((m) => [m[1], m[2]]),
);

test('statik liste: her giris gercekten var olan bir dashboard dosyasina gider', () => {
  assert.ok(liste.size >= 8, 'liste okunabildi');
  for (const [yol, dosya] of liste) {
    assert.ok(existsSync(join(dashboard, dosya)), `${yol} -> dashboard/${dosya} yok`);
  }
});

test('statik liste: dashboard/*.js ve css dosyalarinin hepsi listede (yoksa tarayicida 404)', () => {
  const sunulan = new Set(liste.values());
  for (const dosya of readdirSync(dashboard).filter((d) => /\.(js|css|html)$/.test(d))) {
    assert.ok(sunulan.has(dosya), `dashboard/${dosya} sunucunun STATIC_FILES listesinde yok`);
  }
});

test('statik liste: dashboard modullerinin import ettigi her ./modul.js sunuluyor', () => {
  const sunulan = new Set(liste.values());
  for (const dosya of readdirSync(dashboard).filter((d) => d.endsWith('.js'))) {
    const kaynak = readFileSync(join(dashboard, dosya), 'utf8');
    for (const m of kaynak.matchAll(/from\s+'\.\/([\w.-]+\.js)'/g)) {
      assert.ok(sunulan.has(m[1]), `${dosya} -> ./${m[1]} import ediyor ama sunulmuyor`);
    }
  }
});
