const KEY = 'skylineflight.save.v1';
const BACKUP_KEY = 'skylineflight.save.v1.backup';
const SAVE_VERSION = 1;

export function createEmptySave() {
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pilotName: 'ROOKIE',
    credits: 0,
    xp: 0,
    level: 1,
    stars: {},           // missionId -> 0..3
    completed: {},       // missionId -> true
    records: {},         // missionId -> { time, score, combo, damage, topSpeed }
    ownedAircraft: ['skylark'],
    activeAircraft: 'skylark',
    upgrades: {},        // aircraftId -> { engine, handling, stability, turbo, armor }
    paint: {},           // aircraftId -> paintId
    unlockedPaints: ['factory', 'ember', 'ice'],
    unlockedRegions: ['central'],
    stats: {
      flightTime: 0,
      distance: 0,
      checkpoints: 0,
      missionsFlown: 0,
      missionsCompleted: 0,
      crashes: 0,
      nearMisses: 0,
      tricks: 0,
      topSpeed: 0,
      maxAltitude: 0,
      landings: 0,
      perfectRuns: 0,
    },
    seenBriefings: {},
    championship: { unlocked: false, completed: false, bestTotal: 0 },
  };
}

/** Repairs a parsed save in place so a partial or older file still loads. */
function migrate(save) {
  const empty = createEmptySave();
  const out = { ...empty, ...save };
  out.stats = { ...empty.stats, ...(save.stats || {}) };
  out.championship = { ...empty.championship, ...(save.championship || {}) };
  for (const k of ['stars', 'completed', 'records', 'upgrades', 'paint', 'seenBriefings']) {
    out[k] = save[k] && typeof save[k] === 'object' ? save[k] : {};
  }
  for (const k of ['ownedAircraft', 'unlockedPaints', 'unlockedRegions']) {
    out[k] = Array.isArray(save[k]) && save[k].length ? save[k] : empty[k];
  }
  if (!out.ownedAircraft.includes('skylark')) out.ownedAircraft.unshift('skylark');
  if (!out.ownedAircraft.includes(out.activeAircraft)) out.activeAircraft = out.ownedAircraft[0];
  out.credits = Number.isFinite(out.credits) ? Math.max(0, out.credits) : 0;
  out.xp = Number.isFinite(out.xp) ? Math.max(0, out.xp) : 0;
  out.level = Number.isFinite(out.level) ? Math.max(1, out.level) : 1;
  out.version = SAVE_VERSION;
  return out;
}

function looksValid(obj) {
  return obj && typeof obj === 'object' && typeof obj.version === 'number' && 'credits' in obj;
}

/**
 * Autosaving store for progress.
 *
 * Corruption policy (spec §94): the previous good file is kept in a backup slot
 * and a write only replaces the backup after the main slot parsed cleanly, so a
 * half-written record can never destroy progress silently. On a failed parse we
 * fall back to the backup and report it instead of quietly starting over.
 */
export class SaveSystem {
  constructor(bus) {
    this.bus = bus;
    this.data = createEmptySave();
    this.available = true;
    this.recovered = false;
    this._pending = false;
    this._timer = null;
  }

  load() {
    let primaryFailed = false;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (looksValid(parsed)) {
          this.data = migrate(parsed);
          // Main slot is known-good: refresh the backup from it.
          try { localStorage.setItem(BACKUP_KEY, raw); } catch { /* quota — not fatal */ }
          return this.data;
        }
        primaryFailed = true;
      }
    } catch (err) {
      primaryFailed = true;
      console.warn('[SaveSystem] primary save unreadable', err);
    }

    if (primaryFailed) {
      try {
        const raw = localStorage.getItem(BACKUP_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (looksValid(parsed)) {
          this.data = migrate(parsed);
          this.recovered = true;
          this.bus?.emit('save:recovered', { source: 'backup' });
          console.warn('[SaveSystem] recovered progress from backup slot');
          return this.data;
        }
      } catch (err) {
        console.warn('[SaveSystem] backup save unreadable too', err);
      }
      // Both slots are unusable. Park the bad data under a dated key rather than
      // deleting it, so nothing is destroyed without the player's say-so.
      try {
        const bad = localStorage.getItem(KEY);
        if (bad) localStorage.setItem(`${KEY}.corrupt.${Date.now()}`, bad);
      } catch { /* ignore */ }
      this.bus?.emit('save:corrupt', {});
    }

    this.data = createEmptySave();
    return this.data;
  }

  /** Coalesces bursts of changes into one write. */
  markDirty() {
    if (this._pending) return;
    this._pending = true;
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    this._pending = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.data.updatedAt = Date.now();
    try {
      const serialized = JSON.stringify(this.data);
      const previous = localStorage.getItem(KEY);
      localStorage.setItem(KEY, serialized);
      // Only now is the previous file known to be superseded by a complete write.
      if (previous) localStorage.setItem(BACKUP_KEY, previous);
      this.available = true;
    } catch (err) {
      this.available = false;
      console.warn('[SaveSystem] write failed; progress stays in memory for this session', err);
      this.bus?.emit('save:failed', {});
    }
  }

  wipe() {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(BACKUP_KEY);
    } catch { /* ignore */ }
    this.data = createEmptySave();
    this.flush();
  }
}
