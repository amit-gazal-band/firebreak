/** Match time in milliseconds since the match started. */
export interface Clock {
  now(): number;
  /** Resolve when match time reaches `t`. */
  until(t: number, signal?: AbortSignal): Promise<void>;
}

export class RealClock implements Clock {
  private start = performance.now();

  now(): number {
    return performance.now() - this.start;
  }

  until(t: number, signal?: AbortSignal): Promise<void> {
    const wait = t - this.now();
    if (wait <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** Jumps straight to the requested time. For scripted bots, tests and fast simulation. */
export class VirtualClock implements Clock {
  private t = 0;

  now(): number {
    return this.t;
  }

  until(t: number): Promise<void> {
    this.t = Math.max(this.t, t);
    return Promise.resolve();
  }
}
