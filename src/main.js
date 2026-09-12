import * as THREE from 'three';

import { EventBus } from './core/EventBus.js';
import { Settings } from './core/Settings.js';
import { SaveSystem } from './core/SaveSystem.js';
import { Input } from './core/Input.js';
import { clamp01, damp } from './core/MathUtils.js';

import { WorldManager } from './world/WorldManager.js';
import { SecretBeacons } from './world/SecretBeacons.js';
import { FlightModel } from './flight/FlightModel.js';
import { TurboSystem } from './flight/TurboSystem.js';
import { DamageSystem } from './flight/DamageSystem.js';
import { TrickDetector } from './flight/TrickDetector.js';
import { buildAircraft, animateAircraft, disposeAircraft } from './flight/AircraftFactory.js';
import { CameraController } from './camera/CameraController.js';

import { CheckpointManager } from './mission/CheckpointManager.js';
import { ScoreSystem } from './mission/ScoreSystem.js';
import { MissionManager, MISSION_STATE } from './mission/MissionManager.js';
import { Progression } from './progression/Progression.js';

import { ParticleSystem, ContrailSystem, EffectsDirector } from './fx/Effects.js';
import { AudioManager } from './audio/AudioManager.js';
import { HUD } from './ui/HUD.js';
import { Minimap } from './ui/Minimap.js';
import { HangarScene } from './ui/HangarScene.js';
import { UIManager } from './ui/UIManager.js';

import { MISSION_BY_ID } from './data/missions.js';
import { REGIONS } from './data/regions.js';
import { SECRETS } from './data/secrets.js';

/**
 * SKYLINE FLIGHT — application shell.
 *
 * This file owns the render loop and the top-level state machine and nothing else.
 * Every rule about how the game behaves lives in the system that owns it; this is the
 * wiring between them (spec §90-91: no god script). The order of the update calls is
 * the one place where that wiring is load-bearing, so it is spelled out in `_tick`.
 */
/** Particle tint for a found beacon; a Color because that is what the pool expects. */
const SECRET_TINT = new THREE.Color(0x63ecff);

const STATE = {
  LOADING: 'loading',
  MENU: 'menu',
  MAP: 'map',
  HANGAR: 'hangar',
  STATS: 'stats',
  SETTINGS: 'settings',
  BRIEFING: 'briefing',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OUTRO: 'outro',
  RESULTS: 'results',
  FREEFLIGHT: 'freeflight',
  STORE: 'store',
  CHAMPION: 'champion',
};

class Game {
  constructor() {
    this.bus = new EventBus();
    this.settings = new Settings();
    this.save = new SaveSystem(this.bus);
    this.save.load();
    this.progression = new Progression({ save: this.save, bus: this.bus });
    this.input = new Input(this.settings, this.bus);

    this.state = STATE.LOADING;
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frameTimes = [];
    this.fps = 60;
    this._autoQualityTimer = 0;
    this._statsAccum = 0;
    this._lastDistance = 0;
    this._outroTimer = 0;
    this._freeFlightRespawn = 0;
    this._pendingResult = null;
    this._aircraftModel = null;
    this._hangarDrag = null;

    this._initRenderer();
    this._initScene();
    this._initUI();
    this._boot();
  }

  // ------------------------------------------------------------------ renderer
  _initRenderer() {
    this.canvas = document.getElementById('viewport');
    const preset = this.settings.preset;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x0a1220, 1);
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this._applyRenderScale();

    window.addEventListener('resize', () => this._onResize());
  }

  _applyRenderScale() {
    const scale = this.settings.renderScale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  _onResize() {
    this._applyRenderScale();
    if (this.camera) {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    }
    this.hangar?.resize(window.innerWidth, window.innerHeight);
    this.particles?.resize(window.innerHeight);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.settings.get('fov'), window.innerWidth / window.innerHeight, 0.6, 9000,
    );
    this.scene.add(this.camera);
  }

  _initUI() {
    this.hangar = new HangarScene({ renderer: this.renderer });
    this.hangar.resize(window.innerWidth, window.innerHeight);
    this.ui = new UIManager({
      bus: this.bus,
      settings: this.settings,
      progression: this.progression,
      hangar: this.hangar,
      input: this.input,
    });
    this.ui.onAction((action, data) => this._onUiAction(action, data));
    this.ui.show('loading');

    // Hangar orbit controls.
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.state !== STATE.HANGAR) return;
      this._hangarDrag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => { this._hangarDrag = null; });
    window.addEventListener('pointermove', (e) => {
      if (!this._hangarDrag || this.state !== STATE.HANGAR) return;
      this.hangar.orbit(e.clientX - this._hangarDrag.x, e.clientY - this._hangarDrag.y);
      this._hangarDrag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('wheel', (e) => {
      if (this.state === STATE.HANGAR) this.hangar.zoom(Math.sign(e.deltaY));
    }, { passive: true });

    // Audio can only start from a gesture, so the first interaction unlocks it.
    const unlock = () => {
      this.audio?.resume();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.settings.onChange((key) => this._onSettingChanged(key));
  }

  _onSettingChanged(key) {
    // The resolution bias changes often - the watchdog can touch it every few
    // seconds - and only needs the renderer resized. Rebuilding the world's quality
    // settings on every nudge tears down and recreates the shadow map, which is
    // exactly the wrong thing to do to a machine that is already struggling.
    if (key === 'renderScaleBias') {
      this._applyRenderScale();
    }
    if (key === 'quality') {
      this._applyRenderScale();
      this.renderer.shadowMap.enabled = this.settings.preset.shadows;
      this.world?.applyQuality();
    }
    if (key === 'fov') {
      this.cameraController.baseFov = this.settings.get('fov');
    }
    if (key === 'assist') {
      this.flight?.setAssist(this.settings.get('assist'));
    }
    if (key === 'cameraMode') {
      this.cameraController?.setMode(this.settings.get('cameraMode'));
    }
  }

  // ---------------------------------------------------------------------- boot
  async _boot() {
    this.world = new WorldManager({
      scene: this.scene,
      camera: this.camera,
      settings: this.settings,
      bus: this.bus,
    });
    await this.world.build((fraction, label) => this.ui.setLoading(fraction, label));

    // Flight stack.
    this.spec = this.progression.activeSpec();
    this.flight = new FlightModel({
      spec: this.spec,
      bus: this.bus,
      collider: this.world,
      assist: this.settings.get('assist'),
    });
    this.turbo = new TurboSystem({ spec: this.spec, bus: this.bus });
    this.damage = new DamageSystem({ spec: this.spec, bus: this.bus });
    this.tricks = new TrickDetector({ bus: this.bus });
    this.cameraController = new CameraController({
      camera: this.camera, settings: this.settings, bus: this.bus,
    });

    // Mission stack.
    this.checkpoints = new CheckpointManager({ scene: this.scene, bus: this.bus });
    this.score = new ScoreSystem({ bus: this.bus });
    this.missions = new MissionManager({
      bus: this.bus, world: this.world, checkpoints: this.checkpoints, score: this.score,
      flight: this.flight, turbo: this.turbo, damage: this.damage, tricks: this.tricks,
      scene: this.scene,
    });

    // Hidden beacons: world furniture, but they pay into progression, so they are
    // built here and seeded from the save rather than owned by the world (§151).
    this.secrets = new SecretBeacons({ scene: this.scene, bus: this.bus });
    this.secrets.setFound(this.progression.data.secrets);

    // Presentation.
    this.particles = new ParticleSystem({ scene: this.scene, settings: this.settings });
    this.contrails = new ContrailSystem({ scene: this.scene });
    this.effects = new EffectsDirector({
      bus: this.bus, particles: this.particles, contrails: this.contrails, settings: this.settings,
    });
    this.audio = new AudioManager({ settings: this.settings, bus: this.bus });
    this.hud = new HUD({ bus: this.bus, settings: this.settings, camera: this.camera });
    this.minimap = new Minimap({ canvas: document.getElementById('minimap'), settings: this.settings });

    this._rebuildAircraftModel();
    this._wireEvents();

    // Park the camera somewhere photogenic for the menu backdrop.
    this.flight.reset({ position: new THREE.Vector3(600, 520, 1600), heading: Math.PI * 0.85 });
    this.world.setConditions({ weather: 'clear', hour: 17.6, instant: true, timeScale: 0 });

    this.ui.setLoading(1, 'READY');
    await new Promise((r) => setTimeout(r, 180));
    this._enterMenu();
    this.clock.start();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _rebuildAircraftModel() {
    if (this._aircraftModel) {
      this.scene.remove(this._aircraftModel);
      disposeAircraft(this._aircraftModel);
    }
    this.spec = this.progression.activeSpec();
    this._aircraftModel = buildAircraft(this.spec, this.progression.activePaint());
    this.scene.add(this._aircraftModel);
    this.flight.setSpec(this.spec);
    this.turbo.setSpec(this.spec);
    this.damage.setSpec(this.spec);
    this.audio?.setEngineKind(this.spec.model.engines === 'prop' ? 'prop' : 'jet');
    this.contrails?.reset(this.flight.position);
  }

  _wireEvents() {
    this.bus.on('mission:complete', (result) => this._onMissionEnded(result, true));
    this.bus.on('mission:failed', (result) => this._onMissionEnded(result, false));
    this.bus.on('ui:countdownBeep', (e) => this.audio?.countdownBeep(e.whole === 1));
    this.bus.on('damage:hit', (e) => {
      // Rumble scales with the hit, so a scrape and a wall feel different (§102).
      this.input.vibrate(clamp01(e.severity), 90 + e.severity * 180);
    });
    this.bus.on('turbo:start', () => this.input.vibrate(0.25, 140));
    this.bus.on('damage:destroyed', () => {
      // Free flight has no results screen to fall through to, so it respawns rather
      // than leaving the player parked in a wreck with nothing to press (§46).
      if (!this.missions.freeFlight) return;
      this._freeFlightRespawn = 2.6;
      this.cameraController.startCinematic(this.flight.position, { duration: 2.6, radius: 34, height: 12, spin: 0.9 });
    });
    this.bus.on('checkpoint:passed', () => this.input.vibrate(0.15, 70));
    this.bus.on('secret:reached', (e) => {
      // The beacon system only reports contact. Banking it, paying for it and deciding
      // whether that was the last one is progression's business.
      const payload = this.progression.findSecret(e.id);
      if (!payload) return;
      this.particles.burst('spark', e.position, 26, 16, { tint: SECRET_TINT });
      this.audio?.blip(880, 0.16, 'triangle', 0.22);
      this.audio?.blip(1320, 0.22, 'sine', 0.18);
      this.input.vibrate(0.3, 160);
      this.hud.toast(`${payload.name} FOUND — ${payload.found}/${payload.total}`, 'good', 3);
      if (payload.complete) {
        this.audio?.fanfare(true);
        this.hud.toast('EVERY BEACON FOUND — BEACON LIVERY UNLOCKED', 'good', 5);
      }
    });
  }

  // ------------------------------------------------------------- state changes
  _enterMenu() {
    this.state = STATE.MENU;
    this.missions.abort();
    this.hud.hide();
    this.ui.renderMain();
    this.ui.show('main');
    this.audio?.quietEngines();
    this.input.releaseMouseLock();
  }

  _enterScreen(state, screen, render) {
    this.state = state;
    this.hud.hide();
    render?.();
    this.ui.show(screen);
  }

  async _startMission(id) {
    const mission = MISSION_BY_ID[id];
    if (!mission) return;
    if (!this.progression.isMissionUnlocked(id)) return;

    await this.ui.fade('out', 260);
    this._rebuildAircraftModel();
    this.missions.start(id, { assist: this.settings.get('assist') });
    this.contrails.reset(this.flight.position);
    this.particles.clear();
    this.cameraController.stopCinematic();
    this.state = STATE.PLAYING;
    this.ui.hideAll();
    this.hud.show();
    this.audio?.resume();
    this.input.requestMouseLock(this.canvas);
    this._lastDistance = this.flight.distanceFlown;
    await this.ui.fade('in', 260);
  }

  async _startFreeFlight(setup = null) {
    await this.ui.fade('out', 260);
    if (setup?.aircraft && setup.aircraft !== this.progression.data.activeAircraft) {
      this.progression.selectAircraft(setup.aircraft);
    }
    this._rebuildAircraftModel();
    // A district start puts the player over its centre at a height that clears the
    // tallest thing in it; the default is the skyline view the menu camera orbits.
    const region = setup?.region ? REGIONS[setup.region] : null;
    const spawn = region
      ? { x: region.cx + 400, y: 620, z: region.cz + 900, heading: Math.PI }
      : { x: 600, y: 520, z: 1600, heading: Math.PI * 0.85 };
    this.missions.startFreeFlight({
      weather: setup?.weather ?? 'clear',
      hour: setup?.hour ?? 15.5,
      spawn,
      timeScale: 60,
    });
    this.contrails.reset(this.flight.position);
    this.particles.clear();
    this.state = STATE.PLAYING;
    this.ui.hideAll();
    this.hud.show();
    this.audio?.resume();
    this.input.requestMouseLock(this.canvas);
    this._lastDistance = this.flight.distanceFlown;
    await this.ui.fade('in', 260);
  }

  _pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.ui.renderPause(this.missions.status());
    this.ui.show('pause');
    this.audio?.quietEngines();
    this.input.releaseMouseLock();
  }

  _resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = STATE.PLAYING;
    this.ui.hideAll();
    this.hud.show();
    this.audio?.resume();
    this.input.requestMouseLock(this.canvas);
  }

  /**
   * A mission ending is not instant: a short orbit of the aircraft lets the moment
   * land before the numbers arrive (spec §47, §114).
   */
  _onMissionEnded(result, success) {
    if (this.state !== STATE.PLAYING && this.state !== STATE.PAUSED) return;
    this.input.releaseMouseLock();

    if (this.missions.freeFlight) return;

    const mission = MISSION_BY_ID[result.missionId];
    const payload = mission ? this.progression.recordResult(mission, result) : null;
    this._pendingResult = { result, payload };

    this.state = STATE.OUTRO;
    this._outroTimer = success ? 1.6 : 2.6;
    this.cameraController.startCinematic(this.flight.position, {
      duration: this._outroTimer + 0.4,
      radius: success ? 52 : 38,
      height: success ? 16 : 10,
      spin: success ? 0.55 : 0.9,
    });
    if (!success) this.audio?.quietEngines();
    document.getElementById('cinematic-bars')?.classList.remove('hidden');
  }

  /**
   * The one-off campaign celebration (spec §150). It replaces the results screen for
   * the run that wins the championship, because a results screen is what every other
   * mission ends with and this one should not feel like every other mission.
   */
  _showChampion() {
    const p = this.progression;
    document.getElementById('cinematic-bars')?.classList.add('hidden');
    this.state = STATE.CHAMPION;
    this.hud.hide();
    this.ui.renderChampion({
      stats: p.data.stats,
      totalStars: p.totalStars,
      maxStars: p.maxStars,
      rating: p.rating.name,
      secrets: p.secretsFound,
      secretsTotal: SECRETS.length,
    });
    this.ui.show('champion');
    this.cameraController.stopCinematic();
    this.audio?.fanfare(true);
    this.particles.burst('spark', this.flight.position, 48, 26, { tint: SECRET_TINT });
  }

  _showResults() {
    const { result, payload } = this._pendingResult ?? {};
    if (!result) return this._enterMenu();
    document.getElementById('cinematic-bars')?.classList.add('hidden');
    this.state = STATE.RESULTS;
    this.hud.hide();
    this.ui.renderResults(result, payload);
    this.ui.show('results');
    this.cameraController.stopCinematic();
  }

  // -------------------------------------------------------------- ui dispatch
  _onUiAction(action, data) {
    switch (action) {
      case 'continue':
        this._startMission(this.progression.recommendedMission());
        break;
      case 'map':
        this._enterScreen(STATE.MAP, 'map', () => this.ui.renderMap());
        break;
      case 'hangar':
        this.ui.selectedAircraft = this.progression.data.activeAircraft;
        this._enterScreen(STATE.HANGAR, 'hangar', () => this.ui.renderHangar());
        break;
      case 'store':
        this._enterScreen(STATE.STORE, 'store', () => this.ui.renderStore());
        break;
      case 'storeSelect':
        this.ui.storeAircraft = data.aircraft;
        this.ui.renderStore();
        break;
      case 'buyStoreAircraft': {
        const bought = this.progression.buyAircraft(data.aircraft);
        if (bought.ok) {
          this._rebuildAircraftModel();
          this.audio?.fanfare(true);
        }
        this.ui.renderStore();
        break;
      }
      case 'freeflight':
        this._enterScreen(STATE.FREEFLIGHT, 'freeflight', () => this.ui.renderFreeFlight());
        break;
      case 'ffSet':
        this.ui.setFreeFlight(data.key, data.value);
        break;
      case 'ffLaunch':
        this._startFreeFlight(this.ui.freeFlight);
        break;
      case 'stats':
        this._enterScreen(STATE.STATS, 'stats', () => this.ui.renderStats());
        break;
      case 'settings':
        this.ui.settingsReturn = this.state === STATE.PAUSED ? 'pause' : 'main';
        this._enterScreen(STATE.SETTINGS, 'settings', () => this.ui.renderSettings());
        break;
      case 'back':
        this._goBack();
        break;
      case 'selectRegion':
        this.ui.selectedRegion = data.region;
        this.ui.selectedMission = null;
        this.ui.renderMap();
        break;
      case 'selectMission':
        this.ui.selectedMission = data.mission;
        this.ui.renderMissionList();
        break;
      case 'brief':
        this._enterScreen(STATE.BRIEFING, 'briefing', () => this.ui.renderBriefing(data.mission));
        break;
      case 'launch':
        this._startMission(this.ui.selectedMission);
        break;
      case 'selectHangarAircraft':
        this.ui.selectedAircraft = data.aircraft;
        this.ui.renderHangar();
        break;
      case 'buyAircraft': {
        const out = this.progression.buyAircraft(data.aircraft);
        if (out.ok) this._rebuildAircraftModel();
        this.ui.renderHangar();
        break;
      }
      case 'selectAircraft':
        if (this.progression.selectAircraft(data.aircraft)) this._rebuildAircraftModel();
        if (this.state === STATE.STORE) { this.ui.renderStore(); break; }
        this.ui.renderHangar();
        break;
      case 'buyUpgrade':
        this.progression.buyUpgrade(data.aircraft, data.key);
        if (data.aircraft === this.progression.data.activeAircraft) this._rebuildAircraftModel();
        this.ui.renderHangar();
        break;
      case 'buyPaint':
        if (this.progression.buyPaint(data.paint).ok) this.progression.applyPaint(data.paint);
        this._rebuildAircraftModel();
        this.ui.renderHangar();
        break;
      case 'applyPaint':
        this.progression.applyPaint(data.paint);
        this._rebuildAircraftModel();
        this.ui.renderHangar();
        break;
      case 'set': {
        const raw = data.value;
        const value = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
        this.settings.set(data.key, value);
        this.ui.renderSettings();
        break;
      }
      case 'resetSettings':
        this.settings.resetToDefaults();
        this.ui.renderSettings();
        break;
      case 'wipeSave':
        this.save.wipe();
        this._rebuildAircraftModel();
        this.ui.renderSettings();
        this.bus.emit('ui:click', {});
        break;
      case 'resume':
        this._resume();
        break;
      case 'restart':
        this.ui.hideAll();
        this.hud.show();
        this.state = STATE.PLAYING;
        this.missions.restart();
        this.contrails.reset(this.flight.position);
        this.particles.clear();
        break;
      case 'quit':
        this._enterMenu();
        break;
      case 'retry':
        this._startMission(this._pendingResult?.result?.missionId ?? this.progression.recommendedMission());
        break;
      // Leaving the results of the run that won the championship goes through the
      // celebration once (spec §150). Retry is left alone: it is not leaving.
      case 'next':
      case 'tomenu': {
        if (this.state === STATE.RESULTS && this.progression.claimChampionCelebration()) {
          this._showChampion();
          break;
        }
        const id = action === 'next' ? data.mission : null;
        if (id) this._startMission(id);
        else this._enterMenu();
        break;
      }
      default:
        break;
    }
  }

  _goBack() {
    switch (this.state) {
      case STATE.SETTINGS:
        if (this.ui.settingsReturn === 'pause') {
          this.state = STATE.PAUSED;
          this.ui.show('pause');
        } else {
          this._enterMenu();
        }
        break;
      case STATE.BRIEFING:
        this._enterScreen(STATE.MAP, 'map', () => this.ui.renderMap());
        break;
      default:
        this._enterMenu();
        break;
    }
  }

  // ---------------------------------------------------------------- hotkeys
  _handleHotkeys() {
    if (this.input.wasPressed('pause')) {
      if (this.state === STATE.PLAYING) this._pause();
      else if (this.state === STATE.PAUSED) this._resume();
      else if (this.state !== STATE.MENU && this.state !== STATE.LOADING) this._goBack();
    }
    if (this.state !== STATE.PLAYING) return;

    if (this.input.wasPressed('camera')) this.cameraController.cycleMode();
    if (this.input.wasPressed('minimap')) this.settings.set('minimap', !this.settings.get('minimap'));
    if (this.input.wasPressed('hud')) {
      if (this.hud.visible) this.hud.hide(); else this.hud.show();
    }
    if (this.input.wasPressed('fps')) this.settings.set('showFps', !this.settings.get('showFps'));
    if (this.input.wasPressed('restart')) {
      // R recovers from a bad spot mid-run, or restarts if there is nothing to recover to.
      if (!this.missions.freeFlight && this.missions.state === MISSION_STATE.RUNNING) {
        this.missions.resetToCheckpoint();
      } else if (this.missions.freeFlight) {
        this.flight.reset({ position: new THREE.Vector3(600, 520, 1600), heading: Math.PI * 0.85 });
      }
    }
  }

  // ------------------------------------------------------------------- loop
  _tick() {
    const rawDt = this.clock.getDelta();
    // Clamp so a tab switch or a GC pause cannot advance the simulation by seconds.
    const dt = Math.min(rawDt, 1 / 15);
    this.elapsed += dt;

    this._trackPerformance(rawDt, dt);
    this.input.update(dt);
    this._handleHotkeys();

    if (this.state === STATE.HANGAR) {
      this.hangar.update(dt);
      this.hangar.render();
      this.input.endFrame();
      return;
    }

    const playing = this.state === STATE.PLAYING;
    const simulating = playing || this.state === STATE.OUTRO;

    if (simulating) {
      // Order matters here:
      //  1. turbo decides whether thrust is boosted this frame
      //  2. flight integrates, emitting impacts and near misses
      //  3. checkpoints test the segment the aircraft just flew
      //  4. mission rules and the clock react to all of it
      this.turbo.update(dt, playing && this.input.buttons.turbo && !this.damage.destroyed);
      if (!this.damage.destroyed) {
        this.flight.setEnvironment(this.world.environment());
        this.flight.update(dt, playing ? this.input : this._neutralInput(), this.turbo);
      }
      const live = this.flight.telemetry();
      this.tricks.update(dt, live);
      this.checkpoints.update(dt, this.flight.position, this.flight.velocity);
      this.score.update(dt, live);
      this.missions.update(dt);
    } else if (this.state === STATE.MENU || this.state === STATE.MAP || this.state === STATE.STATS
      || this.state === STATE.SETTINGS || this.state === STATE.BRIEFING || this.state === STATE.RESULTS) {
      // Slow orbit of the city behind the menus, so the game is never a still image.
      this._orbitMenuCamera(dt);
    }

    const telemetry = this.flight.telemetry();
    this.world.update(dt, this.flight.position);
    // Beacons turn wherever you are, but only a flying aircraft can collect one.
    this.secrets.update(dt, simulating ? this.flight.position : null);

    if (this.state !== STATE.PAUSED) {
      if (simulating) {
        this.cameraController.update(dt, this.flight, this.spec, playing ? this.input : this._neutralInput());
        this.effects.update(dt, this.flight, this.spec, telemetry, this.world);
      }
      this.particles.update(dt);
    }

    // Aircraft model follows the simulation.
    this._aircraftModel.position.copy(this.flight.position);
    this._aircraftModel.quaternion.copy(this.flight.quaternion);
    this._aircraftModel.visible = !this.damage.destroyed;
    animateAircraft(this._aircraftModel, dt, telemetry, this.flight.control);

    // Audio follows telemetry whenever the world is live. The mission status block
    // allocates, so it is built once per frame and shared with the HUD below.
    const status = simulating ? this.missions.status() : null;
    if (simulating) {
      this.audio?.update(dt, telemetry, this.turbo, {
        missionActive: !this.missions.freeFlight && this.missions.state === MISSION_STATE.RUNNING,
        timeRemaining: status.timeRemaining,
        hasTimeLimit: status.hasTimeLimit,
        rivalClose: !!status.rivalGap && Math.abs(status.rivalGap.metres) < 220,
      });
    }

    if (playing) this._updateHud(dt, telemetry, status);
    if (this.state === STATE.OUTRO) {
      this._outroTimer -= dt;
      if (this._outroTimer <= 0) this._showResults();
    }
    // The respawn belongs to the free-flight session it was armed in. Leaving free
    // flight before it fires - to the menu, or straight into a mission - cancels it:
    // otherwise it lands 2.6 s later and teleports the player off the runway and into
    // the air over downtown, mid-countdown.
    if (this._freeFlightRespawn > 0) {
      if (!this.missions.freeFlight) {
        this._freeFlightRespawn = 0;
      } else {
        this._freeFlightRespawn -= dt;
        if (this._freeFlightRespawn <= 0) this._respawnFreeFlight();
      }
    }

    this._accumulateStats(dt);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  /** Puts a crashed free-flight player back in the air over the city. */
  _respawnFreeFlight() {
    this._freeFlightRespawn = 0;
    this.damage.reset();
    this.turbo.reset(true);
    this.tricks.reset();
    this.cameraController.stopCinematic();
    this.flight.reset({ position: new THREE.Vector3(600, 520, 1600), heading: Math.PI * 0.85 });
    this.contrails.reset(this.flight.position);
    this.hud.toast('RECOVERED — BACK IN THE AIR', 'good', 2.4);
  }

  _neutralInput() {
    return {
      axes: { pitch: 0, roll: 0, yaw: 0, throttle: 0 },
      buttons: { turbo: false, brake: false, look: false, levelOut: false },
    };
  }

  _updateHud(dt, telemetry, status) {
    this.hud.update(dt, {
      status, telemetry,
      turbo: this.turbo, damage: this.damage, score: this.score,
      spec: this.spec, world: this.world,
    });
    this.minimap.draw({
      position: this.flight.position,
      heading: telemetry.heading,
      route: this.missions.mission?.route ?? null,
      checkpointIndex: this.checkpoints.index,
      rivalPosition: this.missions.rival?.position ?? null,
      region: this.world.regionAt(this.flight.position.x, this.flight.position.z),
    });
  }

  /** Menu backdrop: a slow circle above the city at golden hour. */
  _orbitMenuCamera(dt) {
    const t = this.elapsed * 0.035;
    const radius = 1750;
    this.camera.position.set(Math.cos(t) * radius, 640 + Math.sin(t * 0.7) * 90, Math.sin(t) * radius);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(60, 240, -40);
    this.camera.fov = damp(this.camera.fov, 58, 2, dt);
    this.camera.updateProjectionMatrix();
  }

  _accumulateStats(dt) {
    if (this.state !== STATE.PLAYING) return;
    this._statsAccum += dt;
    if (this._statsAccum >= 1) {
      const flown = this.flight.distanceFlown - this._lastDistance;
      this._lastDistance = this.flight.distanceFlown;
      this.progression.addFlightTime(this._statsAccum, Math.max(0, flown));
      this._statsAccum = 0;
      this.save.markDirty();
    }
  }

  /**
   * Frame-rate watchdog. If the frame rate sits low, the internal resolution comes
   * down before anything else, because a stable frame rate beats detail (spec §89, §129).
   */
  _trackPerformance(rawDt, dt) {
    if (rawDt > 0) {
      this.frameTimes.push(rawDt);
      if (this.frameTimes.length > 90) this.frameTimes.shift();
    }
    if (this.frameTimes.length >= 20) {
      const mean = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.fps = 1 / Math.max(mean, 1e-4);
    }
    this.ui.setFps(this.fps, this.settings.get('showFps'));

    // Real elapsed time, not the clamped simulation step. Using the clamped dt meant
    // that on the hardware that needs this watchdog most - where a frame takes half a
    // second - it took over half a minute of staring at a slideshow before the first
    // reduction, because each frame only advanced the timer by a sixteenth of a second.
    this._autoQualityTimer += rawDt;
    if (this._autoQualityTimer < 3 || this.frameTimes.length < 20) return;
    this._autoQualityTimer = 0;
    const bias = this.settings.get('renderScaleBias');
    if (this.fps < 40 && bias > 0.62) {
      this.settings.set('renderScaleBias', Math.max(0.6, bias - 0.12));
    } else if (this.fps > 58 && bias < 1) {
      this.settings.set('renderScaleBias', Math.min(1, bias + 0.06));
    }
  }
}

// Expose the instance for the headless smoke test to drive.
window.__skyline = new Game();
