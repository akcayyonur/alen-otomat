import { MachineStatus } from '../shared/schema.js';

const DOWNTIME_REASONS = [
  'Takim degisimi',
  'Olcum / kalite kontrol',
  'Malzeme bekleniyor',
  'Operator molasi',
  'Talas bosaltma',
];

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
    this.lastCycleTimeSec = null;
    this.downtimeReason = null;
    this.alarms = [];
    this.program = this.#newProgram();

    this.spindleRpm = 0;
    this.feedRate = 0;

    this.cycleElapsedSec = 0;
    this.cycleTargetSec = randBetween(...profile.cycleSec);
    this.stateTimerSec = 0;

    // Devir bir cevrim boyunca sabittir (gercek tezgahta da oyle);
    // ilerleme ise birkac saniyelik bloklar halinde degisir.
    this.cycleRpm = profile.spindleTarget * randBetween(0.92, 1.0);
    this.feedFactor = 1;
    this.feedHoldSec = 0;
  }

  #newProgram() {
    const n = Math.floor(randBetween(1000, 9999));
    return `O${n}.NC`;
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
          this.cycleTargetSec = randBetween(...this.profile.cycleSec);
          this.cycleRpm = this.profile.spindleTarget * randBetween(0.92, 1.0);
          this.#enter(MachineStatus.RUNNING, 0);
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
    return this.toTelemetry();
  }

  #tickRunning(dtSec) {
    this.cycleElapsedSec += dtSec;

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
      this.lastCycleTimeSec = Math.round(this.cycleElapsedSec * 10) / 10;
      this.cycleElapsedSec = 0;

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
      this.feedFactor = Math.random() < 0.12 ? 0 : randBetween(0.85, 1.05);
      this.feedHoldSec = randBetween(3, 9);
    }

    // Devir cevrim boyunca sabit, uzerine cok kucuk bir olcum gurultusu.
    const rpmTarget = running ? this.cycleRpm * randBetween(0.997, 1.003) : 0;
    const feedTarget = running ? this.profile.feedTarget * this.feedFactor : 0;

    const k = Math.min(1, dtSec * (running ? 1.4 : 2.2));
    this.spindleRpm += (rpmTarget - this.spindleRpm) * k;
    this.feedRate += (feedTarget - this.feedRate) * k;
  }

  /** Yalnizca bu tezgahin gercekten okuyabildigi alanlari doldurur. */
  #reported(field, value) {
    return this.reports.has(field) ? value : null;
  }

  toTelemetry() {
    this.seq += 1;
    return {
      machineId: this.profile.id,
      ts: new Date().toISOString(),
      source: this.profile.source,
      seq: this.seq,
      status: this.status,
      spindleRpm: this.#reported('spindleRpm', Math.round(this.spindleRpm)),
      feedRate: this.#reported('feedRate', Math.round(this.feedRate)),
      partCount: this.#reported('partCount', this.partCount),
      cycleTimeSec: this.#reported('cycleTimeSec', this.lastCycleTimeSec),
      program: this.#reported('program', this.program),
      alarms: this.reports.has('alarms') ? this.alarms : [],
      downtimeReason: this.#reported('downtimeReason', this.downtimeReason),
    };
  }
}
