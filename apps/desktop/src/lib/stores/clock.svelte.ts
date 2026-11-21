/**
 * One clock for the whole app (#662): the countdown of a timed unlock, in the
 * top bar chip, the rail tooltip and Preferences, reads `clock.now`. It ticks
 * once a second only while an unlock runs; the cluster settings store starts
 * and stops it after every answer it applies. It imports nothing.
 */

const TICK_MS = 1_000;

class Clock {
  /** Unix milliseconds, as of the last tick. */
  now = $state(Date.now());

  #timer: ReturnType<typeof setInterval> | null = null;

  get running(): boolean {
    return this.#timer !== null;
  }

  /**
   * Start or stop the one interval; a second call keeps it. Either way `now`
   * is read again, so an answer applied while stopped is judged by the time
   * it arrived, not by the last tick.
   */
  run(on: boolean): void {
    this.now = Date.now();
    if (on === this.running) return;
    if (on) {
      this.#timer = setInterval(() => (this.now = Date.now()), TICK_MS);
    } else if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

export const clock = new Clock();
