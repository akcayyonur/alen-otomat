"""
schedule_solver.py'nin KENDI testi (Node'daki schedule.test.js sahte `run` kullanir, bu dosyayi
HIC calistirmaz). Gercek OR-Tools cozucusunu calistirir; bu yuzden npm test'in parcasi DEGIL -
elle calistirilir:

    pip install ortools
    python -m unittest optimizer/test_schedule_solver.py -v

~30-60 sn surer (CP-SAT cagrilari).
"""
import unittest

from schedule_solver import solve


class ScheduleSolverTest(unittest.TestCase):
    def test_bos_is_listesi(self):
        r = solve({'horizonSec': 1000, 'changeoverPenaltySec': 0, 'machines': [{'id': 'M1', 'busyUntilSec': 0}], 'jobs': []})
        self.assertEqual(r, {'ok': True, 'assignments': [], 'metrics': {'totalTardinessSec': 0, 'makespanSec': 0, 'loadImbalanceSec': 0, 'changeoverCount': 0}})

    def test_tezgah_yok(self):
        r = solve({'horizonSec': 1000, 'changeoverPenaltySec': 0, 'machines': [], 'jobs': [{'no': 'X', 'durationSec': 100, 'dueSec': 500, 'materialKey': 'A'}]})
        self.assertFalse(r['ok'])
        self.assertIn('tezgah', r['error'])

    def test_ufuk_cok_kucuk_cozum_bulunamaz(self):
        r = solve({
            'horizonSec': 100, 'changeoverPenaltySec': 0, 'machines': [{'id': 'M1', 'busyUntilSec': 0}],
            'jobs': [{'no': 'X', 'durationSec': 500, 'dueSec': 50, 'materialKey': 'A'}, {'no': 'Y', 'durationSec': 500, 'dueSec': 50, 'materialKey': 'A'}],
        })
        self.assertFalse(r['ok'])

    def test_ayni_malzeme_ayni_tezgahta_gruplanir_degisim_sifir(self):
        # 2 tezgah, meşgul değil; 4 iş (2 x A, 2 x B), gevşek terminler: dengesizlik yoksa değişim 0 olmalı.
        r = solve({
            'horizonSec': 6000, 'changeoverPenaltySec': 1000,
            'machines': [{'id': 'M1', 'busyUntilSec': 0}, {'id': 'M2', 'busyUntilSec': 500}],
            'jobs': [
                {'no': 'J1', 'durationSec': 1000, 'dueSec': 2000, 'materialKey': 'A'},
                {'no': 'J2', 'durationSec': 1000, 'dueSec': 2000, 'materialKey': 'A'},
                {'no': 'J3', 'durationSec': 1000, 'dueSec': 5000, 'materialKey': 'B'},
                {'no': 'J4', 'durationSec': 1000, 'dueSec': 5000, 'materialKey': 'B'},
            ],
        })
        self.assertTrue(r['ok'])
        self.assertEqual(r['metrics']['totalTardinessSec'], 0)
        self.assertEqual(r['metrics']['changeoverCount'], 0)
        by_machine = {}
        for a in r['assignments']:
            by_machine.setdefault(a['machineId'], []).append(a['no'])
        # Her tezgahta tek malzeme calismali (A'lar bir arada, B'ler bir arada)
        for jobs_on_machine in by_machine.values():
            self.assertEqual(len(set('A' if j in ('J1', 'J2') else 'B' for j in jobs_on_machine)), 1)

    def test_mesgul_tezgah_erken_baslatmaz(self):
        r = solve({
            'horizonSec': 6000, 'changeoverPenaltySec': 0,
            'machines': [{'id': 'M1', 'busyUntilSec': 2000}],
            'jobs': [{'no': 'X', 'durationSec': 500, 'dueSec': 5000, 'materialKey': 'A'}],
        })
        self.assertTrue(r['ok'])
        self.assertGreaterEqual(r['assignments'][0]['startSec'], 2000)

    def test_tardiness_ve_degisim_dengesi_tutarli(self):
        # Sıkı terminli iş (C1) nedeniyle makul bir değişim sayısı kabul edilir ama gecikme SIFIR kalmalı (öncelik 1).
        r = solve({
            'horizonSec': 10000, 'changeoverPenaltySec': 1000,
            'machines': [{'id': 'M1', 'busyUntilSec': 0}, {'id': 'M2', 'busyUntilSec': 0}],
            'jobs': [
                {'no': 'A1', 'durationSec': 1000, 'dueSec': 9000, 'materialKey': 'A'},
                {'no': 'A2', 'durationSec': 1000, 'dueSec': 9000, 'materialKey': 'A'},
                {'no': 'B1', 'durationSec': 1000, 'dueSec': 9000, 'materialKey': 'B'},
                {'no': 'B2', 'durationSec': 1000, 'dueSec': 9000, 'materialKey': 'B'},
                {'no': 'C1', 'durationSec': 1000, 'dueSec': 1200, 'materialKey': 'C'},
                {'no': 'C2', 'durationSec': 1000, 'dueSec': 9000, 'materialKey': 'C'},
            ],
        })
        self.assertTrue(r['ok'])
        self.assertEqual(r['metrics']['totalTardinessSec'], 0)


if __name__ == '__main__':
    unittest.main()
