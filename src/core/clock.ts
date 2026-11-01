// Time as a dependency: code that reads the time or waits takes a Clock, so a
// test moves time forward instead of waiting for it. Code that has to use
// setTimeout directly is tested with node:test's mock.timers instead.

import { setTimeout as delay } from "node:timers/promises";

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason if it's aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  // timers/promises rejects with an AbortError; a Clock rejects with the signal's reason, as the fake does.
  sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : {}).catch((error: unknown) => Promise.reject(signal?.aborted ? signal.reason : error)),
};

export interface FakeClock extends Clock {
  /** Moves time forward by `ms`, waking each sleeper in deadline order, and lets what they schedule run. */
  advance(ms: number): Promise<void>;
  /** How many sleeps are waiting. */
  pending(): number;
}

interface Sleeper {
  at: number;
  wake(): void;
}

/** Lets promise continuations and their I/O callbacks run before time moves on. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export function fakeClock(start = 0): FakeClock {
  let time = start;
  const sleepers = new Set<Sleeper>();
  return {
    now: () => time,
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => {
          sleepers.delete(sleeper);
          reject(signal?.reason);
        };
        const sleeper: Sleeper = {
          at: time + Math.max(0, ms),
          wake() {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        sleepers.add(sleeper);
      });
    },
    async advance(ms) {
      const until = time + ms;
      await settle();
      for (;;) {
        let next: Sleeper | null = null;
        for (const s of sleepers) if (s.at <= until && (!next || s.at < next.at)) next = s;
        if (!next) break;
        sleepers.delete(next);
        time = next.at;
        next.wake();
        await settle();
      }
      time = until;
    },
    pending: () => sleepers.size,
  };
}
