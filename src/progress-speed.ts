import { performance } from 'node:perf_hooks'

interface SpeedSample {
  time: number
  value: number
}

export class ProgressSpeedTracker {
  readonly #windowMilliseconds: number
  #samples: SpeedSample[] = []

  constructor(windowMilliseconds = 5_000) {
    if (!Number.isFinite(windowMilliseconds) || windowMilliseconds <= 0) {
      throw new RangeError('Speed window must be a positive number')
    }
    this.#windowMilliseconds = windowMilliseconds
  }

  reset(value = 0, now = performance.now()): void {
    this.#samples = [{ time: now, value }]
  }

  update(value: number, now = performance.now()): number {
    const latest = this.#samples.at(-1)
    if (latest === undefined || value < latest.value || now < latest.time) {
      this.reset(value, now)
      return 0
    }

    this.#samples.push({ time: now, value })
    const cutoff = now - this.#windowMilliseconds
    while (this.#samples.length > 2 && this.#samples[1]!.time <= cutoff) {
      this.#samples.shift()
    }

    const first = this.#samples[0]!
    const elapsed = now - first.time
    const completed = value - first.value
    return elapsed > 0 && completed > 0 ? (completed * 1_000) / elapsed : 0
  }
}

export function formatProgressSpeed(itemsPerSecond: number): string {
  const rate = Number.isFinite(itemsPerSecond) && itemsPerSecond > 0 ? itemsPerSecond : 0
  let formatted: string
  if (rate >= 1_000_000) {
    formatted = `${(rate / 1_000_000).toFixed(1)}m`
  } else if (rate >= 1_000) {
    formatted = `${(rate / 1_000).toFixed(1)}k`
  } else if (rate >= 100) {
    formatted = rate.toFixed(0)
  } else {
    formatted = rate.toFixed(1)
  }
  return `${formatted.padStart(5)} items/s`
}
