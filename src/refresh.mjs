import { performance } from 'node:perf_hooks';
import { buildSnapshot, freezeSnapshot } from './snapshot.mjs';
import { validateSnapshot } from './validate.mjs';
import { persistSnapshot, readSnapshot } from './persistence.mjs';
import { log, logFailure } from './log.mjs';

export async function createSnapshotStore(config) {
  let current = null;
  let running = null;
  let pending = false;
  let stopped = false;
  let timer;

  try {
    const snapshot = await readSnapshot(config.dataDir);
    const itemById = validateSnapshot(snapshot);
    current = Object.freeze({ snapshot: freezeSnapshot(snapshot), itemById });
    log('snapshot_load_success', { generatedAt: snapshot.generatedAt, items: snapshot.items.length });
  } catch (error) {
    logFailure('snapshot_load_failure', error);
  }

  async function rebuild(reason) {
    const started = performance.now();
    let rowCounts;
    log('refresh_start', { reason });
    try {
      const candidate = await buildSnapshot(config);
      rowCounts = candidate.rowCounts;
      const itemById = validateSnapshot(candidate.snapshot, current?.snapshot);
      freezeSnapshot(candidate.snapshot);
      await persistSnapshot(config.dataDir, candidate.snapshot);
      current = Object.freeze({ snapshot: candidate.snapshot, itemById });
      log('refresh_end', { reason, success: true, durationMs: Math.round(performance.now() - started), rowCounts, generatedAt: current.snapshot.generatedAt });
    } catch (error) {
      logFailure('refresh_end', error, {
        reason, success: false, durationMs: Math.round(performance.now() - started),
        rowCounts: rowCounts ?? error.rowCounts, generatedAt: current?.snapshot.generatedAt ?? null,
      });
    }
  }

  function requestRefresh(reason) {
    if (stopped) return;
    log('refresh_requested', { reason, coalesced: running !== null });
    if (running) {
      pending = true;
      return;
    }
    running = (async () => {
      await rebuild(reason);
      while (pending && !stopped) {
        pending = false;
        await rebuild('coalesced');
      }
    })().finally(() => { running = null; });
  }

  return {
    get current() { return current; },
    requestRefresh,
    start() {
      if (timer || stopped) return;
      requestRefresh('startup');
      timer = setInterval(() => requestRefresh('periodic'), config.refreshIntervalMs);
      timer.unref();
    },
    async whenIdle() { await running; },
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
