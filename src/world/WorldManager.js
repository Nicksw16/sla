import * as THREE from 'three';
import { damp, lerp } from '../core/MathUtils.js';
import { REGIONS, REGION_ORDER, TILE, regionAt } from '../data/regions.js';
import { createTerrain, createWater, createUrbanTexture, collisionHeight, terrainHeight, isOnRunway, isWater } from './Terrain.js';
import { generateCity, PERIOD, ROAD } from './CityGenerator.js';
import { createLandmarks, animateLandmarks } from './Landmarks.js';
import { createSkyDome, updateSkyDome } from './SkyDome.js';
import { TimeOfDay } from './TimeOfDay.js';
import { WeatherManager } from './WeatherManager.js';
import { TrafficManager } from './TrafficManager.js';

/**
 * Owns the world and is the single collision authority.
 *
 * Everything that needs to know where the ground is, whether a wall is in the way,
 * or how close the nearest building is, asks this object. FlightModel holds it as an
 * opaque "collider" and knows nothing about buildings, terrain or traffic — which is
 * what let the flight model be unit tested against a flat plane (spec §90-91).
 */
export class WorldManager {
  constructor({ scene, camera, settings, bus, seed = 20260912 }) {
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;
    this.bus = bus;
    this.seed = seed;
    this.elapsed = 0;
    this._hitOut = { normal: new THREE.Vector3(), point: new THREE.Vector3() };
    this._focus = new THREE.Vector3();
    this.timeScale = 0;
  }

  async build(onProgress = () => {}) {
    const step = async (label, fraction, fn) => {
      onProgress(fraction, label);
      // Yield to the browser so the loading bar actually paints between stages.
      await new Promise((r) => setTimeout(r, 0));
      return fn();
    };

    this.urbanTexture = await step('MAPPING DISTRICTS', 0.05, () =>
      createUrbanTexture(REGIONS, REGION_ORDER, TILE));

    this.terrain = await step('RAISING TERRAIN', 0.15, () =>
      createTerrain({ urbanTexture: this.urbanTexture, period: PERIOD, roadWidth: ROAD }));
    this.scene.add(this.terrain);

    this.water = await step('FLOODING THE BAY', 0.35, () => createWater());
    this.scene.add(this.water);

    const city = await step('BUILDING SKYLINE CITY', 0.45, () =>
      generateCity({ seed: this.seed, detail: this.settings.preset.buildingDetail }));
    this.city = city.group;
    this.grid = city.grid;
    this.cityStats = city.stats;
    this.scene.add(this.city);

    this.landmarks = await step('RAISING LANDMARKS', 0.7, () => createLandmarks(this.grid));
    this.scene.add(this.landmarks);

    this.sky = await step('LIGHTING THE SKY', 0.82, () => createSkyDome());
    this.scene.add(this.sky);

    this.timeOfDay = await step('SETTING THE SUN', 0.88, () =>
      new TimeOfDay({ scene: this.scene, settings: this.settings }));

    this.weather = await step('CHECKING THE WEATHER', 0.93, () =>
      new WeatherManager({ scene: this.scene, bus: this.bus, settings: this.settings }));

    this.traffic = await step('OPENING THE ROADS', 0.97, () =>
      new TrafficManager({ scene: this.scene, settings: this.settings, seed: this.seed + 7 }));

    this.scene.fog = new THREE.Fog(0xbdd6e8, 400, this.settings.preset.drawDistance);
    // Set when conditions change instantly, so the visibility arrives with them.
    this._snapFog = true;
    this.applyQuality();
    this.timeOfDay.setHour(12.5);
    onProgress(1, 'READY');

    this.bus.emit('world:ready', {
      buildings: this.cityStats.buildings,
      colliders: this.grid.count,
    });
    return this;
  }

  applyQuality() {
    const preset = this.settings.preset;
    const far = preset.drawDistance;
    this.camera.far = far * 1.35;
    this.camera.updateProjectionMatrix();
    if (this.scene.fog) this.scene.fog.far = far;
    this.timeOfDay?.applyQuality();
  }

  setConditions({ weather = 'clear', hour = 12.5, instant = true, timeScale = 0 } = {}) {
    this.weather?.set(weather, { instant });
    this.timeOfDay?.setHour(hour);
    this.timeScale = timeScale;
    // An instant change has to carry the visibility with it. The fog range is damped,
    // so without this a mission briefed as fog opens at clear-weather draw distance and
    // closes in over the first two seconds of the run.
    if (instant) this._snapFog = true;
  }

  // ------------------------------------------------------------- collider API
  groundHeight(x, z) {
    return collisionHeight(x, z);
  }

  isRunway(x, z) {
    return isOnRunway(x, z);
  }

  /** 1 when flying along the runway axis, falling off toward the sides. */
  runwayAlignment(heading) {
    return Math.max(Math.cos(heading - Math.PI / 2), Math.cos(heading + Math.PI / 2));
  }

  sampleObstacle(position, radius) {
    const air = this.traffic?.sampleAir(position, radius);
    if (air) return air;
    return this.grid.sample(position, radius, this._hitOut);
  }

  proximity(position, maxDist) {
    const a = this.grid.nearest(position, maxDist);
    const b = this.traffic?.nearestAir(position, maxDist);
    if (a && b) return a.distance <= b.distance ? a : b;
    return a ?? b;
  }

  regionAt(x, z) {
    return regionAt(x, z);
  }

  isOverWater(x, z) {
    return isWater(x, z);
  }

  terrainAt(x, z) {
    return terrainHeight(x, z);
  }

  // ----------------------------------------------------------------- per frame
  update(dt, focus) {
    this.elapsed += dt;
    this._focus.copy(focus ?? this.camera.position);

    this.timeOfDay.advance(dt, this.timeScale);
    this.timeOfDay.follow(this._focus);
    this.weather.update(dt, this.camera.position);
    this.traffic.update(dt, this._focus, this.elapsed);
    animateLandmarks(this.landmarks, dt, this.elapsed);
    updateSkyDome(this.sky, this.camera, dt);

    const tod = this.timeOfDay;
    const wx = this.weather;
    const night = tod.night;

    // --- sky uniforms follow the lighting rig and the cloud deck
    const su = this.sky.userData.uniforms;
    su.uSunDir.value.copy(tod.sunDir);
    su.uZenith.value.copy(tod.state.zenith);
    su.uHorizon.value.copy(tod.state.horizon);
    su.uGroundHaze.value.copy(tod.state.fog);
    su.uSunColor.value.copy(tod.state.sunColor);
    su.uStars.value = night * (1 - wx.current.cloudCover * 0.9);
    su.uCloudCover.value = wx.current.cloudCover;
    su.uCloudTint.value.copy(tod.state.sunColor).lerp(new THREE.Color(0x6c7480), 0.45 + wx.current.rain * 0.3);
    su.uSunSize.value = 1 - wx.current.cloudCover * 0.85;
    su.uFlash.value = wx.flash;

    // --- fog: the visibility knob weather actually turns (§62)
    const preset = this.settings.preset;
    const targetFar = preset.drawDistance * lerp(0.22, 1, wx.current.visibility);
    const fog = this.scene.fog;
    fog.color.copy(tod.state.fog).lerp(new THREE.Color(wx.current.hazeTint), 0.45 + (1 - wx.current.visibility) * 0.4);
    fog.far = this._snapFog ? targetFar : damp(fog.far, targetFar, 1.5, dt);
    this._snapFog = false;
    fog.near = fog.far * 0.04;
    // Lightning lights the whole scene, not just the sky.
    if (wx.flash > 0.01) fog.color.addScalar(wx.flash * 0.25);

    // --- night: city windows and street lights
    if (this.city.userData.facadeUniforms) {
      this.city.userData.facadeUniforms.uNight.value = night;
    }
    if (this.terrain.userData.uniforms) {
      this.terrain.userData.uniforms.uNight.value = night;
    }

    // --- water reacts to sun and sea state
    const wu = this.water.userData.uniforms;
    wu.uTime.value = this.elapsed;
    wu.uSun.value.copy(tod.sunDir);
    wu.uSky.value.copy(tod.state.horizon);
    wu.uShallow.value.copy(tod.state.fog).lerp(new THREE.Color(0x2e6f80), 0.7);
    wu.uDeep.value.set(0x0e2a3c).lerp(tod.state.fog, night * 0.5);
    wu.uChop.value = 0.5 + wx.current.wind / 14;
  }

  /** Environment block for FlightModel. */
  environment() {
    return this.weather.environment();
  }

  get night() {
    return this.timeOfDay?.night ?? 0;
  }

  dispose() {
    this.terrain?.userData.dispose?.();
    this.water?.userData.dispose?.();
    this.city?.userData.dispose?.();
    this.landmarks?.userData.dispose?.();
    this.sky?.userData.dispose?.();
    this.weather?.dispose();
    this.traffic?.dispose();
    this.urbanTexture?.dispose();
    for (const o of [this.terrain, this.water, this.city, this.landmarks, this.sky]) {
      if (o) this.scene.remove(o);
    }
  }
}
