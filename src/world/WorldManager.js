import * as THREE from 'three';
import { damp, lerp } from '../core/MathUtils.js';
import { REGIONS, REGION_ORDER, TILE, regionAt } from '../data/regions.js';
import { createTerrain, createWater, createUrbanTexture, collisionHeight, terrainHeight, isOnRunway, isWater } from './Terrain.js';
import { generateCity, PERIOD, ROAD } from './CityGenerator.js';
import { createLandmarks, animateLandmarks } from './Landmarks.js';
import { createAtmosphere, applyAerialPerspective } from './Atmosphere.js';
import { createSkyDome, updateSkyDome } from './SkyDome.js';
import { TimeOfDay } from './TimeOfDay.js';
import { WeatherManager } from './WeatherManager.js';
import { TrafficManager } from './TrafficManager.js';
import { DestructionField } from './Destructible.js';
import { DebrisField } from '../fx/Debris.js';

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
    // Bound once: the destruction integrator asks for the floor under every falling
    // body every frame, and a fresh closure per frame would be garbage per frame.
    this._groundAt = (x, z) => collisionHeight(x, z);
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

    // Structures that can actually come apart, plus the debris they shed. The field
    // is built even when nothing in the world is destructible, so the update path and
    // the impact route are the same either way.
    this.debris = new DebrisField({ scene: this.scene, settings: this.settings });
    this.destruction = new DestructionField({ bus: this.bus, debris: this.debris });
    for (const b of this.landmarks.userData.destructibles ?? []) this.destruction.add(b);
    // Collisions are already routed through this object, so this is where an impact
    // becomes structural damage. The flight model stays ignorant of buildings.
    this._offImpact = this.bus.on('flight:impact', (e) => this.destruction.impact(e));

    // Sun-lit haze on everything that fills the screen. Applied after the meshes exist
    // so it picks up the materials they actually ended up with.
    this.atmosphere = createAtmosphere();
    const hazed = new Set();
    for (const root of [this.city, this.terrain, this.landmarks, this.debris.mesh]) {
      root?.traverse?.((o) => {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m || hazed.has(m) || m.fog === false) continue;
          hazed.add(m);
          applyAerialPerspective(m, this.atmosphere);
        }
      });
    }
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
      destructibles: this.destruction.buildings.length,
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
    this.destruction.update(dt, this._focus, this._groundAt);
    animateLandmarks(this.landmarks, dt, this.elapsed);
    updateSkyDome(this.sky, this.camera, dt);

    const tod = this.timeOfDay;
    const wx = this.weather;
    const night = tod.night;
    this.traffic.setNight(night);

    // --- aerial perspective: the haze is lit by the sun of the moment
    if (this.atmosphere) {
      this.atmosphere.uSunDirView.value
        .copy(tod.sunDir)
        .transformDirection(this.camera.matrixWorldInverse);
      this.atmosphere.uHazeSun.value.copy(tod.state.sunColor).lerp(tod.state.fog, 0.35);
      this.atmosphere.uHazeSky.value.copy(tod.state.fog);
      // Strong when the sun is low and the air is thick, gone at night.
      const lowSun = 1 - Math.abs(tod.sunDir.y);
      this.atmosphere.uHazeStrength.value =
        (0.25 + 0.55 * lowSun) * (1 - night) * (0.6 + 0.4 * (1 - wx.current.visibility));
    }

    // --- grade: what the camera does with the light it was given
    const dusk = Math.max(0, 1 - Math.abs(tod.sunDir.y) * 3.2) * (1 - night);
    this.grade = {
      // Open up after dark so the city reads, close down under a noon sun.
      exposure: 1.02 + night * 0.22 - Math.max(0, tod.sunDir.y) * 0.1,
      // The city is its own light source at night, so that is when bloom earns its
      // keep. Eased back from 0.5 now that lit windows, lamp heads and roof beacons
      // emit above 1.0 on purpose: the bloom has far more to find than it used to,
      // and at the old strength the windows fused into one glowing smear.
      bloom: 0.28 + night * 0.34 + dusk * 0.18,
      // Shadows toward the sky, highlights toward the sun.
      lift: {
        r: tod.state.ambColor.r * 0.045 * (0.4 + night),
        g: tod.state.ambColor.g * 0.045 * (0.4 + night),
        b: tod.state.ambColor.b * 0.05 * (0.5 + night),
      },
      gain: {
        r: 1 + dusk * 0.06,
        g: 1 + dusk * 0.015,
        b: 1 - dusk * 0.03 + night * 0.03,
      },
      saturation: 1.04 + dusk * 0.12 - night * 0.06,
      vignette: 0.3 + night * 0.12,
    };

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
      // Drives the rooftop obstruction beacons, which have to keep blinking whether
      // or not the clock is running.
      this.city.userData.facadeUniforms.uTime.value = this.elapsed;
      // The sodium wash off the streets dims in rain, because there is less dry road
      // left to bounce it.
      this.city.userData.facadeUniforms.uCityGlow.value
        .set(0xff9a4a).multiplyScalar(0.55 + 0.45 * wx.current.visibility);
      // Daylight bounce onto the walls, cut back at night so the lit windows carry
      // the contrast instead of competing with a grey wash.
      this.city.userData.facadeUniforms.uFill.value =
        0.34 * (1 - night) * (0.55 + 0.45 * wx.current.visibility) + 0.035 * night;
      // Glazing reflects the sky and the sun of this minute, from the same keyframes
      // that light the scene, so a tower at dusk is orange on the west face.
      this.city.userData.facadeUniforms.uSkyTint.value
        .copy(tod.state.zenith).lerp(tod.state.horizon, 0.55)
        .lerp(new THREE.Color(wx.current.hazeTint), 0.3 * (1 - wx.current.visibility));
      this.city.userData.facadeUniforms.uSunTint.value.copy(tod.state.sunColor);
    }
    if (this.terrain.userData.uniforms) {
      this.terrain.userData.uniforms.uNight.value = night;
    }
    // The twin towers carry their own curtain wall, so they need telling about dusk
    // separately from the instanced city.
    if (this.landmarks?.userData.towerMaterial) {
      this.landmarks.userData.towerMaterial.userData.uniforms.uTowerNight.value = night;
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

  /**
   * Puts every destructible back the way it was built.
   *
   * A mission is flown against the intact city - its route was validated against it -
   * so damage does not carry between runs. Called at the start of a flight rather
   * than at the end of one, so the wreckage is still there while the results screen
   * orbits it.
   */
  resetDestruction() {
    this.destruction?.reset();
  }

  /** Environment block for FlightModel. */
  environment() {
    return this.weather.environment();
  }

  get night() {
    return this.timeOfDay?.night ?? 0;
  }

  dispose() {
    this._offImpact?.();
    this.debris?.dispose();
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
