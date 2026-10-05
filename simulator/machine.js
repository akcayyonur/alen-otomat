import { MachineStatus } from '../shared/schema.js';

const DOWNTIME_REASONS = [
  'Takim degisimi',
  'Olcum / kalite kontrol',
  'Malzeme bekleniyor',
  'Operator molasi',
  'Talas bosaltma',
];

/**
 * Gercek kontrolcunun READ_status'tan dondurdugu ham `Status` metinleri.
 * 2026-09-18 yakalamasinda tezgah bostaydi ve yalnizca READY goruldu; RUNNING
 * karsiligi hala dogrulanmadi. Simulator buraya makul bir deger koyar ama
 * mesaj `source: 'simulator'` tasidigi icin dashboard bunu SIMULE olarak
 * isaretler - dogrulanmis bilgi yerine gecmez.
 */
const RAW_STATUS = {
  [MachineStatus.RUNNING]: 'RUN',
  [MachineStatus.IDLE]: 'READY',
  [MachineStatus.ALARM]: 'ALARM',
  [MachineStatus.OFF]: '',
};

const randBetween = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Tek bir sanal tezgah. Gercekci bir cevrim dongusu uretir:
 * RUNNING -> (cevrim biter, parca sayaci artar) -> kisa IDLE -> RUNNING,
 * araya seyrek ALARM ve cok seyrek OFF girer.
 */
export class VirtualMachine {
  constructor(profile) {
    this.profile = profile;
    this.reports = new Set(profile.reports);
    this.seq = 0;

    this.status = MachineStatus.RUNNING;
    this.partCount = Math.floor(randBetween(0, 40));
    // Gercek tezgahta RequiredPart hep 0 geldi (hedef tanimli degil). Filonun
    // cogunda oyle olsun; birkacinda hedef tanimli ki iki yol da calissin.
    this.partTarget = profile.partTarget ?? null;
    // Omur boyu sayac - gercek tezgahta 11064 goruldu.
    this.partTotal = Math.floor(randBetween(8000, 14000));
    this.cycleCutSec = 0;
    this.downtimeReason = null;
    this.alarms = [];
    this.program = this.#newProgram();

    this.spindleRpm = 0;
    this.feedRate = 0;
    this.spindleOverridePct = 100;
    this.feedOverridePct = 100;

    // Kontrolcunun kumulatif sayaclari - tezgah yillardir calisiyor.
    this.powerOnTimeSec = Math.floor(randBetween(900_000, 1_400_000));
    this.cuttingTimeSec = Math.floor(randBetween(60_000, 120_000));
    this.workTimeSec = Math.floor(randBetween(70_000, 140_000));

    this.cycleElapsedSec = 0;
    this.cycleTargetSec = randBetween(...profile.cycleSec);
    this.stateTimerSec = 0;
    this.blockNo = 1;
    this.mode = 'AUTO';

    // Devir bir cevrim boyunca sabittir (gercek tezgahta da oyle);
    // ilerleme ise birkac saniyelik bloklar halinde degisir.
    this.cycleRpm = profile.spindleTarget * randBetween(0.92, 1.0);
    this.feedFactor = 1;
    this.feedHoldSec = 0;
    this.opRpmFactor = 1;
    this.opHoldSec = 0;
  }

  /**
   * Gercek tezgahta program adi `140100187` bicimindeydi - "O1234.NC" degil.
   * Bazi tezgahlarda klasor onekli geliyor: `BERG\\140100187`.
   */
  #newProgram() {
    const n = 140100000 + Math.floor(randBetween(1, 999));
    return this.profile.programPrefix ? `${this.profile.programPrefix}\\${n}` : String(n);
  }

  #enter(status, holdSec) {
    this.status = status;
    this.stateTimerSec = holdSec;
  }

  /** @param {number} dtSec gecen sure */
  tick(dtSec) {
    this.stateTimerSec -= dtSec;

    switch (this.status) {
      case MachineStatus.RUNNING:
        this.#tickRunning(dtSec);
        break;
      case MachineStatus.IDLE:
        if (this.stateTimerSec <= 0) {
          this.downtimeReason = null;
          this.cycleElapsedSec = 0;
          this.blockNo = 1;
          this.mode = 'AUTO';
          this.cycleTargetSec = randBetween(...this.profile.cycleSec);
          this.cycleRpm = this.profile.spindleTarget * randBetween(0.92, 1.0);
          this.#enter(MachineStatus.RUNNING, 0);
        } else if (this.stateTimerSec > 30 && Math.random() < dtSec / 20) {
          // Uzun duruslarda operator elle mudahale eder.
          this.mode = pick(['MDI', 'JOG', 'HOME']);
        }
        break;
      case MachineStatus.ALARM:
        if (this.stateTimerSec <= 0) {
          this.alarms = [];
          this.downtimeReason = 'Alarm sonrasi devreye alma';
          this.#enter(MachineStatus.IDLE, randBetween(20, 60));
        }
        break;
      case MachineStatus.OFF:
        if (this.stateTimerSec <= 0) {
          this.#enter(MachineStatus.IDLE, randBetween(30, 90));
        }
        break;
    }

    this.#tickAxes(dtSec);
    this.#tickCounters(dtSec);
    return this.toTelemetry();
  }

  #tickRunning(dtSec) {
    this.cycleElapsedSec += dtSec;
    // Satir numarasi cevrim boyunca ilerler.
    this.blockNo = 1 + Math.floor((this.cycleElapsedSec / this.cycleTargetSec) * 180);

    // Seyrek alarm: ortalama ~8 dakikada bir.
    if (this.profile.alarmCodes.length > 0 && Math.random() < dtSec / 480) {
      const [code, text] = pick(this.profile.alarmCodes);
      this.alarms = [{ code, text }];
      this.#enter(MachineStatus.ALARM, randBetween(25, 90));
      return;
    }

    // Cok seyrek kapanma: ortalama ~1 saatte bir.
    if (Math.random() < dtSec / 3600) {
      this.#enter(MachineStatus.OFF, randBetween(60, 180));
      return;
    }

    if (this.cycleElapsedSec >= this.cycleTargetSec) {
      this.partCount += 1;
      this.partTotal += 1;
      this.cycleElapsedSec = 0;
      // Kontrolcu bu sayaci parca bitince sifirliyor (gercekte 26 -> 0 goruldu).
      this.cycleCutSec = 0;

      // Hedef tanimliysa parti dolunca sayac basa doner.
      if (this.partTarget !== null && this.partCount >= this.partTarget) {
        this.partCount = 0;
      }

      // Cogunlukla kisa parca degisimi; arada uzun bir durus.
      const isLongStop = Math.random() < 0.15;
      this.downtimeReason = isLongStop ? pick(DOWNTIME_REASONS) : null;
      if (isLongStop && Math.random() < 0.4) this.program = this.#newProgram();
      this.#enter(MachineStatus.IDLE, isLongStop ? randBetween(45, 180) : randBetween(3, 10));
    }
  }

  /** Devir/ilerleme yumusak sekilde hedefe yaklasir, dururken sifira iner. */
  #tickAxes(dtSec) {
    const running = this.status === MachineStatus.RUNNING;

    // Ilerleme birkac saniye sabit kalir; arada hizli hareket icin sifirlanir.
    this.feedHoldSec -= dtSec;
    if (this.feedHoldSec <= 0) {
      // Gercek veride ilerleme 0 ile 18057 mm/dk arasinda gidip geliyordu:
      // kesme ilerlemesi dusuk, bos hareket (G00) cok yuksek.
      const r = Math.random();
      this.feedFactor = r < 0.12 ? 0 : r < 0.22 ? randBetween(20, 55) : randBetween(0.85, 1.05);
      this.feedHoldSec = randBetween(3, 9);
      // Operator override'i seyrek olarak kurcalar.
      if (Math.random() < 0.08) this.feedOverridePct = pick([80, 90, 100, 100, 110, 120]);
      if (Math.random() < 0.04) this.spindleOverridePct = pick([90, 100, 100, 110]);
    }

    // Gercek tezgahta devir cevrim ICINDE degisiyordu (600-2000 rpm): her
    // operasyonun kendi devri var. Birkac saniyede bir operasyon degisir.
    this.opHoldSec -= dtSec;
    if (this.opHoldSec <= 0) {
      this.opRpmFactor = randBetween(0.3, 1.0);
      this.opHoldSec = randBetween(4, 12);
    }
    const rpmTarget = running
      ? this.cycleRpm * this.opRpmFactor * (this.spindleOverridePct / 100) * randBetween(0.997, 1.003)
      : 0;
    const feedTarget = running
      ? this.profile.feedTarget * this.feedFactor * (this.feedOverridePct / 100)
      : 0;

    const k = Math.min(1, dtSec * (running ? 1.4 : 2.2));
    this.spindleRpm += (rpmTarget - this.spindleRpm) * k;
    this.feedRate += (feedTarget - this.feedRate) * k;
  }

  #tickCounters(dtSec) {
    if (this.status !== MachineStatus.OFF) {
      this.powerOnTimeSec += dtSec;
      this.workTimeSec += dtSec;
    }
    if (this.status === MachineStatus.RUNNING) {
      this.cuttingTimeSec += dtSec;
      this.cycleCutSec += dtSec;
    }
  }

  /** O an islenen NC satiri - gercek kontrolcu READ_nc_current_block ile verir. */
  #currentBlock() {
    if (this.status !== MachineStatus.RUNNING) return '';
    const x = (randBetween(8, 60)).toFixed(2);
    const z = (-randBetween(2, 80)).toFixed(2);
    return `N${this.blockNo} G01 X${x} Z${z} F0.2`;
  }

  /** Yalnizca bu tezgahin gercekten okuyabildigi alanlari doldurur. */
  #reported(field, value) {
    return this.reports.has(field) ? value : null;
  }

  toTelemetry() {
    this.seq += 1;
    const running = this.status === MachineStatus.RUNNING;
    return {
      machineId: this.profile.id,
      ts: new Date().toISOString(),
      source: this.profile.source,
      seq: this.seq,
      status: this.status,

      spindleRpm: this.#reported('spindleRpm', Math.round(this.spindleRpm)),
      feedRate: this.#reported('feedRate', Math.round(this.feedRate)),
      spindleOverridePct: this.#reported('spindleOverridePct', this.spindleOverridePct),
      feedOverridePct: this.#reported('feedOverridePct', this.feedOverridePct),

      partCount: this.#reported('partCount', this.partCount),
      partTarget: this.#reported('partTarget', this.partTarget),  // null = hedef yok
      partTotal: this.#reported('partTotal', this.partTotal),

      cycleTimeSec: this.#reported('cycleTimeSec', Math.round(this.cycleCutSec)),
      cuttingTimeSec: this.#reported('cuttingTimeSec', Math.round(this.cuttingTimeSec)),
      powerOnTimeSec: this.#reported('powerOnTimeSec', Math.round(this.powerOnTimeSec)),
      workTimeSec: this.#reported('workTimeSec', Math.round(this.workTimeSec)),

      blockNo: this.#reported('blockNo', running ? this.blockNo : null),
      program: this.#reported('program', this.program),
      mainProgram: this.#reported('mainProgram', this.program),
      mode: this.#reported('mode', this.status === MachineStatus.OFF ? '' : this.mode),
      block: this.#reported('block', this.#currentBlock()),

      alarms: this.reports.has('alarms') ? this.alarms : [],
      downtimeReason: this.#reported('downtimeReason', this.downtimeReason),

      // Kontrolcuye ozgu ham degerler - normalize edilmez, oldugu gibi tasinir.
      controller: {
        rawStatus: RAW_STATUS[this.status],
        rawAlarm: this.alarms.length > 0 ? 'ALARM' : '',
        emg: '',
      },
    };
  }
}
