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

  constructor(private alpha = 0.35) {}

  update(signals: T): T {
    const output = { ...signals };
    for (const [key, value] of Object.entries(signals)) {
      if (!this.smoothers[key]) {
        this.smoothers[key] = new EmaSmoother(this.alpha);
      }
      output[key] = this.smoothers[key].update(value);
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
