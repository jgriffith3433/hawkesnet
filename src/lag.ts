// How late this process's timers fire: a 50 ms tick measures its own drift. (perf_hooks' monitorEventLoopDelay reports
// its own resolution plus the OS timer granularity, ~32 ms idle on Windows, so it can't show a few ms of real lag.)
export class Lag {
  private samples: number[] = [];
  private last = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  start() {
    if (this.timer) return this;
    this.last = performance.now();
    this.timer = setInterval(() => {
      const t = performance.now();
      this.samples.push(Math.max(0, t - this.last - 50));
      if (this.samples.length > 2400) this.samples.splice(0, 1200);
      this.last = t;
    }, 50);
    this.timer.unref?.();
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Drift in ms since the last read: p50, p99, max. */
  read() {
    const s = this.samples.slice().sort((a, b) => a - b);
    this.samples = [];
    const at = (q: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10 : 0);
    return { p50: at(0.5), p99: at(0.99), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : 0 };
  }
}
