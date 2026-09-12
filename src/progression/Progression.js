import { MISSIONS, MISSION_BY_ID, TOTAL_STARS } from '../data/missions.js';
import { AIRCRAFT, AIRCRAFT_ORDER, getAircraft } from '../data/aircraft.js';
import { REGIONS, REGION_ORDER } from '../data/regions.js';
import { PAINTS, UPGRADE_TREE, applyUpgrades, upgradeCost } from '../data/upgrades.js';
import { SECRETS, SECRET_BY_ID, SECRET_REWARD } from '../data/secrets.js';

/**
 * Progression, economy and unlocks (spec §48-56, §79, §97).
 *
 * Gating is by stars earned rather than by level, because stars come from playing
 * well and a level comes from merely playing (§97). The pilot rating is cosmetic but
 * it is the number players actually quote at each other, so it tracks stars too.
 */
export const RATINGS = [
  { id: 'rookie', name: 'ROOKIE', stars: 0 },
  { id: 'pilot', name: 'PILOT', stars: 9 },
  { id: 'ace', name: 'ACE', stars: 21 },
  { id: 'elite', name: 'ELITE', stars: 36 },
  { id: 'master', name: 'SKYLINE MASTER', stars: 54 },
];

/** XP needed to reach each level; quadratic so early levels come quickly. */
export function xpForLevel(level) {
  return Math.round(240 * Math.pow(level - 1, 1.55));
}

export class Progression {
  constructor({ save, bus }) {
    this.save = save;
    this.bus = bus;
  }

  get data() {
    return this.save.data;
  }

  get totalStars() {
    return Object.values(this.data.stars).reduce((a, b) => a + b, 0);
  }

  get maxStars() {
    return TOTAL_STARS;
  }

  get credits() {
    return this.data.credits;
  }

  get rating() {
    const stars = this.totalStars;
    let out = RATINGS[0];
    for (const r of RATINGS) if (stars >= r.stars) out = r;
    return out;
  }

  get level() {
    return this.data.level;
  }

  get xpIntoLevel() {
    return this.data.xp - xpForLevel(this.data.level);
  }

  get xpForNextLevel() {
    return xpForLevel(this.data.level + 1) - xpForLevel(this.data.level);
  }

  // ----------------------------------------------------------------- unlocks
  isMissionUnlocked(id) {
    const m = MISSION_BY_ID[id];
    if (!m) return false;
    return this.totalStars >= (m.unlock?.stars ?? 0);
  }

  isRegionUnlocked(id) {
    const r = REGIONS[id];
    if (!r) return false;
    return this.totalStars >= (r.unlock?.stars ?? 0);
  }

  /** What the map screen needs to explain a locked district (§96). */
  regionStatus(id) {
    const r = REGIONS[id];
    const need = r.unlock?.stars ?? 0;
    const unlocked = this.totalStars >= need;
    const missions = MISSIONS.filter((m) => m.region === id);
    const earned = missions.reduce((a, m) => a + (this.data.stars[m.id] ?? 0), 0);
    return {
      region: r, unlocked, need,
      shortfall: Math.max(0, need - this.totalStars),
      missions: missions.length,
      starsEarned: earned,
      starsAvailable: missions.length * 3,
      completed: missions.every((m) => this.data.completed[m.id]),
    };
  }

  isAircraftOwned(id) {
    return this.data.ownedAircraft.includes(id);
  }

  aircraftStatus(id) {
    const a = getAircraft(id);
    const owned = this.isAircraftOwned(id);
    const starsOk = this.totalStars >= a.requiresStars;
    return {
      spec: a, owned, starsOk,
      affordable: this.data.credits >= a.price,
      canBuy: !owned && starsOk && this.data.credits >= a.price,
      shortfall: Math.max(0, a.requiresStars - this.totalStars),
      price: a.price,
    };
  }

  /** The active aircraft with its upgrades applied — what actually gets flown. */
  activeSpec() {
    const id = this.data.activeAircraft;
    return applyUpgrades(getAircraft(id), this.data.upgrades[id] ?? {});
  }

  activePaint() {
    return this.data.paint[this.data.activeAircraft] ?? 'factory';
  }

  upgradeLevel(aircraftId, key) {
    return this.data.upgrades[aircraftId]?.[key] ?? 0;
  }

  // ------------------------------------------------------------ transactions
  buyAircraft(id) {
    const status = this.aircraftStatus(id);
    if (!status.canBuy) return { ok: false, reason: status.owned ? 'owned' : !status.starsOk ? 'stars' : 'credits' };
    this.data.credits -= status.price;
    this.data.ownedAircraft.push(id);
    this.data.activeAircraft = id;
    this.save.markDirty();
    this.bus.emit('progress:aircraftBought', { id, name: status.spec.name });
    return { ok: true };
  }

  selectAircraft(id) {
    if (!this.isAircraftOwned(id)) return false;
    this.data.activeAircraft = id;
    this.save.markDirty();
    this.bus.emit('progress:aircraftSelected', { id });
    return true;
  }

  buyUpgrade(aircraftId, key) {
    const tree = UPGRADE_TREE[key];
    if (!tree) return { ok: false, reason: 'unknown' };
    const level = this.upgradeLevel(aircraftId, key);
    const cost = upgradeCost(key, level);
    if (cost === null) return { ok: false, reason: 'maxed' };
    if (this.data.credits < cost) return { ok: false, reason: 'credits' };
    this.data.credits -= cost;
    this.data.upgrades[aircraftId] = { ...(this.data.upgrades[aircraftId] ?? {}), [key]: level + 1 };
    this.save.markDirty();
    this.bus.emit('progress:upgraded', { aircraftId, key, level: level + 1, cost });
    return { ok: true, level: level + 1 };
  }

  buyPaint(id) {
    const p = PAINTS[id];
    if (!p) return { ok: false, reason: 'unknown' };
    if (this.data.unlockedPaints.includes(id)) return { ok: false, reason: 'owned' };
    if (p.reward) return { ok: false, reason: 'reward-only' };
    if (this.data.credits < p.cost) return { ok: false, reason: 'credits' };
    this.data.credits -= p.cost;
    this.data.unlockedPaints.push(id);
    this.save.markDirty();
    return { ok: true };
  }

  applyPaint(id) {
    if (!this.data.unlockedPaints.includes(id)) return false;
    this.data.paint[this.data.activeAircraft] = id;
    this.save.markDirty();
    this.bus.emit('progress:paint', { id });
    return true;
  }

  unlockPaint(id) {
    if (!PAINTS[id] || this.data.unlockedPaints.includes(id)) return false;
    this.data.unlockedPaints.push(id);
    this.save.markDirty();
    return true;
  }

  // ------------------------------------------------------------ mission results
  /**
   * Records a finished mission and returns everything the results screen shows:
   * rewards, new records, and anything that just unlocked (spec §106-107).
   */
  recordResult(mission, result) {
    const id = mission.id;
    const previousStars = this.data.stars[id] ?? 0;
    const previousTotal = this.totalStars;
    const stars = result.stars ?? 0;

    this.data.stats.missionsFlown++;
    if (result.completed) {
      this.data.stats.missionsCompleted++;
      this.data.completed[id] = true;
      if (result.perfect) this.data.stats.perfectRuns++;
    }

    // Stars are a high-water mark: a worse run never takes them away.
    const starsGained = Math.max(0, stars - previousStars);
    if (stars > previousStars) this.data.stars[id] = stars;

    // Credits: the run's own score, plus a one-off bounty for new stars.
    const scoreCredits = result.completed ? Math.round(result.score / 45) : Math.round(result.score / 160);
    const starBounty = starsGained > 0 ? Math.round(mission.rewards.credits * (starsGained / 3)) : 0;
    const firstClear = result.completed && previousStars === 0 ? Math.round(mission.rewards.credits * 0.5) : 0;
    const credits = scoreCredits + starBounty + firstClear;
    const xp = Math.round((result.completed ? mission.rewards.xp : mission.rewards.xp * 0.18) + result.score / 260);

    this.data.credits += credits;
    this.data.xp += xp;

    // Records.
    const rec = this.data.records[id] ?? {};
    const records = [];
    if (result.completed) {
      if (rec.time === undefined || result.time < rec.time) {
        records.push({ key: 'TIME', value: result.time, previous: rec.time });
        rec.time = result.time;
      }
      if (rec.score === undefined || result.score > rec.score) {
        records.push({ key: 'SCORE', value: result.score, previous: rec.score });
        rec.score = result.score;
      }
      if (rec.combo === undefined || result.summary.combo > rec.combo) {
        rec.combo = result.summary.combo;
      }
      if (rec.damage === undefined || result.damageTaken < rec.damage) rec.damage = result.damageTaken;
      rec.topSpeed = Math.max(rec.topSpeed ?? 0, result.topSpeed ?? 0);
      this.data.records[id] = rec;
    }

    // Global stats.
    const s = this.data.stats;
    s.checkpoints += result.summary?.checkpoints ?? 0;
    s.nearMisses += result.summary?.nearMisses ?? 0;
    s.tricks += result.summary?.tricks ?? 0;
    s.topSpeed = Math.max(s.topSpeed, result.topSpeed ?? 0);
    if (!result.completed) s.crashes++;
    if (result.landing) s.landings++;

    // Level ups.
    const levelsGained = [];
    while (this.data.xp >= xpForLevel(this.data.level + 1)) {
      this.data.level++;
      levelsGained.push(this.data.level);
    }

    // Reward paint.
    const unlocks = [];
    if (result.completed && mission.rewards.unlockPaint && this.unlockPaint(mission.rewards.unlockPaint)) {
      unlocks.push({ kind: 'paint', id: mission.rewards.unlockPaint, name: `${PAINTS[mission.rewards.unlockPaint].name} LIVERY` });
    }

    // Anything newly reachable now that the star count went up.
    const newTotal = this.totalStars;
    if (newTotal > previousTotal) {
      for (const rid of REGION_ORDER) {
        const need = REGIONS[rid].unlock?.stars ?? 0;
        if (need > previousTotal && need <= newTotal) {
          if (!this.data.unlockedRegions.includes(rid)) this.data.unlockedRegions.push(rid);
          unlocks.push({ kind: 'region', id: rid, name: `${REGIONS[rid].name} OPEN` });
        }
      }
      for (const aid of AIRCRAFT_ORDER) {
        const need = AIRCRAFT[aid].requiresStars;
        if (need > previousTotal && need <= newTotal && !this.isAircraftOwned(aid)) {
          unlocks.push({ kind: 'aircraft', id: aid, name: `${AIRCRAFT[aid].name} AVAILABLE` });
        }
      }
      for (const m of MISSIONS) {
        const need = m.unlock?.stars ?? 0;
        if (need > previousTotal && need <= newTotal) {
          unlocks.push({ kind: 'mission', id: m.id, name: `${m.name} UNLOCKED` });
        }
      }
    }

    if (mission.rules?.final && result.completed) {
      this.data.championship.completed = true;
    }

    this.save.markDirty();

    const payload = {
      credits, xp, stars, starsGained, previousStars,
      records, unlocks, levelsGained,
      totalStars: newTotal, totalCredits: this.data.credits,
      rating: this.rating, level: this.data.level,
    };
    this.bus.emit('progress:result', payload);
    return payload;
  }

  // ------------------------------------------------------------------- secrets
  /**
   * Banks a hidden beacon (spec §151). Pays on the spot rather than at the end of a
   * run, because most of them are found in free flight where there is no end of a run,
   * and the whole set earns the livery nothing else sells.
   */
  findSecret(id) {
    if (!SECRET_BY_ID[id] || this.data.secrets.includes(id)) return null;
    this.data.secrets.push(id);
    this.data.credits += SECRET_REWARD.credits;
    this.data.xp += SECRET_REWARD.xp;
    while (this.data.xp >= xpForLevel(this.data.level + 1)) this.data.level++;

    const complete = this.data.secrets.length >= SECRETS.length;
    const paint = complete && this.unlockPaint('beacon') ? 'beacon' : null;
    this.save.markDirty();

    const payload = {
      id, name: SECRET_BY_ID[id].name,
      found: this.data.secrets.length, total: SECRETS.length,
      credits: SECRET_REWARD.credits, xp: SECRET_REWARD.xp,
      complete, paint,
    };
    this.bus.emit('secret:found', payload);
    return payload;
  }

  get secretsFound() {
    return this.data.secrets.length;
  }

  /** The beacons still out there, for the hint list in the statistics screen. */
  secretsRemaining() {
    return SECRETS.filter((s) => !this.data.secrets.includes(s.id));
  }

  /**
   * True once, the first time it is asked after the final mission is won: the campaign
   * celebration and the free flight unlock both hang off it (spec §150).
   */
  claimChampionCelebration() {
    if (!this.data.championship.completed || this.data.championship.celebrated) return false;
    this.data.championship.celebrated = true;
    this.save.markDirty();
    return true;
  }

  get isChampion() {
    return !!this.data.championship.completed;
  }

  /** Free flight still pays, at a much lower rate, so exploring is not wasted (§49). */
  recordFreeFlight({ distance = 0, nearMisses = 0, tricks = 0, score = 0 }) {
    const credits = Math.round(distance / 900) + nearMisses * 6 + tricks * 20;
    const xp = Math.round(distance / 1400) + tricks * 6;
    this.data.credits += credits;
    this.data.xp += xp;
    this.data.stats.distance += distance;
    this.data.stats.nearMisses += nearMisses;
    this.data.stats.tricks += tricks;
    while (this.data.xp >= xpForLevel(this.data.level + 1)) this.data.level++;
    this.save.markDirty();
    return { credits, xp };
  }

  addFlightTime(seconds, distance) {
    this.data.stats.flightTime += seconds;
    this.data.stats.distance += distance;
  }

  nextMission(afterId) {
    const index = MISSIONS.findIndex((m) => m.id === afterId);
    for (let i = index + 1; i < MISSIONS.length; i++) {
      if (this.isMissionUnlocked(MISSIONS[i].id)) return MISSIONS[i].id;
    }
    // Otherwise the first unlocked mission that is not yet three-starred.
    for (const m of MISSIONS) {
      if (this.isMissionUnlocked(m.id) && (this.data.stars[m.id] ?? 0) < 3) return m.id;
    }
    return null;
  }

  /** The mission the FLY button should launch. */
  recommendedMission() {
    for (const m of MISSIONS) {
      if (this.isMissionUnlocked(m.id) && !this.data.completed[m.id]) return m.id;
    }
    for (const m of MISSIONS) {
      if (this.isMissionUnlocked(m.id) && (this.data.stars[m.id] ?? 0) < 3) return m.id;
    }
    return MISSIONS[0].id;
  }
}
