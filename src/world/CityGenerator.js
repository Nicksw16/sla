import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { Rng, fbm2D } from '../core/Rng.js';
import { REGIONS, REGION_ORDER, TILE } from '../data/regions.js';
import { terrainHeight, isWater, isAirportClearZone, isParkZone } from './Terrain.js';

/**
 * Procedural city.
 *
 * Two rules drive the whole generator:
 *
 * 1. No repeated cubes (spec §156). Every building is composed from two to four
 *    stacked masses with setbacks, and optionally a spire, so silhouettes vary
 *    even though all of it draws from three instanced meshes.
 * 2. District identity has to survive being seen from 600 m up (§23). Height
 *    range, footprint size, density, palette and building *type* all change per
 *    district, so you can name where you are from the shape of the roofline.
 */

// Real downtown blocks are around 100 m across. Anything much larger and the
// core stops feeling dense no matter how many buildings you put in it.
export const BLOCK = 112;
export const ROAD = 36;
export const PERIOD = BLOCK + ROAD;

/**
 * Procedural facade material.
 *
 * Everything a building wears is drawn here rather than built: floor slabs, window
 * mullions, spandrel panels, corner pilasters, shopfronts at street level, mechanical
 * floors, roof gravel and parapets, dirt down the walls, and the lights coming on
 * floor by floor at night. None of it costs a triangle, which is the only reason a
 * city of three thousand buildings can afford this much detail (spec §89).
 *
 * Per instance the shader is told: the size of the mass in metres (so windows are the
 * same size on a shed and a tower), how glassy the district is, which style of
 * building it is, and whether this mass is the one standing on the ground.
 */
function facadeMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.72, metalness: 0.12, vertexColors: false,
  });
  mat.userData.uniforms = {
    uNight: { value: 0 },
    uWindowWarm: { value: new THREE.Color(0xffd49a) },
    uWindowCool: { value: new THREE.Color(0xcfe6ff) },
    // The sodium wash the streets throw back up. The lower floors of a real building
    // are never as black as the upper ones, because the road below is a light source
    // pointed at them - a survey of Madrid's night emissions put street lighting at
    // 54% of everything a city sends upward, against 9% for homes.
    uCityGlow: { value: new THREE.Color(0xff9a4a) },
    uTime: { value: 0 },
    // Bounce light onto vertical faces. Without it the shadowed side of every tower
    // is a black slab and none of the detail below survives to be seen.
    uFill: { value: 0.3 },
    // The sky of the moment, so glazing reflects the sky the player is flying under
    // rather than a colour chosen at build time.
    uSkyTint: { value: new THREE.Color(0x9dc4e8) },
    uSunTint: { value: new THREE.Color(0xfff2d8) },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = mat.userData.uniforms.uNight;
    shader.uniforms.uWindowWarm = mat.userData.uniforms.uWindowWarm;
    shader.uniforms.uWindowCool = mat.userData.uniforms.uWindowCool;
    shader.uniforms.uCityGlow = mat.userData.uniforms.uCityGlow;
    shader.uniforms.uTime = mat.userData.uniforms.uTime;
    shader.uniforms.uFill = mat.userData.uniforms.uFill;
    shader.uniforms.uSkyTint = mat.userData.uniforms.uSkyTint;
    shader.uniforms.uSunTint = mat.userData.uniforms.uSunTint;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSeed;
        attribute vec3 aSize;
        attribute float aGlass;
        attribute float aStyle;
        attribute float aGround;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying float vSeed;
        varying float vGlass;
        varying float vStyle;
        varying float vGround;
        varying float vWorldY;
        varying vec3 vFaceNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = position * aSize;
        vSize = aSize;
        vSeed = aSeed;
        vGlass = aGlass;
        vStyle = aStyle;
        vGround = aGround;
        vFaceNormal = normal;
        // Height above sea level, not above this mass. A tower is built from stacked
        // masses, so a mass that starts forty metres up has its own base at zero -
        // which would hand the street glow below to a floor nowhere near the street.
        vWorldY = (instanceMatrix * vec4(position, 1.0)).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        uniform vec3 uWindowWarm;
        uniform vec3 uWindowCool;
        uniform vec3 uCityGlow;
        uniform float uTime;
        uniform float uFill;
        uniform vec3 uSkyTint;
        uniform vec3 uSunTint;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying float vSeed;
        varying float vGlass;
        varying float vStyle;
        varying float vGround;
        varying float vWorldY;
        varying vec3 vFaceNormal;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        // A band that is 1 inside a stripe of the given width, with soft edges.
        float stripe(float v, float width, float soft) {
          return smoothstep(width + soft, width, abs(v));
        }`)
      // The facade pattern is worked out at the roughness hook, which runs before the
      // lighting does, so the same masks that draw a window can also tell the renderer
      // that the window is smooth glass and the wall around it is rough concrete. That
      // is what makes the two catch the sun differently instead of shading as one
      // plastic surface (spec §116).
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        vec3 an = abs(vFaceNormal);
        float heightAboveBase = vLocal.y + vSize.y * 0.5;
        bool onWall = an.y < 0.5;

        float fGlass = 0.0;   // 1 where the surface is glazing
        float fShop = 0.0;    // 1 in a lit shopfront
        float fLit = 0.0;     // how brightly this window burns after dark
        float fRoom = 0.0;    // per-room variation, for lamp colour and brightness
        float fBay = 0.0;
        float fFloor = 0.0;
        float fNear = 1.0;    // 1 close up, 0 once the pattern is sub-pixel
        float fWear = 1.0;    // concrete shading, dirt and banding
        float fStruct = 1.0;  // slabs, mullions, sills darkening the wall
        float fParapet = 0.0;

        if (onWall) {
          bool facingX = an.x > an.z;
          vec2 uvw = facingX ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y);
          float faceWidth = facingX ? vSize.z : vSize.x;

          // Window grid in metres. Houses get smaller, squarer windows than offices,
          // and industrial sheds get wide bands.
          float floorH = mix(3.7, 3.0, step(0.5, vStyle));
          float bayW = vStyle > 1.5 ? 6.2 : (vStyle > 0.5 ? 3.4 : 4.2);
          fFloor = floor(heightAboveBase / floorH);
          fBay = floor((uvw.x + faceWidth * 0.5) / bayW);
          float fy = fract(heightAboveBase / floorH);
          float fx = fract((uvw.x + faceWidth * 0.5) / bayW);

          // --- structure: floor slab, mullions between bays, a sill under the glass
          float slab = stripe(fy - 0.06, 0.055, 0.02);
          float mullion = stripe(fx - 0.5, 0.42, 0.03);
          float sill = stripe(fy - 0.2, 0.03, 0.015);

          float glassPane = step(0.2, fx) * step(fx, 0.8) * step(0.24, fy) * step(fy, 0.9);
          // Every eighth floor or so is plant: solid, louvred, no glass.
          float mech = step(0.93, hash12(vec2(fFloor * 0.37, vSeed)));
          glassPane *= 1.0 - mech;

          // The mass that stands on the ground gets a taller shopfront at street level.
          float street = vGround * (1.0 - step(5.2, heightAboveBase));
          fShop = street * step(1.0, heightAboveBase) * step(fx, 0.92) * step(0.08, fx);
          glassPane = max(glassPane, fShop);

          // Pattern fade. A window grid a few pixels wide turns into crawling speckle,
          // so as the bays shrink on screen the detail blends back into flat wall.
          //
          // The measure is the smaller of the two axes, not their sum. A facade seen
          // from above is foreshortened in one direction and perfectly readable in the
          // other, and summing threw away the readable axis - which made every tower
          // flatten into a blank slab the moment the player gained any altitude, which
          // is most of this game.
          float px = min(fwidth(uvw.x / bayW), fwidth(heightAboveBase / floorH));
          fNear = 1.0 - smoothstep(0.3, 0.95, px);
          fGlass = glassPane * fNear;

          // Concrete varies band to band, columns of cladding vary bay to bay, corners
          // read as structure, and dirt washes down from the sills.
          fWear = 0.93 + 0.09 * hash12(vec2(fFloor, vSeed * 3.1));
          fWear *= 0.96 + 0.06 * hash12(vec2(fBay * 1.7, vSeed));
          float edge = 1.0 - smoothstep(0.0, 0.6, min(faceWidth * 0.5 - abs(uvw.x), 99.0));
          fWear *= mix(1.0, 1.12, edge);
          float streak = hash12(vec2(floor(uvw.x * 1.7), vSeed * 7.0));
          fWear *= 1.0 - 0.06 * streak * smoothstep(0.9, 0.1, fy);
          // Ambient occlusion where the wall meets the ground: the street is a dark
          // trough and the bottom of a building sits in it.
          fWear *= mix(0.74, 1.0, smoothstep(0.0, 16.0, heightAboveBase));

          fStruct = 1.0 - 0.2 * slab * fNear * (1.0 - glassPane);
          fStruct *= 1.0 - 0.12 * mullion * fNear * (1.0 - glassPane);
          fStruct *= 1.0 - 0.16 * sill * fNear;
          fStruct *= 1.0 - 0.1 * mech * fNear;

          // --- which windows are burning
          //
          // The thing that made this read as noise rather than as a building was
          // lighting every window independently: real light comes from a room, and a room
          // is wider than one window. Following Chandler/Yang/Ren, rooms are defined
          // by quantising the bay index, and the whole room lights as one - so lit
          // windows arrive in runs of two and three, with dark runs between them,
          // which is the actual texture of a city at night.
          float roomSpan = 1.0 + floor(hash12(vec2(fFloor * 1.7, vSeed * 2.3)) * 3.0);
          float roomIdx = floor(fBay / roomSpan);
          float floorLife = hash12(vec2(fFloor * 2.3, vSeed * 5.0));
          fRoom = hash12(vec2(roomIdx * 3.1 + 0.5, fFloor + vSeed * 13.0));
          float occupancy = mix(0.62, 0.34, step(0.5, vStyle));
          // Smoothstep rather than step: the same threshold can then be walked over
          // dusk to bring the city up window by window instead of all at once.
          float litSharp = smoothstep(occupancy - 0.05, occupancy + 0.05,
            fRoom * 0.62 + floorLife * 0.38) * glassPane;

          // Blinds. A quarter of lit windows have one part-drawn, which breaks the
          // pane into a bright strip and a dim one - without this every lit window is
          // an identical filled rectangle, and a wall of identical rectangles is what
          // made the old city look like a spreadsheet.
          float blindRoll = hash12(vec2(fBay * 5.7 + 1.3, fFloor + vSeed * 4.0));
          float blindDrop = step(0.70, blindRoll) * (0.30 + 0.45 * fract(blindRoll * 17.0));
          float paneY = clamp((fy - 0.24) / 0.66, 0.0, 1.0);
          litSharp *= mix(1.0, smoothstep(blindDrop - 0.04, blindDrop + 0.02, 1.0 - paneY), fNear);

          // Interior depth: the ceiling of a lit room is the brightest part of it and
          // the floor falls away into shadow, so the pane is graded rather than flat.
          litSharp *= mix(1.0, 0.55 + 0.75 * paneY, fNear * 0.85);
          // Far away the windows are sub-pixel and collapse into one average, which has
          // to be weighted by how much of the wall is actually glass. Emitting the
          // per-window brightness across the whole facade lit the distant city like
          // daylight - a block of towers read as a pale speckled slab instead of a dark
          // mass with points of light in it.
          float glassFraction = vStyle > 1.5 ? 0.16 : (vStyle > 0.5 ? 0.22 : 0.34);
          float litSoft = (1.0 - occupancy) * glassFraction;
          fLit = mix(litSoft, litSharp, fNear);
        } else {
          vec2 rp = vec2(vLocal.x, vLocal.z);
          vec2 halfSize = vec2(vSize.x, vSize.z) * 0.5;
          fParapet = 1.0 - smoothstep(0.0, 1.4, min(halfSize.x - abs(rp.x), halfSize.y - abs(rp.y)));
        }

        // Glass is smooth and a little metallic so it takes a specular highlight;
        // concrete is rough and takes none. Wet weather polishes both.
        roughnessFactor = mix(0.86, 0.14, fGlass);
        if (!onWall) roughnessFactor = 0.92 - 0.25 * fParapet;`)
      // metalnessFactor is declared by the chunk after this one, so it is set there.
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(0.03, 0.55, fGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (onWall) {
          // The district palettes were chosen when a facade was one flat colour; with
          // slabs, mullions and glazing drawn on top they need lifting to keep their
          // hue instead of reading as shadow.
          vec3 wall = diffuseColor.rgb * 1.22 * fWear;

          // Glazing reflects the sky it is actually standing under. The tint comes from
          // the same keyframes that light the scene, so the two can never disagree.
          vec3 glassCol = mix(uSkyTint * 0.34, uSkyTint * 0.5, vGlass);
          float fres = pow(1.0 - abs(dot(normalize(vFaceNormal), vec3(0.0, 1.0, 0.0))), 2.0);
          glassCol += uSunTint * fres * (1.0 - uNight) * 0.1 * (0.4 + vGlass);
          glassCol *= mix(1.0, 0.42, uNight);

          vec3 lit_wall = mix(wall, glassCol, fGlass) * fStruct;
          // What is left at distance: the average of wall and glass, which is what the
          // eye sees of a facade from half a kilometre anyway.
          diffuseColor.rgb = mix(mix(wall, glassCol, 0.42 * (0.5 + vGlass * 0.5)), lit_wall, fNear);

          // --- what colour the light in a room actually is
          //
          // One white was the flattest thing about the old night city. Interiors run
          // across a wide range of colour temperature: incandescent at 2500-3000K
          // reads orange, fluorescent around 4000K reads yellow-green, modern cool
          // LED is up past 5500K, and a television in an unlit room throws blue.
          // Sorting rooms across those four is most of what makes a wall of windows
          // look inhabited rather than printed.
          vec3 tungsten = vec3(1.00, 0.69, 0.38);
          vec3 fluoro   = vec3(1.00, 0.94, 0.76);
          vec3 coolLed  = vec3(0.80, 0.88, 1.00);
          vec3 screen   = vec3(0.38, 0.56, 1.00);
          float tone = hash12(vec2(fRoom * 31.7, vSeed * 2.9));
          // Offices lean cool and uniform, homes lean warm and varied: vStyle is 0 for
          // an office tower and climbs for housing and sheds.
          tone = clamp(tone - vStyle * 0.3, 0.0, 1.0);
          vec3 lampColour = mix(coolLed, fluoro, smoothstep(0.0, 0.45, tone));
          lampColour = mix(lampColour, tungsten, smoothstep(0.45, 0.95, tone));
          // One room in forty is somebody watching something in the dark.
          lampColour = mix(lampColour, screen, step(0.975, hash12(vec2(fRoom * 7.1, vSeed))));

          // Brightness is not uniform either - squaring a uniform hash gives mostly
          // ordinary rooms and a few that blaze, which is how a real facade reads.
          float watt = 0.34 + 1.5 * pow(hash12(vec2(fRoom * 13.3, vSeed * 1.7)), 2.0);

          // Beyond the distance where a room is a pixel wide, its colour and wattage
          // are being sampled at random from one frame to the next, which crawls. Both
          // fade to the average of the district instead, so a far tower is a steady
          // warm glow rather than a block of static.
          lampColour = mix(vec3(0.97, 0.88, 0.74), lampColour, fNear);
          watt = mix(0.9, watt, fNear);
          // Above 1 on purpose: these are light sources, and the bloom downstream is
          // what turns a bright pane into something that glows rather than a pale
          // square. Clamped emissive can never do that.
          totalEmissiveRadiance += lampColour * fLit * uNight * watt * (0.6 + 0.5 * fRoom);

          // Shopfronts stay lit after dark and spill onto the pavement.
          totalEmissiveRadiance += uWindowWarm * fShop * uNight * 1.15 * mix(0.4, 1.0, fNear);

          // The street is a light source pointing up. Without this the bottom of every
          // tower was as black as the top, which is the one thing a night photograph of
          // a city never shows: the first few floors always carry a sodium wash.
          // Tight: a street lamp is a small source close to the ground, so its bounce
          // is spent within the first few floors. Spread up the whole tower it stops
          // being a wash of light off the road and turns the entire city sepia.
          float streetBounce = exp(-max(vWorldY, 0.0) * 0.085);
          totalEmissiveRadiance += uCityGlow * uNight * streetBounce * 0.20 * fWear * fStruct;

          // Sky and street bounce, so a facade out of the sun still shows its face.
          totalEmissiveRadiance += diffuseColor.rgb * uFill;
        } else {
          // --- roof: gravel, a parapet rim, and the odd painted marking
          vec2 rp = vec2(vLocal.x, vLocal.z);
          vec2 halfSize = vec2(vSize.x, vSize.z) * 0.5;
          float gravel = hash12(floor(rp * 1.35) + vSeed);
          float rpx = fwidth(rp.x) + fwidth(rp.y);
          diffuseColor.rgb *= 0.8 + 0.1 * gravel * (1.0 - smoothstep(0.4, 1.6, rpx));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35, fParapet);
          float hut = step(0.86, hash12(vec2(vSeed * 11.0, 3.0))) *
            step(abs(rp.x + halfSize.x * 0.35), 2.2) * step(abs(rp.y - halfSize.y * 0.3), 1.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.16, 0.13), hut);
          totalEmissiveRadiance += diffuseColor.rgb * uFill * 0.5;

          // Skyglow. A roof at night is not black: it faces straight up into the
          // orange dome a city throws over itself, and low roofs catch the street
          // as well. Without this every block reads as a hole punched in the map.
          // Kept deliberately faint. Seen from altitude the roofs are most of the
          // city's surface area, so anything more than a hint here stops reading as
          // skyglow and starts reading as a field of brown tiles - which costs the
          // one thing the view from up here needs: a dark mass with lights in it.
          totalEmissiveRadiance += uSkyTint * uNight * 0.022;
          totalEmissiveRadiance += uCityGlow * uNight * exp(-max(vWorldY, 0.0) * 0.055) * 0.035;

          // Obstruction lighting. Anything tall enough to be a hazard to aircraft
          // carries a red beacon, and a skyline of them slowly winking out of step is
          // one of the few details that reads from kilometres away - which, in a
          // flying game, is most of where the city is ever seen from.
          float tall = smoothstep(55.0, 85.0, vWorldY);
          if (tall > 0.0) {
            // Near the middle of the roof, and sized against the roof it sits on: a
            // fixed two-metre lamp swallows the whole top of a slender tower, which
            // turned the skyline into a row of red traffic cones.
            float beaconRadius = min(1.5, 0.16 * min(vSize.x, vSize.z));
            float beaconR = 1.0 - smoothstep(beaconRadius * 0.45, beaconRadius, length(rp));
            // Each building keeps its own period and phase, so they never pulse
            // together - a city blinking in unison looks like one machine.
            float period = 1.7 + hash12(vec2(vSeed * 3.7, 9.0)) * 1.4;
            float phase = fract(uTime / period + hash12(vec2(vSeed, 5.0)));
            float flash = pow(max(0.0, sin(phase * 3.14159)), 8.0);
            // Obstruction lights are on around the clock in real life, but a lamp that
            // holds its own against the sun is reading as a painted red disc rather
            // than as a light, so daylight pulls it back to a hint.
            totalEmissiveRadiance += vec3(1.0, 0.06, 0.03) * beaconR * tall * flash
              * (0.22 + 0.78 * uNight) * 3.2;
          }
        }`);
  };
  return mat;
}

function simpleMaterial(color, { rough = 0.8, metal = 0.1 } = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/** Accumulates instance transforms, then bakes them into one InstancedMesh. */
class InstanceBatch {
  constructor(geometry, material, { facade = false } = {}) {
    this.geometry = geometry;
    this.material = material;
    this.facade = facade;
    this.items = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  add(x, y, z, sx, sy, sz, rotY, color, glass = 0, style = 0, ground = 0) {
    this.items.push({ x, y, z, sx, sy, sz, rotY, color, glass, style, ground });
  }

  build(name) {
    const n = this.items.length;
    if (n === 0) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, n);
    mesh.name = name;
    const seeds = this.facade ? new Float32Array(n) : null;
    const sizes = this.facade ? new Float32Array(n * 3) : null;
    const glass = this.facade ? new Float32Array(n) : null;
    const style = this.facade ? new Float32Array(n) : null;
    const ground = this.facade ? new Float32Array(n) : null;

    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      this._p.set(it.x, it.y, it.z);
      this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rotY);
      this._s.set(it.sx, it.sy, it.sz);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
      mesh.setColorAt(i, it.color);
      if (this.facade) {
        seeds[i] = (i * 0.6180339887) % 1 * 100;
        sizes[i * 3] = it.sx;
        sizes[i * 3 + 1] = it.sy;
        sizes[i * 3 + 2] = it.sz;
        glass[i] = it.glass;
        style[i] = it.style ?? 0;
        ground[i] = it.ground ?? 0;
      }
    }
    if (this.facade) {
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      mesh.geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
      mesh.geometry.setAttribute('aGlass', new THREE.InstancedBufferAttribute(glass, 1));
      mesh.geometry.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 1));
      mesh.geometry.setAttribute('aGround', new THREE.InstancedBufferAttribute(ground, 1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere?.();
    this.items.length = 0;
    return mesh;
  }
}

/**
 * Spatial hash of building bounding boxes.
 *
 * Boxes are registered in every cell they touch, so a collision query only has to
 * look at the cells the aircraft's sphere overlaps — a handful of candidates out of
 * thousands of buildings, which is what keeps collision off the frame budget (§89).
 */
export class ObstacleGrid {
  constructor(cellSize = 220) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.boxes = [];
  }

  _key(cx, cz) {
    return cx * 100000 + cz;
  }

  add(minX, maxX, minZ, maxZ, base, top, kind = 'building', ref = null) {
    const idx = this.boxes.length;
    // `ref` lets a caller find out *which* of its own objects was hit, which is what
    // turns a collision into localised damage rather than a generic bump. `alive`
    // retires a box without touching the cell lists: the lists hold indices, so
    // splicing one out would renumber every box after it.
    this.boxes.push({ minX, maxX, minZ, maxZ, base, top, kind, ref, alive: true });
    const c = this.cellSize;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
        const k = this._key(cx, cz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(idx);
      }
    }
    return idx;
  }

  *candidates(x, z, radius) {
    const c = this.cellSize;
    const seen = new Set();
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const list = this.cells.get(this._key(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (seen.has(i)) continue;
          seen.add(i);
          const b = this.boxes[i];
          if (b.alive === false) continue;
          yield b;
        }
      }
    }
  }

  /**
   * Sphere-vs-box test. Returns the shallowest separating axis, which is what
   * makes a clipped wingtip push you sideways instead of stopping you dead.
   */
  sample(position, radius, out) {
    const { x, y, z } = position;
    let best = null;
    for (const b of this.candidates(x, z, radius)) {
      if (y > b.top + radius || y < b.base - radius) continue;
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      if (dx * dx + dz * dz > radius * radius) continue;

      // Depth along each candidate escape direction.
      const pxMin = x - b.minX + radius;
      const pxMax = b.maxX - x + radius;
      const pzMin = z - b.minZ + radius;
      const pzMax = b.maxZ - z + radius;
      const pyTop = b.top - y + radius;

      let pen = pxMin, nx = -1, ny = 0, nz = 0;
      if (pxMax < pen) { pen = pxMax; nx = 1; nz = 0; }
      if (pzMin < pen) { pen = pzMin; nx = 0; nz = -1; }
      if (pzMax < pen) { pen = pzMax; nx = 0; nz = 1; }
      if (pyTop < pen) { pen = pyTop; nx = 0; ny = 1; nz = 0; }
      if (pen <= 0) continue;
      if (!best || pen < best.penetration) {
        best = { penetration: pen, nx, ny, nz, box: b };
      }
    }
    if (!best) return null;
    out = out ?? { normal: new THREE.Vector3(), point: new THREE.Vector3() };
    out.penetration = best.penetration;
    out.normal.set(best.nx, best.ny, best.nz);
    out.point.set(x, y, z).addScaledVector(out.normal, -best.penetration);
    out.kind = best.box.kind;
    out.ref = best.box.ref;
    return out;
  }

  /** Closest surface within maxDist, for near-miss scoring. */
  nearest(position, maxDist) {
    const { x, y, z } = position;
    let bestDist = Infinity;
    let bestKind = null;
    for (const b of this.candidates(x, z, maxDist)) {
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      const dy = Math.max(b.base - y, 0, y - b.top);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bestDist) { bestDist = d; bestKind = b.kind; }
    }
    return bestDist <= maxDist ? { distance: bestDist, kind: bestKind } : null;
  }

  /**
   * The highest surface under a point, ignoring anything whose top is above
   * `ceiling` - which is what makes it "under" rather than merely "here".
   *
   * This is what a falling body lands on. Without it a slab shed by a tower drops
   * through every roof between it and the street, which is the one thing that gives
   * away that the city is a set of boxes rather than a city.
   */
  surfaceBelow(x, z, ceiling = Infinity) {
    // Walks the one cell the point falls in directly rather than going through
    // candidates(). A point needs no dedup across cells and no generator, and this
    // is the hottest query in the game: every falling body asks it every frame, and
    // during a collapse there are thousands of them.
    const c = this.cellSize;
    const list = this.cells.get(this._key(Math.floor(x / c), Math.floor(z / c)));
    if (!list) return -Infinity;
    let best = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const b = this.boxes[list[i]];
      if (b.alive === false || b.top > ceiling || b.top <= best) continue;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      best = b.top;
    }
    return best;
  }

  /** Retires a box. Its geometry stops colliding; its index stays valid. */
  remove(index) {
    const b = this.boxes[index];
    if (b) b.alive = false;
  }

  /** Puts a retired box back in play, exactly where it already is. */
  revive(index) {
    const b = this.boxes[index];
    if (b) b.alive = true;
  }

  get count() {
    return this.boxes.length;
  }
}

/**
 * Rooftop plant: the air handling units, water tanks, stair heads and masts that make
 * a roof read as a working surface rather than a lid. Instanced with everything else,
 * and only as many as the quality preset pays for.
 */
function addRoofClutter(ctx, { x, z, w, d, top, rot, color, detail, tall }) {
  const { box, cyl, deco: rng } = ctx;
  // One or two units, not a rooftop farm. Every one of these is an instance that draws
  // whether or not the player is near it, so the budget is spent on the roofs most
  // likely to be flown over rather than spread across every shed in the city.
  const units = 1 + (rng.bool(0.4 * detail) ? 1 : 0);
  const dark = color.clone().multiplyScalar(0.62);
  for (let i = 0; i < units; i++) {
    const ux = x + rng.range(-w * 0.3, w * 0.3);
    const uz = z + rng.range(-d * 0.3, d * 0.3);
    const pick = rng.next();
    if (pick < 0.55) {
      // Air handling unit: a low box with a lighter lid.
      const uw = rng.range(2.4, Math.max(3, w * 0.26));
      const ud = rng.range(2.2, Math.max(3, d * 0.26));
      const uh = rng.range(1.4, 2.8);
      box.add(ux, top + uh / 2, uz, uw, uh, ud, rot, dark, 0);
      if (detail > 0.9) {
        box.add(ux, top + uh + 0.18, uz, uw * 0.92, 0.36, ud * 0.92, rot, new THREE.Color(0x9aa3ad), 0);
      }
    } else if (pick < 0.82) {
      // Water tank on short legs.
      const r = rng.range(1.2, 2.2);
      const h = rng.range(2.6, 4.4);
      cyl.add(ux, top + 0.9 + h / 2, uz, r, h, r, rot, new THREE.Color(0x7d6a58), 0);
      if (detail > 0.9) box.add(ux, top + 0.45, uz, r * 1.5, 0.9, r * 1.5, rot, dark, 0);
    } else {
      // Stair head with a door-sized face.
      const sw = rng.range(2.6, 3.8);
      const sh = rng.range(2.4, 3.2);
      box.add(ux, top + sh / 2, uz, sw, sh, sw * 0.8, rot, dark, 0);
    }
  }
  // A mast on the tall ones. Deliberately not a collider: a 30 cm pole you cannot see
  // until it has killed you is the unfair collision the specification rules out (§146),
  // and it would also quietly move the goalposts for every gate authored above a roof.
  if (tall && rng.bool(0.35)) {
    const mh = rng.range(8, 26);
    cyl.add(x, top + mh / 2, z, 0.32, mh, 0.32, 0, new THREE.Color(0xb44b3a), 0);
  }
}

/** One building: stacked masses, optional spire, registered for collision. */
function addBuilding(ctx, opts) {
  const { box, cyl, cone, roof, grid } = ctx;
  const { x, z, w, d, height, rot, palette, glass, rng, type, detail = 1 } = opts;
  const base = terrainHeight(x, z) - 2;
  const color = new THREE.Color(palette[rng.int(0, palette.length - 1)]);
  color.offsetHSL(0, 0, rng.range(-0.05, 0.05));
  // Facade style: 0 office, 1 home, 2 industrial. It decides window size, how the
  // lights come on at night, and how much glazing the walls carry.
  const style = type === 'house' ? 1 : (type === 'shed' || type === 'silo' || type === 'stack') ? 2 : 0;

  let top = base;

  if (type === 'silo') {
    const r = Math.min(w, d) * 0.42;
    cyl.add(x, base + height / 2, z, r, height, r, rot, color, 0, style, 1);
    top = base + height;
  } else if (type === 'stack') {
    const r = Math.min(w, d) * 0.16;
    cyl.add(x, base + height / 2, z, r, height, r, rot, color.clone().multiplyScalar(0.8), 0, style, 1);
    // A banded collar so stacks read as stacks from a distance.
    cyl.add(x, base + height * 0.86, z, r * 1.5, height * 0.06, r * 1.5, rot, new THREE.Color(0xd04a2a));
    top = base + height;
  } else if (type === 'house') {
    const h = height;
    box.add(x, base + h / 2, z, w, h, d, rot, color, 0.1, style, 1);
    // A pyramid sized to the box's own half-diagonal and turned 45 degrees sits on
    // the walls instead of hanging over them like a hat.
    const roofR = Math.hypot(w, d) * 0.5 * 1.04;
    const roofH = h * 0.5;
    roof.add(x, base + h + roofH / 2, z, roofR, roofH, roofR, rot + Math.PI / 4,
      color.clone().multiplyScalar(0.78));
    top = base + h + roofH;
  } else if (type === 'shed') {
    box.add(x, base + height / 2, z, w, height, d, rot, color, 0.05, style, 1);
    // Roof vents / skylights.
    if (rng.bool(0.5)) {
      box.add(x, base + height + 1.2, z, w * 0.55, 2.4, d * 0.3, rot, color.clone().multiplyScalar(0.75), 0);
    }
    top = base + height + 3;
  } else {
    // Tower: successive setbacks, each smaller and shorter than the last.
    const stages = height > 150 ? rng.int(2, 3) : height > 60 ? rng.int(1, 2) : 1;
    let y = base;
    let cw = w, cd = d;
    let remaining = height;
    for (let s = 0; s < stages; s++) {
      const share = s === stages - 1 ? remaining : remaining * rng.range(0.45, 0.72);
      box.add(x, y + share / 2, z, cw, share, cd, rot, color, glass, style, s === 0 ? 1 : 0);
      y += share;
      remaining -= share;
      cw *= rng.range(0.62, 0.84);
      cd *= rng.range(0.62, 0.84);
    }
    top = y;
    // Crown: spire, mast or rooftop plant.
    if (rng.next() < opts.spireChance) {
      const spireH = height * rng.range(0.12, 0.34);
      cone.add(x, top + spireH / 2, z, Math.min(cw, cd) * 0.42, spireH, Math.min(cw, cd) * 0.42, rot, new THREE.Color(0x99a4b0));
      top += spireH;
    } else if (rng.bool(0.55)) {
      const boxH = rng.range(3, 9);
      box.add(x + rng.range(-cw * 0.2, cw * 0.2), top + boxH / 2, z, cw * 0.45, boxH, cd * 0.45, rot, color.clone().multiplyScalar(0.8), 0, style, 0);
      top += boxH;
    }
    // Only the roofs that are worth the instances: tall enough to be flown past, and
    // not all of them even then.
    if (detail > 0.55 && height > 45 && ctx.deco.bool(0.45 * detail)) {
      addRoofClutter(ctx, { x, z, w: cw, d: cd, top, rot, color, detail, tall: height > 120 });
    }
  }

  // Flat-roofed small buildings get a little plant too, but rarely enough that the
  // low-rise districts stay calmer than downtown.
  if ((type === 'shed' || type === 'silo') && detail > 0.7 && ctx.deco.bool(0.16)) {
    addRoofClutter(ctx, { x, z, w, d, top, rot, color, detail: detail * 0.5, tall: false });
  }

  const halfW = Math.max(w, d) * 0.5;
  grid.add(x - halfW, x + halfW, z - halfW, z + halfW, base, top, 'building');
  return top;
}

function buildingTypeFor(region, rng) {
  const b = region.buildings;
  if (b.industrial) return rng.pick(['shed', 'shed', 'silo', 'stack', 'tower']);
  if (b.rural) return rng.pick(['house', 'house', 'shed']);
  if (region.id === 'residential') return rng.next() < 0.62 ? 'house' : 'tower';
  if (b.docks) return rng.pick(['shed', 'shed', 'tower', 'silo']);
  if (region.id === 'airport') return rng.pick(['shed', 'shed', 'tower']);
  return 'tower';
}

/**
 * Generates every district. Returns the scene group, the collision grid, and the
 * per-tile urbanisation values the ground shader uses to paint streets.
 */
export function generateCity({ seed = 20260912, detail = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'city';
  const grid = new ObstacleGrid(220);

  const facade = facadeMaterial();
  const roofMat = simpleMaterial(0xb0b4ba, { rough: 0.9, metal: 0.05 });
  const ctx = {
    box: new InstanceBatch(new THREE.BoxGeometry(1, 1, 1), facade, { facade: true }),
    cyl: new InstanceBatch(new THREE.CylinderGeometry(1, 1, 1, 12), facade, { facade: true }),
    cone: new InstanceBatch(new THREE.ConeGeometry(1, 1, 8), roofMat),
    // Four-sided, so a house gets a pitched roof rather than an octagonal hat.
    roof: new InstanceBatch(new THREE.ConeGeometry(1, 1, 4), roofMat),
    grid,
    // Decoration draws from its own stream. Sharing the layout's would mean adding a
    // water tank to one roof moved every building after it, which silently invalidates
    // every checkpoint and beacon authored against the city.
    deco: new Rng(seed ^ 0x5eed5),
  };

  const urban = new Float32Array(9);
  const perRegion = {};
  let placed = 0;

  REGION_ORDER.forEach((id, tileIndex) => {
    const region = REGIONS[id];
    const b = region.buildings;
    const rng = new Rng(seed).fork(id);
    urban[tileIndex] = clamp01(b.density);
    let regionCount = 0;

    const half = TILE / 2;
    const blocks = Math.floor(TILE / PERIOD);
    const start = region.cx - half + PERIOD / 2;
    const startZ = region.cz - half + PERIOD / 2;

    for (let i = 0; i < blocks; i++) {
      for (let j = 0; j < blocks; j++) {
        const bx = start + i * PERIOD;
        const bz = startZ + j * PERIOD;
        if (isWater(bx, bz)) continue;
        if (isAirportClearZone(bx, bz) || isParkZone(bx, bz)) continue;

        // Density varies inside a district so it never looks stamped out.
        const localDensity = b.density * (0.65 + 0.5 * fbm2D(bx * 0.0011, bz * 0.0011, 2, 7));
        if (rng.next() > localDensity * detail) continue;

        // Distance from the district centre drives height: cores are tall, edges low.
        const distFromCore = Math.hypot(bx - region.cx, bz - region.cz) / half;
        const coreBias = 1 - smoothstep(0.1, 1.05, distFromCore) * 0.62;

        // How many buildings fit in a block depends on how big they are. A district of
        // houses with one house per 112 m block reads as litter scattered on a street
        // grid rather than as a neighbourhood, so small footprints get a sub-grid.
        const avgFoot = (b.footprint[0] + b.footprint[1]) * 0.5;
        const perBlock = avgFoot > 70 ? 1 : clamp(Math.round((BLOCK * 0.85) / avgFoot), 1, 4);
        const cells = perBlock > 1 ? Math.ceil(Math.sqrt(perBlock)) : 1;
        const cellSize = BLOCK / cells;

        for (let k = 0; k < perBlock; k++) {
          const maxFoot = cellSize * 0.9;
          const shrink = perBlock > 1 ? Math.sqrt(perBlock) * 0.72 : 1;
          const fw = Math.min(maxFoot, rng.range(b.footprint[0], b.footprint[1]) / shrink);
          const fd = Math.min(maxFoot, fw * rng.range(0.7, 1.35));
          // Lay them out on the sub-grid, then jitter inside their own cell, so they
          // spread across the block instead of piling up in the middle.
          const cx = (k % cells) - (cells - 1) / 2;
          const cz = Math.floor(k / cells) - (cells - 1) / 2;
          const jitter = Math.max(0, (cellSize - Math.max(fw, fd)) * 0.4);
          const x = bx + cx * cellSize + rng.range(-jitter, jitter);
          const z = bz + cz * cellSize + rng.range(-jitter, jitter);
          if (isWater(x, z) || isAirportClearZone(x, z) || isParkZone(x, z)) continue;

          const type = buildingTypeFor(region, rng);
          let height = lerp(b.minH, b.maxH, Math.pow(rng.next(), 1.7)) * coreBias;
          if (type === 'house') height = rng.range(6, 13);
          if (type === 'stack') height = rng.range(44, 96);
          if (type === 'silo') height = rng.range(18, 46);
          if (type === 'shed') height = rng.range(10, 26);
          height = Math.max(6, height);

          addBuilding(ctx, {
            x, z, w: fw, d: fd, height, rot: rng.bool(0.12) ? rng.range(0, Math.PI) : 0,
            palette: b.palette, glass: b.glass, rng, type, spireChance: b.spireChance, detail,
          });
          placed++;
          regionCount++;
        }
      }
    }
    perRegion[id] = regionCount;
  });

  const boxes = ctx.box.build('city:boxes');
  const cyls = ctx.cyl.build('city:cylinders');
  const cones = ctx.cone.build('city:cones');
  const roofs = ctx.roof.build('city:roofs');
  for (const m of [boxes, cyls, cones, roofs]) if (m) group.add(m);

  group.userData.facadeUniforms = facade.userData.uniforms;
  group.userData.urban = urban;
  group.userData.stats = { buildings: placed, colliders: grid.count, perRegion };
  group.userData.dispose = () => {
    for (const m of [boxes, cyls, cones, roofs]) m?.geometry.dispose();
    facade.dispose();
    roofMat.dispose();
  };
  return { group, grid, urban, stats: group.userData.stats };
}
