import { performance } from 'node:perf_hooks';
import { buildSnapshot, freezeSnapshot } from './snapshot.mjs';
import { validateSnapshot } from './validate.mjs';
import { persistSnapshot, readSnapshot, persistSourceState, readSourceState } from './persistence.mjs';
import { log, logFailure } from './log.mjs';
import { readCatalogChanges, readFingerprint, readPublicState, validFingerprints } from './supabase.mjs';

const REFRESH_OFFSET_MS = 5 * 60_000;
export function nextRefreshDelay(nowMs, intervalMs) {
  const nextSlot = Math.floor((nowMs - REFRESH_OFFSET_MS) / intervalMs + 1) * intervalMs + REFRESH_OFFSET_MS;
  return nextSlot - nowMs;
}

export async function createSnapshotStore(config) {
  let current = null;
  let running = null;
  let pending = false;
  let stopped = false;
  let timer;
  let sourceFingerprint = null;
  let catalogRevision = null;
  let checkedAt = null;
  try {
    const snapshot = await readSnapshot(config.dataDir);
    const itemById = validateSnapshot(snapshot);
    current = Object.freeze({ snapshot: freezeSnapshot(snapshot), itemById });
    checkedAt = snapshot.generatedAt;
    log('snapshot_load_success', { generatedAt: snapshot.generatedAt, items: snapshot.items.length });
  } catch (error) { logFailure('snapshot_load_failure', error); }
  if (current) {
    try {
      const state = await readSourceState(config.dataDir);
      if (state.snapshotId === current.snapshot.snapshotId && validFingerprints(state.fingerprints)) {
        sourceFingerprint = state.fingerprints;
        if (Number.isSafeInteger(state.catalogRevision) && state.catalogRevision >= 1) catalogRevision = state.catalogRevision;
        if (typeof state.checkedAt === 'string' && Number.isFinite(Date.parse(state.checkedAt))) checkedAt = state.checkedAt;
      }
    } catch { /* A missing/corrupt sidecar safely requires one full synchronization. */ }
  }

  async function rebuild(reason) {
    const started = performance.now();
    let rowCounts;
    log('refresh_start', { reason });
    try {
      const state = await readPublicState(config);
      const fingerprint = state.fingerprints;
      const sections = Object.keys(fingerprint).filter(key => !current || fingerprint[key] !== sourceFingerprint?.[key]);
      if (catalogRevision !== state.catalog_revision && !sections.includes('catalog')) sections.push('catalog');
      if (sections.length === 0) {
        checkedAt = new Date(state.checked_at).toISOString();
        await saveSourceState();
        log('refresh_end', { reason, success: true, changed: false, downloaded: false, checkedAt,
          durationMs: Math.round(performance.now() - started), generatedAt: current.snapshot.generatedAt });
        return;
      }
      let catalogChanges = null;
      if (current && catalogRevision !== null && catalogRevision < state.catalog_revision && sections.includes('catalog')) {
        catalogChanges = await readCatalogChanges(config, catalogRevision, state.catalog_revision);
      } else if (sections.includes('catalog') && catalogRevision === state.catalog_revision) {
        throw Object.assign(new Error('Catalog fingerprint changed without a new revision.'), { code: 'public_data_error' });
      }
      const candidate = await buildSnapshot(config, { previous: current?.snapshot, changedSections: sections, catalogChanges });
      rowCounts = candidate.rowCounts;
      const itemById = validateSnapshot(candidate.snapshot, current?.snapshot);
      // Check the live source only after a confirmed change. This catches writes
      // in progress or a second update during the separate REST page downloads.
      if (!sameFingerprints(await readFingerprint(config), fingerprint)) {
        throw Object.assign(new Error('Public data changed during snapshot download.'), { code: 'public_data_error' });
      }
      const changed = !current || publicContent(candidate.snapshot) !== publicContent(current.snapshot);
      if (changed) {
        freezeSnapshot(candidate.snapshot);
        await persistSnapshot(config.dataDir, candidate.snapshot);
        current = Object.freeze({ snapshot: candidate.snapshot, itemById });
      }
      sourceFingerprint = fingerprint;
      catalogRevision = state.catalog_revision;
      checkedAt = new Date(state.checked_at).toISOString();
      await saveSourceState();
      log('refresh_end', { reason, success: true, changed, downloaded: true, sections,
        durationMs: Math.round(performance.now() - started), rowCounts, checkedAt, generatedAt: current.snapshot.generatedAt });
    } catch (error) {
      logFailure('refresh_end', error, { reason, success: false,
        durationMs: Math.round(performance.now() - started), rowCounts: rowCounts ?? error.rowCounts,
        generatedAt: current?.snapshot.generatedAt ?? null });
    }
  }

  async function saveSourceState() {
    try {
      await persistSourceState(config.dataDir, { snapshotId: current.snapshot.snapshotId,
        fingerprints: sourceFingerprint, checkedAt, catalogRevision });
    } catch (error) { logFailure('source_state_persist_failure', error); }
  }

  function requestRefresh(reason) {
    if (stopped) return;
    log('refresh_requested', { reason, coalesced: running !== null });
    if (running) { pending = true; return; }
    running = (async () => {
      await rebuild(reason);
      while (pending && !stopped) { pending = false; await rebuild('coalesced'); }
    })().finally(() => { running = null; });
  }
  function schedulePeriodicRefresh() {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      requestRefresh('periodic');
      schedulePeriodicRefresh();
    }, nextRefreshDelay(Date.now(), config.refreshIntervalMs));
    timer.unref();
  }
  return {
    get current() { return current; },
    get checkedAt() { return checkedAt; },
    requestRefresh,
    start() {
      if (timer || stopped) return;
      requestRefresh('startup');
      schedulePeriodicRefresh();
    },
    async whenIdle() { await running; },
    async close() { stopped = true; clearTimeout(timer); await running; },
  };
}

function publicContent(snapshot) {
  const { meta, ...rotations } = snapshot.rotations;
  return JSON.stringify({ items: snapshot.items, rotations });
}
function sameFingerprints(a, b) {
  return b !== null && Object.keys(a).every(key => a[key] === b[key]);
}
