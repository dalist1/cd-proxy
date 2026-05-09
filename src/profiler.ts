export interface ProfileSnapshotEntry {
  count: number;
  total_ms: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
}

interface ProfileEntry {
  count: number;
  total: number;
  min: number;
  max: number;
}

export class Profiler {
  private entries = new Map<string, ProfileEntry>();

  constructor(readonly enabled: boolean) {}

  now(): number {
    return this.enabled ? performance.now() : 0;
  }

  add(name: string, start: number) {
    if (!this.enabled) return;
    this.addDuration(name, performance.now() - start);
  }

  addDuration(name: string, ms: number) {
    if (!this.enabled) return;
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { count: 0, total: 0, min: Infinity, max: 0 };
      this.entries.set(name, entry);
    }
    entry.count++;
    entry.total += ms;
    if (ms < entry.min) entry.min = ms;
    if (ms > entry.max) entry.max = ms;
  }

  reset() {
    this.entries.clear();
  }

  snapshot(): Record<string, ProfileSnapshotEntry> {
    const out: Record<string, ProfileSnapshotEntry> = {};
    for (const [name, entry] of this.entries) {
      out[name] = {
        count: entry.count,
        total_ms: Number(entry.total.toFixed(6)),
        avg_ms: Number((entry.total / Math.max(1, entry.count)).toFixed(6)),
        min_ms: Number((entry.min === Infinity ? 0 : entry.min).toFixed(6)),
        max_ms: Number(entry.max.toFixed(6)),
      };
    }
    return out;
  }
}
