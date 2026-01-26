type NumericSignals = Record<string, number>;

export class EmaSmoother {
  private alpha: number;
  private value: number | null = null;

  constructor(alpha = 0.35) {
    this.alpha = alpha;
  }

  update(next: number): number {
    if (this.value === null) {
      this.value = next;
      return next;
    }

    this.value = this.alpha * next + (1 - this.alpha) * this.value;
    return this.value;
  }
}

export class SignalSmoother<T extends NumericSignals> {
  private smoothers: Record<string, EmaSmoother> = {};
  private alpha: number;

  constructor(alpha = 0.35) {
    this.alpha = alpha;
  }

  update(signals: T): T {
    const output = { ...signals } as T;
    const keys = Object.keys(signals) as Array<keyof T>;
    for (const key of keys) {
      const value = signals[key];
      const keyStr = String(key);
      if (!this.smoothers[keyStr]) {
        this.smoothers[keyStr] = new EmaSmoother(this.alpha);
      }
      (output as NumericSignals)[keyStr] = this.smoothers[keyStr].update(value);
    }
    return output;
  }
}

export class LabelStabilizer<T extends string> {
  private current: T;
  private pending: T | null = null;
  private pendingFrames = 0;
  private lastSwitchAt = 0;
  private stableFrames: number;
  private cooldownMs: number;

  constructor(initial: T, stableFrames = 4, cooldownMs = 500) {
    this.current = initial;
    this.stableFrames = stableFrames;
    this.cooldownMs = cooldownMs;
  }

  update(label: T, nowMs: number): T {
    if (label === this.current) {
      this.pending = null;
      this.pendingFrames = 0;
      return this.current;
    }

    if (label !== this.pending) {
      this.pending = label;
      this.pendingFrames = 1;
      return this.current;
    }

    this.pendingFrames += 1;
    if (
      this.pendingFrames >= this.stableFrames &&
      nowMs - this.lastSwitchAt >= this.cooldownMs
    ) {
      this.current = label;
      this.pending = null;
      this.pendingFrames = 0;
      this.lastSwitchAt = nowMs;
    }

    return this.current;
  }

  getCurrent(): T {
    return this.current;
  }
}
