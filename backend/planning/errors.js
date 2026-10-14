/** Planlama modülünün hata sınıfı (planning.js yeniden dışa aktarır; kalite/çizim modülleri döngüsel içe aktarma olmasın diye buradan alır). */
export class PlanningError extends Error {
  /** @param {string} message @param {number} [status] @param {string|null} [code] */
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
