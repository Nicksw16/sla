import { formatNumber, formatTime } from '../core/MathUtils.js';
import { MISSIONS, MISSION_BY_ID } from '../data/missions.js';
import { AIRCRAFT, AIRCRAFT_ORDER, statBars } from '../data/aircraft.js';
import { REGIONS, REGION_ORDER } from '../data/regions.js';
import { PAINTS, PAINT_ORDER, UPGRADE_TREE, UPGRADE_ORDER, applyUpgrades, upgradeCost } from '../data/upgrades.js';
import { weatherLabel } from '../data/weather.js';
import { QUALITY_PRESETS } from '../core/Settings.js';

/**
 * Screens: menu, map, hangar, statistics, settings, briefing, results, pause
 * (spec §95-98, §106-107, §121).
 *
 * All of it is DOM over the canvas rather than drawn in 3D: text stays crisp, the
 * layout reflows on a phone, and none of it competes with the flight loop for frame
 * time. Every list is generated from the same data the game runs on, so a new mission
 * appears in the map screen without touching this file (§92).
 */
const SCREENS = ['loading', 'main', 'map', 'hangar', 'stats', 'settings', 'results', 'pause', 'briefing'];

export class UIManager {
  constructor({ bus, settings, progression, hangar, input }) {
    this.bus = bus;
    this.settings = settings;
    this.progression = progression;
    this.hangar = hangar;
    this.input = input;

    this.screens = {};
    for (const id of SCREENS) this.screens[id] = document.getElementById(`screen-${id}`);
    this.current = 'loading';
    this.selectedMission = null;
    this.selectedRegion = 'central';
    this.selectedAircraft = progression.data.activeAircraft;
    this.hangarTab = 'upgrades';
    this.settingsReturn = 'main';
    this._onAction = null;

    this.el = {
      loaderFill: document.getElementById('loader-fill'),
      loadingText: document.getElementById('loading-text'),
      pilotStrip: document.getElementById('pilot-strip'),
      mapGrid: document.getElementById('map-grid'),
      mapLegend: document.getElementById('map-legend'),
      mapSummary: document.getElementById('map-summary'),
      missionList: document.getElementById('mission-list'),
      missionDetail: document.getElementById('mission-detail'),
      hangarList: document.getElementById('hangar-list'),
      hangarCredits: document.getElementById('hangar-credits'),
      hangarName: document.getElementById('hangar-name'),
      hangarRole: document.getElementById('hangar-role'),
      hangarStats: document.getElementById('hangar-stats'),
      hangarUpgrades: document.getElementById('hangar-upgrades'),
      hangarPaint: document.getElementById('hangar-paint'),
      hangarAction: document.getElementById('hangar-action'),
      statsBody: document.getElementById('stats-body'),
      settingsBody: document.getElementById('settings-body'),
      resultsTitle: document.getElementById('results-title'),
      resultsStars: document.getElementById('results-stars'),
      resultsRows: document.getElementById('results-rows'),
      resultsRecords: document.getElementById('results-records'),
      resultsUnlocks: document.getElementById('results-unlocks'),
      pauseMission: document.getElementById('pause-mission'),
      briefingType: document.getElementById('briefing-type'),
      briefingName: document.getElementById('briefing-name'),
      briefingDesc: document.getElementById('briefing-desc'),
      briefingGoals: document.getElementById('briefing-goals'),
      briefingConditions: document.getElementById('briefing-conditions'),
      fade: document.getElementById('fade'),
      fps: document.getElementById('fps'),
    };

    this._bindClicks();
  }

  /** Single delegated click handler: every button carries a data-action. */
  _bindClicks() {
    document.getElementById('screens').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      this.bus.emit('ui:click', {});
      this._onAction?.(btn.dataset.action, btn.dataset);
    });
    for (const tab of document.querySelectorAll('.hangar-tabs .tab')) {
      tab.addEventListener('click', () => {
        this.hangarTab = tab.dataset.tab;
        this.bus.emit('ui:click', {});
        this.renderHangar();
      });
    }
  }

  onAction(fn) {
    this._onAction = fn;
  }

  show(name) {
    for (const id of SCREENS) this.screens[id]?.classList.toggle('active', id === name);
    this.current = name;
    this.bus.emit('ui:screen', { screen: name });
  }

  hideAll() {
    for (const id of SCREENS) this.screens[id]?.classList.remove('active');
    this.current = null;
  }

  get isMenuOpen() {
    return this.current !== null && this.current !== 'loading';
  }

  setLoading(fraction, text) {
    if (this.el.loaderFill) this.el.loaderFill.style.width = `${Math.round(fraction * 100)}%`;
    if (text && this.el.loadingText) this.el.loadingText.textContent = text;
  }

  async fade(to, ms = 280) {
    this.el.fade.classList.toggle('on', to === 'out');
    await new Promise((r) => setTimeout(r, ms));
  }

  setFps(value, visible) {
    this.el.fps.classList.toggle('hidden', !visible);
    if (visible) this.el.fps.textContent = `${Math.round(value)} FPS`;
  }

  // ------------------------------------------------------------------ main menu
  renderMain() {
    const p = this.progression;
    const nextXp = p.xpForNextLevel;
    this.el.pilotStrip.innerHTML = `
      <b>${p.rating.name}</b> · LEVEL ${p.level} · ${formatNumber(p.credits)} CR
      · ${p.totalStars}/${p.maxStars} ★ · ${Math.round((p.xpIntoLevel / Math.max(1, nextXp)) * 100)}% TO NEXT LEVEL`;
    const fly = this.screens.main.querySelector('[data-action="continue"]');
    const rec = MISSION_BY_ID[p.recommendedMission()];
    if (fly && rec) fly.textContent = `FLY — ${rec.name}`;
  }

  // ------------------------------------------------------------------ map screen
  renderMap() {
    const p = this.progression;
    this.el.mapSummary.innerHTML = `<b>${p.totalStars}</b>/${p.maxStars} ★ · ${formatNumber(p.credits)} CR · ${p.rating.name}`;

    // District grid, laid out exactly as the world is (§96).
    this.el.mapGrid.innerHTML = '';
    for (const id of REGION_ORDER) {
      const st = p.regionStatus(id);
      const cell = document.createElement('div');
      cell.className = `map-cell${st.unlocked ? '' : ' locked'}${id === this.selectedRegion ? ' selected' : ''}`;
      cell.dataset.action = 'selectRegion';
      cell.dataset.region = id;
      cell.innerHTML = `
        <div class="mc-name">${st.unlocked ? '' : '🔒 '}${st.region.short}</div>
        <div class="mc-meta">${st.missions} MISSION${st.missions === 1 ? '' : 'S'}</div>
        ${st.unlocked ? `<div class="mc-stars">${st.starsEarned}/${st.starsAvailable} ★</div>` : ''}
        ${st.unlocked ? '' : `<div class="mc-lock">NEEDS ${st.need} ★<br>${st.shortfall} MORE</div>`}`;
      this.el.mapGrid.appendChild(cell);
    }
    this.el.mapLegend.innerHTML = `
      Districts unlock with stars, not with levels.<br>
      Selected: <b style="color:var(--cyan)">${REGIONS[this.selectedRegion].name}</b> — ${REGIONS[this.selectedRegion].landmarkNote}`;

    this.renderMissionList();
  }

  renderMissionList() {
    const p = this.progression;
    const list = MISSIONS.filter((m) => m.region === this.selectedRegion);
    this.el.missionList.innerHTML = '';
    if (!list.length) {
      this.el.missionList.innerHTML = '<div class="mc-meta" style="padding:12px">No missions in this district yet.</div>';
    }
    for (const m of list) {
      const unlocked = p.isMissionUnlocked(m.id);
      const stars = p.data.stars[m.id] ?? 0;
      const row = document.createElement('div');
      row.className = `mission-row${unlocked ? '' : ' locked'}${stars > 0 ? ' done' : ''}${m.id === this.selectedMission ? ' selected' : ''}`;
      if (unlocked) {
        row.dataset.action = 'selectMission';
        row.dataset.mission = m.id;
      }
      row.innerHTML = `
        <span class="mr-type">${m.type}</span>
        <span class="mr-name">${unlocked ? m.name : '🔒 ' + m.name}</span>
        <span class="mr-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
      this.el.missionList.appendChild(row);
    }
    if (!this.selectedMission || !list.some((m) => m.id === this.selectedMission)) {
      const first = list.find((m) => p.isMissionUnlocked(m.id));
      this.selectedMission = first?.id ?? null;
    }
    this.renderMissionDetail();
  }

  renderMissionDetail() {
    const m = MISSION_BY_ID[this.selectedMission];
    if (!m) {
      this.el.missionDetail.innerHTML = '<p>Select a mission.</p>';
      return;
    }
    const p = this.progression;
    const rec = p.data.records[m.id] ?? {};
    const stars = p.data.stars[m.id] ?? 0;
    const unlocked = p.isMissionUnlocked(m.id);
    this.el.missionDetail.innerHTML = `
      <div class="md-type">${m.type} · ${REGIONS[m.region].short}</div>
      <h3>${m.name}</h3>
      <p>${m.desc}</p>
      <div class="md-goal">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)} earned</div>
      <table class="md-table">
        <tr><td>Checkpoints</td><td>${m.route.length}</td></tr>
        <tr><td>Gate size</td><td>${Math.min(...m.route.map((c) => c.radius))} m</td></tr>
        ${m.timeLimit ? `<tr><td>Time limit</td><td>${m.timeLimit} s</td></tr>` : ''}
        ${m.stars.time ? `<tr><td>Three-star time</td><td>${m.stars.time[0]} s</td></tr>` : ''}
        ${m.stars.score ? `<tr><td>Three-star score</td><td>${formatNumber(m.stars.score[0])}</td></tr>` : ''}
        <tr><td>Conditions</td><td>${weatherLabel(m.conditions.weather)} · ${String(Math.floor(m.conditions.hour)).padStart(2, '0')}:00</td></tr>
        ${m.rules?.rival ? `<tr><td>Rival</td><td>${m.rules.rival.name}</td></tr>` : ''}
        <tr><td>Reward</td><td>${formatNumber(m.rewards.credits)} CR</td></tr>
        ${rec.time !== undefined ? `<tr><td>Your best time</td><td>${formatTime(rec.time)}</td></tr>` : ''}
        ${rec.score !== undefined ? `<tr><td>Your best score</td><td>${formatNumber(rec.score)}</td></tr>` : ''}
      </table>
      <button class="menu-btn primary" data-action="brief" data-mission="${m.id}" ${unlocked ? '' : 'disabled'}
        style="width:100%">${unlocked ? 'BRIEFING' : `NEEDS ${m.unlock.stars} ★`}</button>`;
  }

  // -------------------------------------------------------------------- briefing
  renderBriefing(missionId) {
    const m = MISSION_BY_ID[missionId];
    if (!m) return;
    this.selectedMission = missionId;
    this.el.briefingType.textContent = `${m.type} · ${REGIONS[m.region].name}`;
    this.el.briefingName.textContent = m.name;
    this.el.briefingDesc.textContent = m.desc;
    const rec = this.progression.data.records[m.id] ?? {};
    this.el.briefingGoals.innerHTML = `
      <div class="bg-row"><span class="bg-k">Checkpoints</span><span class="bg-v">${m.route.length}</span></div>
      <div class="bg-row"><span class="bg-k">Smallest gate</span><span class="bg-v">${Math.min(...m.route.map((c) => c.radius))} m</span></div>
      ${m.timeLimit ? `<div class="bg-row"><span class="bg-k">Time limit</span><span class="bg-v">${m.timeLimit} s</span></div>` : ''}
      ${m.stars.time ? `<div class="bg-row"><span class="bg-k">★★★ time</span><span class="bg-v">${m.stars.time[0]} s</span></div>` : ''}
      ${m.stars.score ? `<div class="bg-row"><span class="bg-k">★★★ score</span><span class="bg-v">${formatNumber(m.stars.score[0])}</span></div>` : ''}
      ${rec.time !== undefined ? `<div class="bg-row"><span class="bg-k">Your best</span><span class="bg-v">${formatTime(rec.time)}</span></div>` : ''}
      <div class="bg-row"><span class="bg-k">Aircraft</span><span class="bg-v">${this.progression.activeSpec().name}</span></div>`;
    const chips = [
      weatherLabel(m.conditions.weather),
      `${String(Math.floor(m.conditions.hour)).padStart(2, '0')}:${String(Math.round((m.conditions.hour % 1) * 60)).padStart(2, '0')}`,
      ...(m.rules?.maxAltitude ? [`CEILING ${m.rules.maxAltitude} m`] : []),
      ...(m.rules?.requireLanding ? ['LANDING REQUIRED'] : []),
      ...(m.rules?.requireTakeoff ? ['TAKEOFF REQUIRED'] : []),
      ...(m.rules?.rival ? [`RIVAL: ${m.rules.rival.name}`] : []),
    ];
    this.el.briefingConditions.innerHTML = chips.map((c) => `<span class="cond-chip">${c}</span>`).join('');
  }

  // ---------------------------------------------------------------------- hangar
  renderHangar() {
    const p = this.progression;
    this.el.hangarCredits.innerHTML = `<b>${formatNumber(p.credits)}</b> CR · ${p.totalStars} ★ · ${p.tokenCount} TOKENS`;

    this.el.hangarList.innerHTML = '';
    for (const id of AIRCRAFT_ORDER) {
      const st = p.aircraftStatus(id);
      const active = p.data.activeAircraft === id;
      const card = document.createElement('div');
      card.className = `hangar-card${id === this.selectedAircraft ? ' selected' : ''}${active ? ' active-craft' : ''}`;
      card.dataset.action = 'selectHangarAircraft';
      card.dataset.aircraft = id;
      const meta = st.owned
        ? (active ? 'ACTIVE' : 'OWNED')
        : st.starsOk ? `${formatNumber(st.price)} CR` : `NEEDS ${st.spec.requiresStars} ★`;
      card.innerHTML = `<div class="hc-name">${st.owned ? '' : '🔒 '}${st.spec.name}</div><div class="hc-meta">${meta}</div>`;
      this.el.hangarList.appendChild(card);
    }

    const id = this.selectedAircraft;
    const st = p.aircraftStatus(id);
    const levels = p.data.upgrades[id] ?? {};
    const upgraded = applyUpgrades(st.spec, levels);
    this.el.hangarName.textContent = st.spec.name;
    this.el.hangarRole.textContent = st.spec.role;

    // Stat bars show the stock value with the upgrade gain stacked on top.
    const stock = statBars(st.spec);
    const withUp = statBars(upgraded);
    this.el.hangarStats.innerHTML = stock.map((s, i) => {
      const gain = Math.max(0, withUp[i].value - s.value);
      return `<div class="stat-line">
        <span class="stat-name">${s.key}</span>
        <span class="stat-track">
          <span class="stat-val" style="width:${(s.value * 100).toFixed(0)}%"></span>
          <span class="stat-val up" style="position:absolute;left:${(s.value * 100).toFixed(0)}%;width:${(gain * 100).toFixed(0)}%"></span>
        </span>
        <span class="stat-num">${withUp[i].display}</span>
      </div>`;
    }).join('') + `<div class="ur-desc" style="margin-top:6px">${st.spec.blurb}</div>`;

    // Tabs.
    for (const tab of document.querySelectorAll('.hangar-tabs .tab')) {
      tab.classList.toggle('active', tab.dataset.tab === this.hangarTab);
    }
    this.el.hangarUpgrades.classList.toggle('hidden', this.hangarTab !== 'upgrades');
    this.el.hangarPaint.classList.toggle('hidden', this.hangarTab !== 'paint');

    this.el.hangarUpgrades.innerHTML = UPGRADE_ORDER.map((key) => {
      const tree = UPGRADE_TREE[key];
      const lvl = p.upgradeLevel(id, key);
      const cost = upgradeCost(key, lvl);
      const pips = Array.from({ length: tree.levels }, (_, i) => `<span class="ur-pip${i < lvl ? ' on' : ''}"></span>`).join('');
      const affordable = cost !== null && p.credits >= cost;
      const label = cost === null ? 'MAX' : `${formatNumber(cost)} CR`;
      return `<div class="upgrade-row">
        <div class="ur-info"><div class="ur-name">${tree.name}</div><div class="ur-desc">${tree.desc}</div></div>
        <div class="ur-pips">${pips}</div>
        <button class="ur-buy" data-action="buyUpgrade" data-aircraft="${id}" data-key="${key}"
          ${st.owned && cost !== null && affordable ? '' : 'disabled'}>${label}</button>
      </div>`;
    }).join('') + (st.owned ? '' : '<div class="ur-desc" style="margin-top:10px">Buy this aircraft to upgrade it.</div>');

    const currentPaint = p.data.paint[id] ?? 'factory';
    this.el.hangarPaint.innerHTML = `<div class="paint-grid">${PAINT_ORDER.map((pid) => {
      const paint = PAINTS[pid];
      const owned = p.data.unlockedPaints.includes(pid);
      const body = `#${paint.body.toString(16).padStart(6, '0')}`;
      const trim = `#${paint.trim.toString(16).padStart(6, '0')}`;
      const locked = !owned;
      const label = owned ? paint.name : (paint.requiresTokens ? `${paint.requiresTokens} TOKENS` : `${formatNumber(paint.cost)} CR`);
      return `<div class="paint-swatch${pid === currentPaint ? ' selected' : ''}${locked ? ' locked' : ''}"
        style="background:linear-gradient(135deg,${body} 60%,${trim} 60%)"
        data-action="${owned ? 'applyPaint' : 'buyPaint'}" data-paint="${pid}">
        <span class="paint-name">${label}</span></div>`;
    }).join('')}</div>`;

    const action = this.el.hangarAction;
    if (!st.owned) {
      action.textContent = st.starsOk
        ? (st.affordable ? `BUY — ${formatNumber(st.price)} CR` : `NEED ${formatNumber(st.price - p.credits)} MORE CR`)
        : `LOCKED — ${st.shortfall} MORE ★`;
      action.dataset.action = 'buyAircraft';
      action.dataset.aircraft = id;
      action.disabled = !st.canBuy;
    } else if (p.data.activeAircraft === id) {
      action.textContent = 'ACTIVE AIRCRAFT';
      action.dataset.action = 'noop';
      action.disabled = true;
    } else {
      action.textContent = 'SELECT THIS AIRCRAFT';
      action.dataset.action = 'selectAircraft';
      action.dataset.aircraft = id;
      action.disabled = false;
    }

    this.hangar.setAircraft(upgraded, currentPaint);
  }

  // ----------------------------------------------------------------- statistics
  renderStats() {
    const s = this.progression.data.stats;
    const p = this.progression;
    const hours = Math.floor(s.flightTime / 3600);
    const mins = Math.floor((s.flightTime % 3600) / 60);
    const tiles = [
      ['PILOT RATING', p.rating.name],
      ['LEVEL', String(p.level)],
      ['STARS', `${p.totalStars} / ${p.maxStars}`],
      ['CREDITS', formatNumber(p.credits)],
      ['MISSIONS FLOWN', formatNumber(s.missionsFlown)],
      ['MISSIONS COMPLETED', formatNumber(s.missionsCompleted)],
      ['PERFECT RUNS', formatNumber(s.perfectRuns)],
      ['FLIGHT TIME', `${hours}h ${mins}m`],
      ['DISTANCE FLOWN', `${(s.distance / 1000).toFixed(1)} km`],
      ['CHECKPOINTS', formatNumber(s.checkpoints)],
      ['NEAR MISSES', formatNumber(s.nearMisses)],
      ['AEROBATICS', formatNumber(s.tricks)],
      ['LANDINGS', formatNumber(s.landings)],
      ['CRASHES', formatNumber(s.crashes)],
      ['TOP SPEED', `${Math.round(s.topSpeed * 3.6)} km/h`],
      ['AIRCRAFT OWNED', `${p.data.ownedAircraft.length} / ${AIRCRAFT_ORDER.length}`],
    ];
    const records = MISSIONS.filter((m) => this.progression.data.records[m.id]);
    this.el.statsBody.innerHTML = `
      <div class="stat-grid">${tiles.map(([k, v]) => `
        <div class="stat-tile"><div class="st-label">${k}</div><div class="st-value">${v}</div></div>`).join('')}</div>
      ${records.length ? `<table class="records-table">
        <thead><tr><th>MISSION</th><th>★</th><th>BEST TIME</th><th>BEST SCORE</th><th>BEST COMBO</th><th>TOP SPEED</th></tr></thead>
        <tbody>${records.map((m) => {
          const r = this.progression.data.records[m.id];
          const st = this.progression.data.stars[m.id] ?? 0;
          return `<tr><td>${m.name}</td><td>${'★'.repeat(st)}</td>
            <td>${r.time !== undefined ? formatTime(r.time) : '—'}</td>
            <td>${r.score !== undefined ? formatNumber(r.score) : '—'}</td>
            <td>${r.combo !== undefined ? '×' + r.combo.toFixed(2) : '—'}</td>
            <td>${r.topSpeed ? Math.round(r.topSpeed * 3.6) + ' km/h' : '—'}</td></tr>`;
        }).join('')}</tbody></table>` : '<p class="screen-sub" style="margin-top:20px">No records yet. Fly something.</p>'}`;
  }

  // ------------------------------------------------------------------- settings
  renderSettings() {
    const s = this.settings;
    const seg = (key, options, current) => `<div class="seg">${options.map(([v, label]) =>
      `<button class="${v === current ? 'on' : ''}" data-action="set" data-key="${key}" data-value="${v}">${label}</button>`).join('')}</div>`;
    const slider = (key, min, max, step, value, format) => `
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"
        data-action="slide" data-key="${key}">
      <span class="setting-num" id="num-${key}">${format(value)}</span>`;
    const pct = (v) => `${Math.round(v * 100)}%`;

    this.el.settingsBody.innerHTML = `
      <div class="setting-group"><h3>GRAPHICS</h3>
        <div class="setting-row"><span class="setting-label">Quality<small>Draw distance, shadows, traffic and particle budget</small></span>
          <span class="setting-control">${seg('quality', Object.entries(QUALITY_PRESETS).map(([k, v]) => [k, v.label]), s.get('quality'))}</span></div>
        <div class="setting-row"><span class="setting-label">Field of view</span>
          <span class="setting-control">${slider('fov', 55, 95, 1, s.get('fov'), (v) => `${v}°`)}</span></div>
        <div class="setting-row"><span class="setting-label">Show frame rate</span>
          <span class="setting-control">${seg('showFps', [[false, 'OFF'], [true, 'ON']], s.get('showFps'))}</span></div>
      </div>

      <div class="setting-group"><h3>AUDIO</h3>
        <div class="setting-row"><span class="setting-label">Master volume</span>
          <span class="setting-control">${slider('masterVolume', 0, 1, 0.05, s.get('masterVolume'), pct)}</span></div>
        <div class="setting-row"><span class="setting-label">Music</span>
          <span class="setting-control">${slider('musicVolume', 0, 1, 0.05, s.get('musicVolume'), pct)}</span></div>
        <div class="setting-row"><span class="setting-label">Effects</span>
          <span class="setting-control">${slider('sfxVolume', 0, 1, 0.05, s.get('sfxVolume'), pct)}</span></div>
      </div>

      <div class="setting-group"><h3>FLYING</h3>
        <div class="setting-row"><span class="setting-label">Flight assistance<small>Shapes your control inputs; the aircraft itself is unchanged</small></span>
          <span class="setting-control">${seg('assist', [['off', 'OFF'], ['low', 'LOW'], ['high', 'HIGH']], s.get('assist'))}</span></div>
        <div class="setting-row"><span class="setting-label">Sensitivity</span>
          <span class="setting-control">${slider('sensitivity', 0.4, 2, 0.05, s.get('sensitivity'), (v) => `×${Number(v).toFixed(2)}`)}</span></div>
        <div class="setting-row"><span class="setting-label">Invert pitch</span>
          <span class="setting-control">${seg('invertPitch', [[false, 'OFF'], [true, 'ON']], s.get('invertPitch'))}</span></div>
        <div class="setting-row"><span class="setting-label">Mouse steering<small>Cursor acts as a self-centring stick</small></span>
          <span class="setting-control">${seg('mouseSteering', [[false, 'OFF'], [true, 'ON']], s.get('mouseSteering'))}</span></div>
        <div class="setting-row"><span class="setting-label">Controller vibration</span>
          <span class="setting-control">${seg('vibration', [[false, 'OFF'], [true, 'ON']], s.get('vibration'))}</span></div>
      </div>

      <div class="setting-group"><h3>CAMERA AND HUD</h3>
        <div class="setting-row"><span class="setting-label">Camera</span>
          <span class="setting-control">${seg('cameraMode', [['chase', 'CHASE'], ['far', 'FAR'], ['cockpit', 'COCKPIT']], s.get('cameraMode'))}</span></div>
        <div class="setting-row"><span class="setting-label">Camera shake<small>Set to zero if motion bothers you</small></span>
          <span class="setting-control">${slider('cameraShake', 0, 1.5, 0.1, s.get('cameraShake'), (v) => Number(v).toFixed(1))}</span></div>
        <div class="setting-row"><span class="setting-label">HUD size</span>
          <span class="setting-control">${seg('hudScale', [['small', 'S'], ['normal', 'M'], ['large', 'L']], s.get('hudScale'))}</span></div>
        <div class="setting-row"><span class="setting-label">Minimap</span>
          <span class="setting-control">${seg('minimap', [[false, 'OFF'], [true, 'ON']], s.get('minimap'))}</span></div>
      </div>

      <div class="setting-group"><h3>CONTROLS</h3>
        <div class="setting-row"><span class="setting-label">Keyboard<small>${this._bindingSummary()}</small></span>
          <span class="setting-control"></span></div>
        <div class="setting-row"><span class="setting-label">Gamepad<small>Left stick flies, right stick rudders, triggers for throttle, A or RB for turbo</small></span>
          <span class="setting-control">${this.input?.gamepadConnected ? 'CONNECTED' : 'NOT DETECTED'}</span></div>
      </div>

      <div class="setting-group"><h3>DATA</h3>
        <div class="setting-row"><span class="setting-label">Reset settings<small>Controls and progress are kept</small></span>
          <span class="setting-control"><button class="ur-buy" data-action="resetSettings">RESET</button></span></div>
        <div class="setting-row"><span class="setting-label">Erase progress<small>Cannot be undone</small></span>
          <span class="setting-control"><button class="ur-buy" data-action="wipeSave">ERASE</button></span></div>
      </div>`;

    // Live slider feedback.
    for (const input of this.el.settingsBody.querySelectorAll('input[type="range"]')) {
      input.addEventListener('input', () => {
        const key = input.dataset.key;
        const value = Number(input.value);
        this.settings.set(key, value);
        const num = document.getElementById(`num-${key}`);
        if (num) {
          num.textContent = key.endsWith('Volume') ? `${Math.round(value * 100)}%`
            : key === 'fov' ? `${value}°`
              : key === 'sensitivity' ? `×${value.toFixed(2)}`
                : value.toFixed(1);
        }
      });
    }
  }

  _bindingSummary() {
    return 'W/S throttle · A/D roll · ↑/↓ pitch · Q/E rudder · SHIFT turbo · SPACE airbrake · Z recover · C camera · V look back · R reset · M map · H hud · ESC pause';
  }

  // -------------------------------------------------------------------- results
  renderResults(result, progressPayload) {
    const success = result.completed;
    this.el.resultsTitle.textContent = success ? 'MISSION COMPLETE' : (result.reason ?? 'MISSION FAILED');
    this.el.resultsTitle.classList.toggle('fail', !success);

    const stars = result.stars ?? 0;
    this.el.resultsStars.innerHTML = [0, 1, 2].map((i) =>
      `<span class="star${i < stars ? ' on' : ''}" style="animation-delay:${i * 0.14}s">★</span>`).join('');

    const b = result.summary?.breakdown ?? {};
    const rows = [];
    if (success) {
      rows.push(['TIME', formatTime(result.time)]);
      if (result.rivalTime) rows.push([result.rivalName ?? 'RIVAL', formatTime(result.rivalTime)]);
      if (result.beatRival) rows.push(['RESULT', 'YOU WON']);
    } else {
      rows.push(['CHECKPOINTS', `${result.checkpointsPassed} / ${result.checkpointsTotal}`]);
      rows.push(['TIME FLOWN', formatTime(result.time)]);
    }
    rows.push(['CHECKPOINTS', formatNumber(b.checkpoints ?? 0)]);
    if (b.precision) rows.push(['PRECISION', formatNumber(b.precision)]);
    if (b.speed) rows.push(['SPEED', formatNumber(b.speed)]);
    if (b.nearMiss) rows.push(['NEAR MISSES', formatNumber(b.nearMiss)]);
    if (b.tricks) rows.push(['AEROBATICS', formatNumber(b.tricks)]);
    if (b.landing) rows.push(['LANDING', formatNumber(b.landing)]);
    if (b.timeBonus) rows.push(['TIME REMAINING', formatNumber(b.timeBonus)]);
    if (b.perfect) rows.push(['PERFECT RUN', formatNumber(b.perfect)]);
    if (b.penalties) rows.push(['DAMAGE', formatNumber(b.penalties)]);
    rows.push(['BEST COMBO', `×${(result.summary?.combo ?? 1).toFixed(2)}`]);

    this.el.resultsRows.innerHTML = rows.map(([k, v]) =>
      `<div class="rr"><span class="rr-k">${k}</span><span>${v}</span></div>`).join('') +
      `<div class="rr total"><span class="rr-k">SCORE</span><span>${formatNumber(result.score)}</span></div>` +
      (progressPayload ? `<div class="rr"><span class="rr-k">EARNED</span><span>+${formatNumber(progressPayload.credits)} CR · +${formatNumber(progressPayload.xp)} XP</span></div>` : '');

    this.el.resultsRecords.innerHTML = (progressPayload?.records ?? []).map((r) => {
      const value = r.key === 'TIME' ? formatTime(r.value) : formatNumber(r.value);
      return `<div class="record-line">NEW ${r.key} RECORD — ${value}</div>`;
    }).join('');

    const unlockLines = (progressPayload?.unlocks ?? []).map((u) => `<div class="unlock-line">UNLOCKED — ${u.name}</div>`);
    for (const lvl of progressPayload?.levelsGained ?? []) unlockLines.push(`<div class="unlock-line">LEVEL ${lvl}</div>`);
    this.el.resultsUnlocks.innerHTML = unlockLines.join('');

    const next = this.screens.results.querySelector('[data-action="next"]');
    if (next) {
      const nextId = this.progression.nextMission(result.missionId);
      next.textContent = nextId ? `NEXT — ${MISSION_BY_ID[nextId].name}` : 'MENU';
      next.dataset.mission = nextId ?? '';
      next.disabled = !nextId;
    }
  }

  renderPause(status) {
    this.el.pauseMission.textContent = status?.name
      ? `${status.name} — ${status.checkpointIndex}/${status.checkpointTotal} checkpoints`
      : '';
  }
}
