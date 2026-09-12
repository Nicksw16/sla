import { clamp } from './MathUtils.js';

const KEY = 'skylineflight.settings.v1';

export const QUALITY_PRESETS = {
  low: {
    label: 'LOW',
    renderScale: 0.72,
    shadows: false,
    shadowSize: 1024,
    drawDistance: 3400,
    buildingDetail: 0.5,
    trafficDensity: 0.35,
    particles: 0.4,
    antialias: false,
    cityLights: false,
  },
  medium: {
    label: 'MEDIUM',
    renderScale: 0.88,
    shadows: true,
    shadowSize: 1024,
    drawDistance: 5000,
    buildingDetail: 0.75,
    trafficDensity: 0.65,
    particles: 0.7,
    antialias: false,
    cityLights: true,
  },
  high: {
    label: 'HIGH',
    renderScale: 1,
    shadows: true,
    shadowSize: 2048,
    drawDistance: 6800,
    buildingDetail: 1,
    trafficDensity: 1,
    particles: 1,
    antialias: true,
    cityLights: true,
  },
  ultra: {
    label: 'ULTRA',
    renderScale: 1,
    shadows: true,
    shadowSize: 4096,
    drawDistance: 8600,
    buildingDetail: 1.25,
    trafficDensity: 1.3,
    particles: 1.3,
    antialias: true,
    cityLights: true,
  },
};

export const DEFAULT_SETTINGS = {
  quality: 'high',
  renderScaleBias: 1,
  fpsCap: 0, // 0 = uncapped (rely on rAF)
  showFps: false,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  sensitivity: 1,
  invertPitch: false,
  mouseSteering: false,
  assist: 'low', // off | low | high
  cameraMode: 'chase', // chase | cockpit | far
  cameraShake: 1,
  fov: 70,
  hudScale: 'normal', // small | normal | large
  minimap: true,
  navLine: false,
  vibration: true,
  bindings: null, // filled by Input from its defaults
};

/**
 * Player-facing options, persisted separately from progress so that a wiped
 * save never costs the player their control setup.
 */
export class Settings {
  constructor() {
    this.data = { ...DEFAULT_SETTINGS };
    this.listeners = new Set();
    this.load();
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
    for (const fn of this.listeners) fn(key, value);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get preset() {
    return QUALITY_PRESETS[this.data.quality] ?? QUALITY_PRESETS.high;
  }

  /** Effective render scale, combining the quality preset and the auto-tuner bias. */
  get renderScale() {
    return clamp(this.preset.renderScale * this.data.renderScaleBias, 0.5, 1);
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (k in parsed) this.data[k] = parsed[k];
        }
      }
    } catch (err) {
      console.warn('[Settings] could not read stored settings, using defaults', err);
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (err) {
      // Private browsing or a full quota: the game must keep running regardless.
      console.warn('[Settings] could not persist settings', err);
    }
  }

  resetToDefaults() {
    const bindings = this.data.bindings;
    this.data = { ...DEFAULT_SETTINGS, bindings };
    this.save();
    for (const fn of this.listeners) fn('*', null);
  }
}
