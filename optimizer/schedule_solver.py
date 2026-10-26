#!/usr/bin/env python3
"""
Cizelgeleme / optimizasyon (CP-SAT) - Node tarafindan (backend/planning/schedule.js) alt surec
olarak cagirilir. stdin'den TEK SATIR JSON problem tanimi okur, stdout'a TEK SATIR JSON sonuc
yazar. Baska dosya I/O yok (temiz bir alt surec siniri, tek basina da elle test edilebilir).

Bagimlilik: yalniz ortools (pip install ortools). Node tarafinin "sifir bagimlilik" kurali bu
dosya icin GECERLI DEGIL (ayri bir Python sureci, npm paketi degil; bkz. CLAUDE.md "Cizelgeleme").

Model (iki asamali, agirlik uydurmaya gerek kalmasin diye):
  1) once toplam gecikmeyi (tardiness) en aza indir -> T*
  2) T* sabitlenir; sonra makespan + tezgahlar arasi yuk dengesizligi + degisim sayisi x ceza
     birlikte en aza indirilir.

Degisim sayisi (hammadde/musteri SAYISI, SURESI DEGIL - gercek urun-cifti bazli ayar suresi
verisi yok): her tezgah icin AddCircuit (depo + is dugumleri, dugum basina "kendi kendine dongu"
= o tezgaha atanmamis demek) ile GERCEK zaman sirasini temsil eden bir "sonraki is" literali
kurulur; bu literal secildiginde zamanlama da (end[i] <= start[j]) zorlanir, yani devre sirasi
ile gercek baslangic zamanlari BIRBIRINE KENETLENIR (devre keyfi bir siralama secemez).

Girdi (stdin, JSON):
  {"horizonSec": int, "machines": [{"id": str, "busyUntilSec": int}],
   "jobs": [{"no": str, "durationSec": int, "dueSec": int, "materialKey": str}],
   "changeoverPenaltySec": int, "timeLimitSec"?: number}
  (dueSec: Node tarafinda termin yoksa horizonSec verilir, boylece gecikme baskisi olmaz.)

Cikti (stdout, JSON):
  basarili: {"ok": true, "assignments": [{"no", "machineId", "startSec", "endSec"}],
             "metrics": {"totalTardinessSec", "makespanSec", "loadImbalanceSec", "changeoverCount"}}
  basarisiz: {"ok": false, "error": "..."}  (gecerli JSON, exit kod YINE 0 - Node bunu "cozum
             bulunamadi" olarak gosterir; exit kod 1 YALNIZ beklenmeyen hata/cokme icindir)
"""
import json
import sys

from ortools.sat.python import cp_model

DEFAULT_TIME_LIMIT_SEC = 12.0


def _solve_stage(jobs, machines, horizon, extra_constraint=None, objective_terms=None, time_limit=DEFAULT_TIME_LIMIT_SEC):
    """Paylasilan kisitlarla YENI bir model kurar (iki asama birbirinden bagimsiz modellenir -
    'eski amaci temizle' API belirsizligine girmemek icin). Donus: (durum, solver, degiskenler) ya
    da kisit/amac eklemeden once cagirana ham degiskenleri vermek icin bir sozluk.
    """
    model = cp_model.CpModel()
    n = len(jobs)
    m = len(machines)

    assigned = [[model.NewBoolVar(f'asg_{j}_{k}') for k in range(m)] for j in range(n)]
    start = [[model.NewIntVar(0, horizon, f'st_{j}_{k}') for k in range(m)] for j in range(n)]
    end = [[model.NewIntVar(0, horizon, f'en_{j}_{k}') for k in range(m)] for j in range(n)]
    intervals = [[None] * m for _ in range(n)]

    for j, job in enumerate(jobs):
        dur = max(0, int(job['durationSec']))
        model.Add(sum(assigned[j][k] for k in range(m)) == 1)
        for k in range(m):
            model.Add(end[j][k] == start[j][k] + dur)
            intervals[j][k] = model.NewOptionalIntervalVar(start[j][k], dur, end[j][k], assigned[j][k], f'iv_{j}_{k}')

    for k, mach in enumerate(machines):
        busy = max(0, int(mach.get('busyUntilSec') or 0))
        machine_intervals = [intervals[j][k] for j in range(n)]
        if busy > 0:
            machine_intervals.append(model.NewIntervalVar(0, busy, busy, f'busy_{k}'))
        model.AddNoOverlap(machine_intervals)

    job_end = [model.NewIntVar(0, horizon, f'end_{j}') for j in range(n)]
    for j in range(n):
        for k in range(m):
            model.Add(job_end[j] == end[j][k]).OnlyEnforceIf(assigned[j][k])

    tardiness = [model.NewIntVar(0, horizon, f'tard_{j}') for j in range(n)]
    for j, job in enumerate(jobs):
        due = int(job['dueSec'])
        diff = model.NewIntVar(-horizon, horizon, f'diff_{j}')
        model.Add(diff == job_end[j] - due)
        model.AddMaxEquality(tardiness[j], [diff, model.NewConstant(0)])

    load = [model.NewIntVar(0, horizon, f'load_{k}') for k in range(m)]
    for k in range(m):
        model.Add(load[k] == sum(assigned[j][k] * max(0, int(jobs[j]['durationSec'])) for j in range(n)))
    max_load = model.NewIntVar(0, horizon, 'max_load')
    min_load = model.NewIntVar(0, horizon, 'min_load')
    model.AddMaxEquality(max_load, load)
    model.AddMinEquality(min_load, load)
    load_imbalance = model.NewIntVar(0, horizon, 'load_imbalance')
    model.Add(load_imbalance == max_load - min_load)

    makespan = model.NewIntVar(0, horizon, 'makespan')
    if n > 0:
        model.AddMaxEquality(makespan, job_end)
    else:
        model.Add(makespan == 0)

    # Degisim sayisi: tezgah basina devre (depo + is dugumleri; kendi kendine donmek = bu tezgaha atanmamis).
    # Cok buyuk kuyrukta (n^2 x tezgah sayisi yay) cozum suresi patlamasin diye bir sinir var; asilirsa
    # degisim terimi atlanir (yalniz makespan + yuk dengesi kalir) ve Node'a `changeoverSkipped` ile bildirilir.
    changeover_terms = []
    changeover_skipped = n > 60
    if not changeover_skipped:
        for k in range(m):
            arcs = []
            for j in range(n):
                arcs.append((j + 1, j + 1, assigned[j][k].Not()))
                first = model.NewBoolVar(f'first_{k}_{j}')
                last = model.NewBoolVar(f'last_{k}_{j}')
                arcs.append((0, j + 1, first))
                arcs.append((j + 1, 0, last))
            depot_used = model.NewBoolVar(f'depot_used_{k}')
            model.AddMaxEquality(depot_used, [assigned[j][k] for j in range(n)]) if n > 0 else model.Add(depot_used == 0)
            arcs.append((0, 0, depot_used.Not()))
            for i in range(n):
                for j in range(n):
                    if i == j:
                        continue
                    lit = model.NewBoolVar(f'arc_{k}_{i}_{j}')
                    arcs.append((i + 1, j + 1, lit))
                    model.Add(end[i][k] <= start[j][k]).OnlyEnforceIf(lit)
                    if jobs[i]['materialKey'] != jobs[j]['materialKey']:
                        changeover_terms.append(lit)
            model.AddCircuit(arcs)
    changeover_count = model.NewIntVar(0, max(1, n * m), 'changeover_count')
    model.Add(changeover_count == sum(changeover_terms)) if changeover_terms else model.Add(changeover_count == 0)

    if extra_constraint is not None:
        extra_constraint(model, tardiness)

    if objective_terms is not None:
        model.Minimize(objective_terms(model, {
            'makespan': makespan, 'load_imbalance': load_imbalance, 'changeover_count': changeover_count, 'tardiness': tardiness,
        }))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    return status, solver, {
        'assigned': assigned, 'start': start, 'job_end': job_end, 'tardiness': tardiness,
        'makespan': makespan, 'load_imbalance': load_imbalance, 'changeover_count': changeover_count,
        'changeover_skipped': changeover_skipped,
    }


def solve(problem):
    jobs = problem['jobs']
    machines = problem['machines']
    horizon = int(problem['horizonSec'])
    penalty = int(problem.get('changeoverPenaltySec') or 0)
    time_limit = float(problem.get('timeLimitSec') or DEFAULT_TIME_LIMIT_SEC)

    if len(machines) == 0:
        return {'ok': False, 'error': 'Tanımlı tezgah yok.'}
    if len(jobs) == 0:
        return {'ok': True, 'assignments': [], 'metrics': {'totalTardinessSec': 0, 'makespanSec': 0, 'loadImbalanceSec': 0, 'changeoverCount': 0}}

    # 1. asama: yalniz toplam gecikmeyi en aza indir.
    status1, solver1, v1 = _solve_stage(
        jobs, machines, horizon,
        objective_terms=lambda model, v: sum(v['tardiness']),
        time_limit=time_limit,
    )
    if status1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {'ok': False, 'error': f'Çözüm bulunamadı (1. aşama, OR-Tools durumu: {solver1.StatusName(status1)}).'}
    t_best = round(solver1.ObjectiveValue())

    # 2. asama: gecikme t_best'i asmayacak sekilde makespan + yuk dengesizligi + degisim sayisi x ceza.
    status2, solver2, v2 = _solve_stage(
        jobs, machines, horizon,
        extra_constraint=lambda model, tardiness: model.Add(sum(tardiness) <= t_best),
        objective_terms=lambda model, v: v['makespan'] + v['load_imbalance'] + penalty * v['changeover_count'],
        time_limit=time_limit,
    )
    if status2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {'ok': False, 'error': f'Çözüm bulunamadı (2. aşama, OR-Tools durumu: {solver2.StatusName(status2)}).'}

    assignments = []
    for j, job in enumerate(jobs):
        for k, mach in enumerate(machines):
            if solver2.Value(v2['assigned'][j][k]):
                assignments.append({
                    'no': job['no'], 'machineId': mach['id'],
                    'startSec': solver2.Value(v2['start'][j][k]), 'endSec': solver2.Value(v2['job_end'][j]),
                })
                break

    metrics = {
        'totalTardinessSec': sum(solver2.Value(t) for t in v2['tardiness']),
        'makespanSec': solver2.Value(v2['makespan']),
        'loadImbalanceSec': solver2.Value(v2['load_imbalance']),
        'changeoverCount': solver2.Value(v2['changeover_count']),
        'changeoverSkipped': v2['changeover_skipped'],
    }
    return {'ok': True, 'assignments': assignments, 'metrics': metrics}


def main():
    try:
        problem = json.loads(sys.stdin.read())
        result = solve(problem)
    except Exception as err:  # beklenmeyen hata: cokme yerine JSON + exit 1 (Node ayirt edebilsin)
        sys.stdout.write(json.dumps({'ok': False, 'error': f'Çözücüde beklenmeyen hata: {err}'}))
        sys.exit(1)
    sys.stdout.write(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()
