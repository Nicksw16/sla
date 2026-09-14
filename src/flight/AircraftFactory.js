import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/MathUtils.js';
import { PAINTS } from '../data/upgrades.js';
import {
  fuselageFromStations, wing, wingFairing, nacelle, exhaustCone, propBlade,
  airfoil, loft, canopy, superellipse, intake,
} from './AircraftGeometry.js';
import { applyPanelLines, SKIN } from './AircraftSkin.js';

/**
 * Builds aircraft out of geometry at runtime (no art assets are available, so
 * everything here is procedural — spec §139-140 permits functional stand-ins so long
 * as the system can accept real art later; swapping in a glTF only means replacing
 * build() and keeping the same part names).
 *
 * What makes these read as aircraft rather than as assembled primitives is mostly not
 * polygon count. It is:
 *
 *  - The fuselage is lofted through non-circular sections, not turned on a lathe. Real
 *    fuselages are not bodies of revolution: an airliner is two circular arcs joined
 *    at the cabin floor, a fighter forebody is a rounded triangle, and every one of
 *    them has a tail cone that rises. A lathe gets none of that.
 *  - The jets are waisted where the wing passes through, which is Whitcomb's area
 *    rule: hold the total cross-section smooth along the length and the aircraft
 *    stops looking like a tube with wings stuck to it.
 *  - Wings kink. An airliner's inner panel is barely swept and its outer panel is
 *    swept hard; a delta carries a leading-edge extension ahead of the main panel.
 *  - Nothing meets at a bare corner. Wing roots, fins and pylons all carry fairings.
 *  - The paint is a panel-lined skin rather than a colour, which is what sets the
 *    scale of the whole thing (see AircraftSkin.js).
 */

const MAT = {
  // Paint over aluminium: barely metallic, or with no environment to reflect it goes
  // black. The sheen comes from roughness, not from metalness.
  paint: (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.18, roughness: 0.34 }),
  trim: (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.22, roughness: 0.3 }),
  // Bare metal: engine cowls, exhausts, oleos.
  metal: (color = 0x9aa3ad) => new THREE.MeshStandardMaterial({ color, metalness: 0.9, roughness: 0.25 }),
  // Titanium round a hot nozzle: darker, and rough from heat.
  hot: () => new THREE.MeshStandardMaterial({ color: 0x8b8279, metalness: 0.88, roughness: 0.42 }),
  // Anything structural and unpainted: hinges, ducts, antennas.
  dark: () => new THREE.MeshStandardMaterial({ color: 0x1b2028, metalness: 0.55, roughness: 0.55 }),
  // Tyres: no metal at all, and rough enough to stay matt in any light.
  rubber: () => new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.0, roughness: 0.94 }),
  // Canopy glazing: a tinted, smooth, reflective surface rather than a dark hole.
  glass: () => new THREE.MeshStandardMaterial({
    color: 0x22404f, metalness: 0.55, roughness: 0.05,
    transparent: true, opacity: 0.68, envMapIntensity: 1.6,
  }),
  // Inside the intake and the exhaust: dark, so the duct reads as depth.
  duct: () => new THREE.MeshStandardMaterial({
    color: 0x0b0e12, metalness: 0.4, roughness: 0.72, side: THREE.DoubleSide,
  }),
  glow: (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
};

/** Which body shape this aircraft wears. Drives the whole station profile below. */
function bodyClass(m) {
  if (m.canopy === 'airliner') return m.engines === 'prop' ? 'commuter' : 'airliner';
  if (m.canopy === 'fighter') return 'fighter';
  return 'light';
}

/**
 * The stations a fuselage is lofted through, as multiples of the body radius.
 *
 * z runs -0.5 at the nose to +0.5 at the tail. `y` raises the section centre, which
 * is what produces a tail cone that rises and a belly that does not - the single
 * cheapest cue that a shape is an aircraft rather than a rocket. `n` is the
 * superellipse exponent: 2 is an ellipse, higher is squarer.
 */
const BODY = {
  airliner: [
    { z: -0.500, w: 0.05, h: 0.05, y: -0.02, n: 2.0 },
    { z: -0.472, w: 0.62, h: 0.58, y: -0.06, n: 2.1 },   // radome
    { z: -0.430, w: 1.18, h: 1.14, y: -0.05, n: 2.2 },
    { z: -0.370, w: 1.68, h: 1.72, y: -0.02, n: 2.3 },   // flight deck
    { z: -0.270, w: 1.92, h: 2.00, y:  0.00, n: 2.45 },
    { z: -0.060, w: 1.96, h: 2.04, y:  0.00, n: 2.5 },   // constant cabin section
    { z:  0.120, w: 1.94, h: 2.02, y:  0.01, n: 2.5 },
    { z:  0.250, w: 1.74, h: 1.84, y:  0.10, n: 2.4 },
    { z:  0.350, w: 1.30, h: 1.44, y:  0.30, n: 2.3 },   // upsweep begins
    { z:  0.440, w: 0.76, h: 0.94, y:  0.62, n: 2.2 },
    { z:  0.500, w: 0.16, h: 0.30, y:  0.86, n: 2.0 },   // tail, well above the axis
  ],
  commuter: [
    { z: -0.500, w: 0.08, h: 0.08, y: -0.04, n: 2.0 },
    { z: -0.460, w: 0.78, h: 0.74, y: -0.10, n: 2.1 },
    { z: -0.400, w: 1.40, h: 1.40, y: -0.06, n: 2.2 },
    { z: -0.320, w: 1.80, h: 1.90, y: -0.02, n: 2.4 },
    { z: -0.120, w: 1.94, h: 2.06, y:  0.00, n: 2.5 },
    { z:  0.090, w: 1.90, h: 2.02, y:  0.02, n: 2.5 },
    { z:  0.230, w: 1.62, h: 1.78, y:  0.12, n: 2.4 },
    { z:  0.340, w: 1.16, h: 1.34, y:  0.34, n: 2.3 },
    { z:  0.440, w: 0.62, h: 0.82, y:  0.62, n: 2.1 },
    { z:  0.500, w: 0.14, h: 0.26, y:  0.82, n: 2.0 },
  ],
  fighter: [
    { z: -0.500, w: 0.03, h: 0.03, y:  0.00, n: 2.0 },
    { z: -0.452, w: 0.32, h: 0.28, y: -0.01, n: 2.2 },   // radome, long and slim
    { z: -0.395, w: 0.68, h: 0.56, y: -0.02, n: 2.6 },   // chined forebody: wide, flat
    { z: -0.325, w: 1.04, h: 0.84, y: -0.01, n: 2.9 },
    { z: -0.245, w: 1.32, h: 1.08, y:  0.02, n: 2.9 },   // cockpit station
    { z: -0.120, w: 1.50, h: 1.28, y:  0.01, n: 2.8 },
    { z:  0.020, w: 1.42, h: 1.32, y:  0.00, n: 2.7 },   // area-rule waist at the wing
    { z:  0.160, w: 1.50, h: 1.34, y:  0.00, n: 2.7 },   // swells again over the engines
    { z:  0.320, w: 1.56, h: 1.30, y:  0.00, n: 2.8 },
    { z:  0.440, w: 1.46, h: 1.16, y:  0.01, n: 2.9 },
    { z:  0.500, w: 1.32, h: 1.02, y:  0.02, n: 3.0 },   // squared tail, nozzles in it
  ],
  light: [
    { z: -0.500, w: 0.55, h: 0.55, y: -0.05, n: 2.2 },   // spinner bulkhead, blunt
    { z: -0.430, w: 1.30, h: 1.28, y: -0.06, n: 2.3 },   // engine cowl
    { z: -0.330, w: 1.62, h: 1.68, y: -0.02, n: 2.4 },
    { z: -0.180, w: 1.80, h: 2.00, y:  0.02, n: 2.5 },   // cabin, deepest point
    { z: -0.020, w: 1.66, h: 1.86, y:  0.02, n: 2.4 },
    { z:  0.140, w: 1.28, h: 1.44, y:  0.08, n: 2.3 },
    { z:  0.290, w: 0.86, h: 1.02, y:  0.24, n: 2.2 },   // tail boom
    { z:  0.400, w: 0.56, h: 0.72, y:  0.44, n: 2.1 },
    { z:  0.500, w: 0.20, h: 0.34, y:  0.62, n: 2.0 },
  ],
};

/**
 * A control surface lofted from the same aerofoil the wing uses, so it is a tapered
 * wedge that continues the section rather than a box bolted to the back of it. The
 * returned group is the hinge line: rotating it swings the trailing edge, which is
 * what a real aileron does.
 */
function controlSurface(span, chordRoot, chordTip, thickness, material,
  { vertical = false, sweep = 0 } = {}) {
  const pivot = new THREE.Group();
  const section = airfoil(0.5, 5);   // only the aft third of an aerofoil is used
  const rings = [];
  for (let i = 0; i < 2; i++) {
    const t = i;
    const chord = lerp(chordRoot, chordTip, t);
    const th = thickness * lerp(1, 0.72, t);
    rings.push(section.map((p) => {
      // Take the rear 34% of the section and stretch it over the full chord, then
      // carry the hinge line back with the surface it is hinged to: a rudder on a
      // swept fin whose hinge stays vertical has its top sticking out in front of
      // the fin with nothing behind it.
      const cz = Math.min(1, 0.66 + p.x * 0.34) * chord + t * sweep;
      const cy = p.y * th;
      return vertical
        ? new THREE.Vector3(cy, t * span, cz)
        : new THREE.Vector3(t * span, cy, cz);
    }));
  }
  const mesh = new THREE.Mesh(loft(rings, { capTip: true, capRoot: true }), material);
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

/** Wing planform breakpoints per class. Sweep and dihedral are absolute metres. */
function wingPanels(kind, span, rootChord) {
  const half = span * 0.5;
  const sw = (deg, frac) => Math.tan(deg * Math.PI / 180) * half * frac;
  const di = (deg, frac) => Math.tan(deg * Math.PI / 180) * half * frac;
  switch (kind) {
    case 'delta':
      // A leading-edge extension ahead of the main panel, then a hard-swept delta.
      return {
        panels: [
          { frac: 0.00, chord: rootChord, sweep: 0, dihedral: 0, thickness: 0.055 },
          { frac: 0.16, chord: rootChord * 0.90, sweep: sw(72, 0.16), dihedral: di(1, 0.16), thickness: 0.055 },
          { frac: 0.36, chord: rootChord * 0.62, sweep: sw(56, 0.36), dihedral: di(1, 0.36), thickness: 0.05 },
          { frac: 1.00, chord: rootChord * 0.24, sweep: sw(52, 1.00), dihedral: di(1, 1.00), thickness: 0.045 },
        ],
        winglet: 0,
      };
    case 'swept':
      // The airliner kink: a nearly straight inner panel carrying the engine, then
      // the swept outer panel. It is the shape everybody recognises from a window seat.
      return {
        panels: [
          { frac: 0.00, chord: rootChord, sweep: 0, dihedral: 0, thickness: 0.135 },
          { frac: 0.32, chord: rootChord * 0.70, sweep: sw(30, 0.32), dihedral: di(5.5, 0.32), thickness: 0.115 },
          { frac: 0.70, chord: rootChord * 0.44, sweep: sw(31, 0.70), dihedral: di(5.5, 0.70), thickness: 0.10, twist: -0.02 },
          { frac: 1.00, chord: rootChord * 0.30, sweep: sw(31, 1.00), dihedral: di(5.5, 1.00), thickness: 0.09, twist: -0.045 },
        ],
        winglet: rootChord * 0.62,
      };
    case 'tapered':
      return {
        panels: [
          { frac: 0.00, chord: rootChord, sweep: 0, dihedral: 0, thickness: 0.145 },
          { frac: 0.24, chord: rootChord * 0.96, sweep: sw(6, 0.24), dihedral: di(6, 0.24), thickness: 0.14 },
          { frac: 1.00, chord: rootChord * 0.54, sweep: sw(9, 1.00), dihedral: di(6, 1.00), thickness: 0.115, twist: -0.04 },
        ],
        winglet: 0,
      };
    default: // straight
      return {
        panels: [
          { frac: 0.00, chord: rootChord, sweep: 0, dihedral: 0, thickness: 0.15 },
          { frac: 0.42, chord: rootChord, sweep: sw(1.5, 0.42), dihedral: di(6.5, 0.42), thickness: 0.15 },
          { frac: 1.00, chord: rootChord * 0.66, sweep: sw(4, 1.00), dihedral: di(6.5, 1.00), thickness: 0.12, twist: -0.035 },
        ],
        winglet: 0,
      };
  }
}

export function buildAircraft(spec, paintId = 'factory') {
  const m = spec.model;
  const paint = PAINTS[paintId] ?? PAINTS.factory;
  const cls = bodyClass(m);
  const isJet = m.engines === 'jet';
  const len = m.length;
  const radius = Math.max(0.42, len * 0.085);
  const seed = (spec.id ?? '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 97;
  // Fineness ratio - length over diameter - is most of what says how fast a shape is
  // meant to go. A transport runs near 10:1 and a fighter forebody finer still; the
  // station tables are written in body radii, and taking them at face value produced
  // a 6:1 body, which reads as a whale whatever detail is painted on it.
  const slim = { airliner: 0.60, commuter: 0.66, fighter: 0.70, light: 0.88 }[cls];

  // Panel pitch is a real length, so a big aircraft gets more panels than a small
  // one rather than the same count stretched over it. That is the whole point: the
  // panels are what tell the eye how large the thing is.
  const pitch = clampNum(len * 0.055, 0.34, 0.95);

  const bodyMat = applyPanelLines(MAT.paint(paint.body), {
    mode: SKIN.BODY, spacing: pitch, seed,
    // A cheatline is transport-aircraft livery. A fighter wears none, and putting one
    // on a trainer just reads as a stray dark slot down the side.
    stripe: (cls === 'airliner' || cls === 'commuter')
      ? { colour: paint.trim, centre: radius * slim * 0.20, height: radius * slim * 0.15 }
      : null,
  });
  const wingMat = applyPanelLines(MAT.paint(paint.body), {
    mode: SKIN.WING, spacing: pitch * 1.15, seed: seed + 11,
  });
  const trimMat = applyPanelLines(MAT.trim(paint.trim), {
    mode: SKIN.BODY, spacing: pitch, seed: seed + 23, wear: 0.7,
  });
  const cowlMat = applyPanelLines(MAT.trim(paint.trim), {
    mode: SKIN.NACELLE, spacing: pitch, seed: seed + 37, wear: 0.8,
  });
  const accentMat = MAT.trim(m.colorAccent ?? 0xffffff);
  const darkMat = MAT.dark();
  const metalMat = MAT.metal();
  const hotMat = MAT.hot();
  const rubberMat = MAT.rubber();
  const ductMat = MAT.duct();

  const group = new THREE.Group();
  group.name = `aircraft:${spec.id}`;
  const parts = {
    props: [], propDiscs: [], afterburners: [], gear: [], lights: [],
    navLights: [], strobes: [], fans: [], landingLights: [],
  };

  // ---------------------------------------------------------------- fuselage
  //
  // Fineness ratio - length over diameter - is most of what says how fast a shape is
  // meant to go. A transport runs near 10:1 and a fighter forebody finer still; the
  // station tables below are written in body radii, and taking them at face value
  // produced a 6:1 body, which reads as a whale whatever detail is painted on it.
  const stations = BODY[cls].map((s) => ({
    z: s.z * len, w: s.w * radius * slim, h: s.h * radius * slim, y: s.y * radius * slim, n: s.n,
  }));
  const fuse = new THREE.Mesh(
    fuselageFromStations(stations, { segments: 26, subdivide: 3 }),
    bodyMat,
  );
  fuse.castShadow = true;
  fuse.receiveShadow = true;
  group.add(fuse);

  // Height of the body's top and bottom at a given z, so everything mounted on the
  // hull sits on it instead of floating near it.
  const bodyAt = (zFrac) => {
    const t = (zFrac + 0.5) * (stations.length - 1);
    const i = Math.max(0, Math.min(stations.length - 2, Math.floor(t)));
    const k = t - i;
    const a = stations[i];
    const b = stations[i + 1];
    return {
      w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k),
    };
  };

  // ------------------------------------------------------------------- wing
  const rootChord = m.wing === 'delta' ? m.wingspan * 0.44 : Math.max(1.2, m.wingspan * 0.235);
  const plan = wingPanels(m.wing, m.wingspan, rootChord);
  const wingGeo = wing({
    span: m.wingspan, panels: plan.panels, winglet: plan.winglet, stations: 4,
  });
  // Where the wing sits on the body: low on a fighter, low-mid on an airliner, and
  // on the shoulder of a high-wing light aircraft.
  const highWing = cls === 'light' && m.wing === 'straight';
  const wingZ = m.wing === 'delta' ? len * 0.06 : len * 0.01;
  const bodyHere = bodyAt(wingZ / len);
  const wingY = highWing
    ? bodyHere.y + bodyHere.h * 0.44
    : bodyHere.y - bodyHere.h * (cls === 'fighter' ? 0.18 : 0.30);

  for (const side of [1, -1]) {
    const w = new THREE.Mesh(wingGeo, wingMat);
    w.scale.x = side;
    w.position.set(0, wingY, wingZ);
    w.castShadow = true;
    w.receiveShadow = true;
    group.add(w);

    // The wing-body fairing. Starts ahead of the leading edge, runs well aft of the
    // trailing edge, and is what stops the junction reading as two parts meeting at
    // a corner (§ real aircraft never leave this out).
    const fair = new THREE.Mesh(wingFairing({
      length: rootChord * (cls === 'fighter' ? 1.5 : 1.35),
      height: bodyHere.h * 0.16,
      width: bodyHere.w * 0.13,
      rootZ: wingZ + rootChord * 0.22,
    }), bodyMat);
    fair.scale.x = side;
    fair.position.set(side * bodyHere.w * 0.42, wingY + bodyHere.h * 0.04, 0);
    fair.castShadow = true;
    group.add(fair);
  }
  group.userData.wingGeo = wingGeo;

  // How the wing sits at a given fraction of half-span, so everything hung on it -
  // ailerons, flaps, pylons, tip lights - lands on the surface instead of near it.
  const planAt = (t) => {
    const ps = plan.panels;
    let i = 0;
    while (i < ps.length - 2 && ps[i + 1].frac < t) i++;
    const a = ps[i];
    const b = ps[i + 1] ?? a;
    const k = Math.min(1, Math.max(0, (t - a.frac) / Math.max(1e-5, b.frac - a.frac)));
    return {
      x: m.wingspan * 0.5 * t,
      chord: lerp(a.chord, b.chord, k),
      sweep: lerp(a.sweep ?? 0, b.sweep ?? 0, k),
      dihedral: lerp(a.dihedral ?? 0, b.dihedral ?? 0, k),
      thickness: lerp(a.thickness ?? 0.11, b.thickness ?? 0.11, k),
    };
  };
  // Trailing edge of the wing at that fraction: the section is laid out with its
  // quarter-chord on the reference line, so the trailing edge is three quarters aft.
  const trailing = (t) => {
    const p = planAt(t);
    return { z: wingZ + p.sweep + p.chord * 0.75, y: wingY + p.dihedral, p };
  };

  // ------------------------------------------------- ailerons, flaps, spoilers
  const ailIn = m.wing === 'delta' ? 0.42 : 0.58;
  const ailOut = m.wing === 'delta' ? 0.92 : 0.95;
  for (const side of [1, -1]) {
    const a0 = trailing(ailIn);
    const a1 = trailing(ailOut);
    const aileron = controlSurface(
      (a1.p.x - a0.p.x),
      a0.p.chord * 0.26, a1.p.chord * 0.28,
      a0.p.chord * a0.p.thickness * 0.55, trimMat,
    );
    aileron.scale.x = side;
    aileron.position.set(side * a0.p.x, a0.y, a0.z - a0.p.chord * 0.26);
    group.add(aileron);
    parts[side > 0 ? 'aileronRight' : 'aileronLeft'] = aileron;

    // A delta has no separate flap; everything inboard is elevon, already covered.
    if (m.wing !== 'delta') {
      const f0 = trailing(0.14);
      const f1 = trailing(ailIn - 0.04);
      const flap = controlSurface(
        (f1.p.x - f0.p.x), f0.p.chord * 0.3, f1.p.chord * 0.3,
        f0.p.chord * f0.p.thickness * 0.6, trimMat,
      );
      flap.scale.x = side;
      flap.position.set(side * f0.p.x, f0.y, f0.z - f0.p.chord * 0.3);
      group.add(flap);

      // Flap track fairings: the little pods that hang below and behind the trailing
      // edge of every airliner wing. Nothing else says "transport aircraft" so fast.
      if (m.wing === 'swept' || m.wing === 'tapered') {
        for (const ft of [0.22, 0.42]) {
          const t = trailing(ft);
          const podLen = t.p.chord * 0.6;
          const pod = new THREE.Mesh(
            fuselageFromStations([
              { z: -0.5 * podLen, w: 0.02, h: 0.02, y: 0, n: 2 },
              { z: -0.18 * podLen, w: t.p.chord * 0.15, h: t.p.chord * 0.15, y: 0, n: 2.4 },
              { z: 0.16 * podLen, w: t.p.chord * 0.15, h: t.p.chord * 0.14, y: 0, n: 2.4 },
              { z: 0.5 * podLen, w: 0.03, h: 0.03, y: 0, n: 2 },
            ], { segments: 12, subdivide: 2 }),
            trimMat,
          );
          pod.position.set(side * t.p.x, t.y - t.p.chord * t.p.thickness * 0.5, t.z - podLen * 0.28);
          pod.castShadow = true;
          group.add(pod);
        }
      }
    }
  }

  // --------------------------------------------------------------------- tail
  const tailZ = len * 0.42;
  const finHeight = Math.max(1.0, len * (cls === 'fighter' ? 0.17 : 0.21));
  const finChord = Math.max(0.9, len * 0.18);
  const finGeo = wing({
    span: finHeight * 2,
    panels: [
      { frac: 0.00, chord: finChord, sweep: 0, dihedral: 0, thickness: 0.115 },
      { frac: 1.00, chord: finChord * 0.46, sweep: Math.tan(42 * Math.PI / 180) * finHeight, dihedral: 0, thickness: 0.085 },
    ],
    stations: 4,
  });
  const stabSpan = m.wingspan * (cls === 'fighter' ? 0.46 : 0.38);
  const stabChord = finChord * 0.74;
  const stabGeo = wing({
    span: stabSpan,
    panels: [
      { frac: 0.00, chord: stabChord, sweep: 0, dihedral: 0, thickness: 0.1 },
      { frac: 1.00, chord: stabChord * 0.45, sweep: Math.tan(32 * Math.PI / 180) * stabSpan * 0.5, dihedral: stabSpan * 0.02, thickness: 0.08 },
    ],
    stations: 3,
  });

  const addFin = (x, z, height, mat, { fillet = true } = {}) => {
    const fin = new THREE.Mesh(finGeo, mat);
    fin.rotation.z = Math.PI / 2;             // stand the half-wing upright, span up
    fin.scale.setScalar(height / finHeight);
    const base = bodyAt(z / len);
    fin.position.set(x, base.y + base.h * 0.42, z);
    fin.castShadow = true;
    group.add(fin);

    if (fillet) {
      // Dorsal fillet: the long shallow wedge from the spine into the fin's leading
      // edge. Real aircraft have one because the fin root needs the area, and it also
      // stops the fin being a sliver seen from dead astern.
      const filletLen = height * 1.6;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(filletLen, 0);
      shape.lineTo(filletLen, height * 0.40);
      shape.quadraticCurveTo(filletLen * 0.44, height * 0.05, 0, 0);
      const dorsal = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, {
          depth: base.w * 0.20, bevelEnabled: true,
          bevelSize: base.w * 0.05, bevelThickness: base.w * 0.04, bevelSegments: 2,
        }),
        mat,
      );
      dorsal.rotation.set(0, -Math.PI / 2, 0);
      dorsal.position.set(x + base.w * 0.10, base.y + base.h * 0.42, z - filletLen + finChord * 0.3);
      dorsal.castShadow = true;
      group.add(dorsal);
    }
    return fin;
  };
  const addStab = (y, z, mat) => {
    const holder = new THREE.Group();
    for (const side of [1, -1]) {
      const s = new THREE.Mesh(stabGeo, mat);
      s.scale.x = side;
      s.castShadow = true;
      holder.add(s);
    }
    holder.position.set(0, y, z);
    group.add(holder);
    return holder;
  };
  const finSweep = Math.tan(42 * Math.PI / 180);
  const addRudder = (x, baseY, z, height) => {
    const rud = controlSurface(height, finChord * 0.3, finChord * 0.18, 0.12, trimMat, {
      vertical: true, sweep: finSweep * height,
    });
    rud.position.set(x, baseY, z + finChord * 0.30);
    group.add(rud);
    return rud;
  };
  const addElevator = (y, z, span, chord) => {
    const holder = new THREE.Group();
    for (const side of [1, -1]) {
      const e = controlSurface(span * 0.5, chord, chord * 0.6, 0.1, trimMat);
      e.scale.x = side;
      holder.add(e);
    }
    holder.position.set(0, y, z);
    group.add(holder);
    return holder;
  };

  if (m.tail === 'twin-boom') {
    for (const side of [1, -1]) {
      const boomLen = len * 0.46;
      const boom = new THREE.Mesh(fuselageFromStations([
        { z: -0.5 * boomLen, w: radius * 0.4, h: radius * 0.4, y: 0, n: 2.2 },
        { z: -0.1 * boomLen, w: radius * 0.62, h: radius * 0.62, y: 0, n: 2.3 },
        { z: 0.26 * boomLen, w: radius * 0.56, h: radius * 0.58, y: 0, n: 2.3 },
        { z: 0.5 * boomLen, w: radius * 0.3, h: radius * 0.34, y: radius * 0.08, n: 2.2 },
      ], { segments: 14, subdivide: 2 }), trimMat);
      boom.rotation.y = 0;
      boom.position.set(side * m.wingspan * 0.2, wingY + radius * 0.16, len * 0.2);
      boom.castShadow = true;
      group.add(boom);

      const fin = new THREE.Mesh(finGeo, trimMat);
      fin.rotation.z = Math.PI / 2;
      fin.scale.setScalar((finHeight * 0.82) / finHeight);
      fin.position.set(side * m.wingspan * 0.2, wingY + radius * 0.3, tailZ);
      fin.castShadow = true;
      group.add(fin);

      const rud = addRudder(side * m.wingspan * 0.2, wingY + radius * 0.3 + finHeight * 0.18, tailZ, finHeight * 0.66);
      if (side > 0) parts.rudder = rud; else parts.rudderSlave = rud;
    }
    const stabY = wingY + radius * 0.3 + finHeight * 0.74;
    parts.stabiliser = addStab(stabY, tailZ, bodyMat);
    parts.elevator = addElevator(stabY, tailZ + stabChord * 0.36, m.wingspan * 0.4, stabChord * 0.3);
  } else if (m.tail === 'canard') {
    const canardSpan = m.wingspan * 0.44;
    const canardChord = finChord * 0.58;
    const canardGeo = wing({
      span: canardSpan,
      panels: [
        { frac: 0.00, chord: canardChord, sweep: 0, dihedral: 0, thickness: 0.06 },
        { frac: 1.00, chord: canardChord * 0.38, sweep: Math.tan(46 * Math.PI / 180) * canardSpan * 0.5, dihedral: canardSpan * 0.01, thickness: 0.05 },
      ],
      stations: 3,
    });
    const canards = new THREE.Group();
    for (const side of [1, -1]) {
      const c = new THREE.Mesh(canardGeo, wingMat);
      c.scale.x = side;
      c.castShadow = true;
      canards.add(c);
    }
    const cz = -len * 0.2;
    const cb = bodyAt(cz / len);
    canards.position.set(0, cb.y + cb.h * 0.16, cz);
    group.add(canards);
    parts.elevator = canards;   // the whole foreplane moves, as on a real canard

    const fin = addFin(0, tailZ, finHeight * 1.06, trimMat);
    parts.rudderFin = fin;
    const fb = bodyAt(tailZ / len);
    parts.rudder = addRudder(0, fb.y + fb.h * 0.42 + finHeight * 0.3, tailZ, finHeight * 0.72);
  } else {
    const fin = addFin(0, tailZ, finHeight, trimMat);
    parts.rudderFin = fin;
    const fb = bodyAt(tailZ / len);
    const finBase = fb.y + fb.h * 0.42;
    parts.rudder = addRudder(0, finBase + finHeight * 0.22, tailZ, finHeight * 0.7);

    const tTail = m.tail === 't-tail';
    const stabY = tTail ? finBase + finHeight * 0.94 : fb.y + fb.h * 0.16;
    const stabZ = tTail
      ? tailZ + finSweep * finHeight * 0.94 + finChord * 0.05
      : tailZ - len * 0.01;
    parts.stabiliser = addStab(stabY, stabZ, bodyMat);
    parts.elevator = addElevator(stabY, stabZ + stabChord * 0.36, stabSpan, stabChord * 0.3);

    // White tail navigation light, facing aft.
    const tailNav = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.09, 7, 6), MAT.glow(0xffffff));
    tailNav.position.set(
      0,
      tTail ? stabY : finBase + finHeight * 0.96,
      tTail ? stabZ + stabChord * 0.5 : tailZ + finSweep * finHeight * 0.9 + finChord * 0.2,
    );
    group.add(tailNav);
    parts.navLights.push(tailNav);
    parts.lights.push(tailNav);
  }

  // Beacon on the spine: red, slow, the light that says the engine is running.
  const spineB = bodyAt(0.04);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.1, 7, 6), MAT.glow(0xff2a2a));
  beacon.position.set(0, spineB.y + spineB.h * 0.52, spineB.z);
  group.add(beacon);
  parts.beacon = beacon;

  // ------------------------------------------------------------------ glazing
  if (cls === 'airliner' || cls === 'commuter') {
    // A flight deck, not a canopy: a wrapped windscreen set into the nose, and a
    // cabin window line down each flank.
    const wz = -len * 0.36;
    const wb = bodyAt(wz / len);
    const screen = new THREE.Mesh(
      new THREE.SphereGeometry(wb.w * 0.52, 16, 10, -Math.PI * 0.62, Math.PI * 1.24, Math.PI * 0.18, Math.PI * 0.3),
      MAT.glass(),
    );
    screen.scale.set(1, 1.05, 1.5);
    screen.position.set(0, wb.y + wb.h * 0.20, wz + wb.w * 0.16);
    group.add(screen);
    parts.canopy = screen;

    const cb = bodyAt(-0.02);
    for (const side of [1, -1]) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, cb.h * 0.08, len * 0.4), MAT.glass(),
      );
      strip.position.set(side * cb.w * 0.49, cb.y + cb.h * 0.14, len * 0.02);
      group.add(strip);
    }
  } else {
    const canopyLen = len * (cls === 'fighter' ? 0.26 : 0.22);
    const cz = cls === 'fighter' ? -len * 0.20 : -len * 0.16;
    const cb = bodyAt(cz / len);
    const glass = new THREE.Mesh(canopy({
      length: canopyLen,
      width: cb.w * 0.74,
      height: cb.h * (cls === 'fighter' ? 0.72 : 0.92),
      rake: cls === 'fighter' ? 0.36 : 0.30,
      tail: cls === 'fighter' ? 0.55 : 0.35,
    }), MAT.glass());
    glass.position.set(0, cb.y + cb.h * 0.44, cz);
    group.add(glass);
    parts.canopy = glass;

    // The frame: a rail along each side and an arch where the windscreen meets the
    // canopy, without which the glass reads as a bubble stuck on the back.
    const bow = new THREE.Mesh(
      new THREE.TorusGeometry(cb.w * 0.37, radius * 0.035, 5, 14, Math.PI),
      darkMat,
    );
    bow.position.set(0, cb.y + cb.h * 0.44, cz - canopyLen * 0.16);
    group.add(bow);
  }

  // ------------------------------------------------------------------ engines
  if (m.engines === 'prop') {
    const count = m.propCount ?? 1;
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      let x = 0, y = 0, z = 0;
      if (count > 1) {
        const t = 0.38;
        const p = planAt(t);
        x = side * p.x;
        y = wingY + p.dihedral + p.chord * 0.04;
        z = wingZ + p.sweep - p.chord * 0.1;
        // A cowl faired onto the wing, tapering to the spinner.
        const cowlLen = len * 0.3;
        const cowl = new THREE.Mesh(fuselageFromStations([
          { z: -0.5 * cowlLen, w: radius * 0.5, h: radius * 0.52, y: 0, n: 2.3 },
          { z: -0.28 * cowlLen, w: radius * 0.86, h: radius * 0.9, y: 0, n: 2.4 },
          { z: 0.1 * cowlLen, w: radius * 0.8, h: radius * 0.84, y: 0, n: 2.4 },
          { z: 0.5 * cowlLen, w: radius * 0.34, h: radius * 0.4, y: radius * 0.04, n: 2.3 },
        ], { segments: 16, subdivide: 2 }), cowlMat);
        cowl.position.set(x, y, z + cowlLen * 0.22);
        cowl.castShadow = true;
        group.add(cowl);
      } else {
        z = -len * 0.5 + radius * 0.1;
        const nb = bodyAt(-0.46);
        y = nb.y;
      }

      // Spinner, then real blades: tapered, twisted, thin at the tip.
      const spinner = new THREE.Mesh(
        fuselageFromStations([
          { z: -radius * 0.5, w: 0.02, h: 0.02, y: 0, n: 2 },
          { z: -radius * 0.24, w: radius * 0.34, h: radius * 0.34, y: 0, n: 2.2 },
          { z: radius * 0.1, w: radius * 0.5, h: radius * 0.5, y: 0, n: 2.2 },
          { z: radius * 0.22, w: radius * 0.46, h: radius * 0.46, y: 0, n: 2.2 },
        ], { segments: 14, subdivide: 2 }), accentMat);
      spinner.position.set(x, y, z - radius * 0.12);
      spinner.castShadow = true;
      group.add(spinner);

      const propGroup = new THREE.Group();
      propGroup.position.set(x, y, z - radius * 0.16);
      const bladeGeo = propBlade(m.propRadius, m.propRadius * 0.28);
      const blades = count > 1 ? 4 : 3;
      for (let b = 0; b < blades; b++) {
        const blade = new THREE.Mesh(bladeGeo, darkMat);
        blade.rotation.z = (b / blades) * Math.PI * 2;
        blade.castShadow = true;
        propGroup.add(blade);
      }
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(m.propRadius, 24),
        new THREE.MeshBasicMaterial({
          color: 0x9fb0c0, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
        }),
      );
      propGroup.add(disc);
      group.add(propGroup);
      parts.props.push(propGroup);
      parts.propDiscs.push(disc);
    }
  } else if (cls === 'fighter') {
    // A fighter's engines live inside the body. Slinging them under the wing in pods
    // was the single most toy-like thing about these models: what a fighter actually
    // shows is an intake on each flank and a nozzle at the tail, and nothing else.
    const count = m.jetCount ?? 1;
    const tb = bodyAt(0.5);
    const nozzleR = tb.h * (count > 1 ? 0.30 : 0.42);
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      const nx = side * (count > 1 ? tb.w * 0.26 : 0);

      // Nozzle: a short convergent can of titanium, set into the tail.
      const nz = new THREE.Mesh(
        fuselageFromStations([
          { z: -len * 0.07, w: nozzleR * 2.1, h: nozzleR * 2.1, y: 0, n: 2.1 },
          { z: -len * 0.02, w: nozzleR * 2.0, h: nozzleR * 2.0, y: 0, n: 2.1 },
          { z: len * 0.012, w: nozzleR * 1.72, h: nozzleR * 1.72, y: 0, n: 2.1 },
          { z: len * 0.026, w: nozzleR * 1.86, h: nozzleR * 1.86, y: 0, n: 2.1 },
        ], { segments: 18, subdivide: 2 }), hotMat);
      nz.position.set(nx, tb.y, tb.z + len * 0.004);
      nz.castShadow = true;
      group.add(nz);

      // The dark inside of it. A disc rather than an open tube, for the same reason
      // the intake throat is one: a tube nested inside the nozzle prints through the
      // tail the moment the two profiles disagree.
      const hole = new THREE.Mesh(
        new THREE.CircleGeometry(nozzleR * 0.88, 18), ductMat,
      );
      hole.rotation.y = Math.PI;
      hole.position.set(nx, tb.y, tb.z - len * 0.03);
      group.add(hole);
      const turbine = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(nozzleR * 0.8, 16), metalMat);
      disc.rotation.y = Math.PI;
      turbine.add(disc);
      for (let b = 0; b < 12; b++) {
        const v = new THREE.Mesh(new THREE.BoxGeometry(nozzleR * 0.1, nozzleR * 0.78, 0.02), darkMat);
        v.position.y = nozzleR * 0.4;
        v.rotation.z = (b / 12) * Math.PI * 2;
        const arm = new THREE.Group();
        arm.rotation.z = (b / 12) * Math.PI * 2;
        const vane = new THREE.Mesh(new THREE.BoxGeometry(nozzleR * 0.12, nozzleR * 0.8, 0.015), darkMat);
        vane.position.y = nozzleR * 0.42;
        arm.add(vane);
        turbine.add(arm);
      }
      turbine.position.set(nx, tb.y, tb.z - len * 0.026);
      group.add(turbine);
      parts.fans.push(turbine);

      // Afterburner plume, lit only on turbo.
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(nozzleR * 0.8, len * 0.34, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x8ab6ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      flame.rotation.x = -Math.PI / 2;
      flame.position.set(nx, tb.y, tb.z + len * 0.17);
      group.add(flame);
      parts.afterburners.push(flame);
    }

    // Side intakes. The duct is genuinely open at the front with a darker throat
    // lofted just inside it, because an intake is a hole: a capped box with a black
    // rectangle across its face reads as a decal, which is what the first attempt at
    // this looked like from every angle.
    const iz = -len * 0.055;
    const ib = bodyAt(iz / len);
    const inLen = len * 0.26;
    const inW = ib.w * 0.26;
    const inH = ib.h * 0.46;
    for (const side of [1, -1]) {
      const inlet = new THREE.Mesh(
        intake({ length: inLen, width: inW, height: inH, n: 3.4 }), bodyMat,
      );
      inlet.position.set(side * (ib.w * 0.5 + inW * 0.22), ib.y - ib.h * 0.10, iz);
      inlet.castShadow = true;
      group.add(inlet);

      // The throat is a dark face set back inside the mouth, not a second duct nested
      // in the first. Nesting one lofted body inside another looks right until the
      // two tapers disagree by a millimetre somewhere along their length, and then
      // the dark one prints straight through the flank as a black slab several metres
      // long - which is exactly what it did. A recessed face cannot do that, and at
      // any angle a player sees it from, it reads the same.
      const throat = new THREE.Mesh(
        new THREE.PlaneGeometry(inW * 0.78, inH * 0.78), ductMat,
      );
      throat.position.set(
        side * (ib.w * 0.5 + inW * 0.22), ib.y - ib.h * 0.10, iz - inLen * 0.34,
      );
      group.add(throat);

      // Splitter plate, holding the lip clear of the fuselage boundary layer. It sits
      // in the gap between duct and flank, which is the only place it is ever seen.
      const splitter = new THREE.Mesh(
        new THREE.BoxGeometry(inW * 0.07, inH * 0.8, inLen * 0.34), darkMat,
      );
      splitter.position.set(side * (ib.w * 0.5 + inW * 0.02), ib.y - ib.h * 0.10, iz - inLen * 0.22);
      group.add(splitter);
    }
  } else {
    // Podded engines on pylons, the airliner arrangement.
    const count = m.jetCount ?? 1;
    const bodyR = radius * slim;
    const nacelleR = bodyR * (count > 1 ? 0.64 : 0.72);
    const nacelleLen = nacelleR * 5.4;
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      const t = 0.42;
      const p = planAt(t);
      const x = count > 1 ? side * p.x : 0;
      const wingSurfaceY = wingY + p.dihedral - p.chord * p.thickness * 0.4;
      const y = count > 1 ? wingSurfaceY - nacelleR * 1.05 : bodyAt(0.3).y;
      const z = count > 1 ? wingZ + p.sweep - p.chord * 0.45 : len * 0.26;

      const duct = new THREE.Mesh(
        new THREE.CylinderGeometry(nacelleR * 0.56, nacelleR * 0.5, nacelleLen * 0.92, 16, 1, true),
        ductMat,
      );
      duct.rotation.x = Math.PI / 2;
      duct.position.set(x, y, z);
      group.add(duct);

      const cowl = new THREE.Mesh(nacelle(nacelleR, nacelleLen, 20), cowlMat);
      cowl.position.set(x, y, z);
      cowl.castShadow = true;
      group.add(cowl);

      // Fan face, set back inside the lip where the light falls off.
      const fan = new THREE.Group();
      const hub = new THREE.Mesh(
        new THREE.ConeGeometry(nacelleR * 0.15, nacelleR * 0.42, 12), metalMat,
      );
      hub.rotation.x = -Math.PI / 2;
      fan.add(hub);
      for (let b = 0; b < 16; b++) {
        const arm = new THREE.Group();
        arm.rotation.z = (b / 16) * Math.PI * 2;
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(nacelleR * 0.15, nacelleR * 0.78, 0.02), metalMat,
        );
        blade.position.y = nacelleR * 0.4;
        blade.rotation.y = 0.5;
        arm.add(blade);
        fan.add(arm);
      }
      fan.position.set(x, y, z - nacelleLen * 0.33);
      group.add(fan);
      parts.fans.push(fan);

      // Exhaust cone in the back of it.
      const cone = new THREE.Mesh(exhaustCone(nacelleR * 0.42, nacelleLen * 0.5, 14), hotMat);
      cone.position.set(x, y, z + nacelleLen * 0.42);
      group.add(cone);

      if (count > 1) {
        // The pylon: a short wing stood on end, reaching from the nacelle up through
        // the wing surface, with a fairing where the two meet.
        const gap = Math.max(nacelleR * 0.5, wingSurfaceY - (y + nacelleR * 0.4));
        const pylon = new THREE.Mesh(wing({
          span: gap * 2.6,
          panels: [
            { frac: 0, chord: nacelleLen * 0.78, sweep: 0, dihedral: 0, thickness: 0.17 },
            { frac: 1, chord: nacelleLen * 0.62, sweep: nacelleLen * 0.12, dihedral: 0, thickness: 0.15 },
          ],
          stations: 2,
        }), trimMat);
        pylon.rotation.z = Math.PI / 2;
        pylon.position.set(x, y + nacelleR * 0.4, z + nacelleLen * 0.06);
        pylon.castShadow = true;
        group.add(pylon);
      } else {
        const flame = new THREE.Mesh(
          new THREE.ConeGeometry(nacelleR * 0.5, len * 0.3, 12, 1, true),
          new THREE.MeshBasicMaterial({
            color: 0x8ab6ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        flame.rotation.x = -Math.PI / 2;
        flame.position.set(x, y, z + nacelleLen * 0.66);
        group.add(flame);
        parts.afterburners.push(flame);
      }
    }
  }

  // ------------------------------------------------------- wingtip light pods
  for (const side of [1, -1]) {
    const tip = planAt(0.97);
    const tipY = wingY + tip.dihedral + (plan.winglet > 0 ? plan.winglet * 0.85 : 0);
    const tipZ = wingZ + tip.sweep + (plan.winglet > 0 ? plan.winglet * 0.3 : 0);
    const tipChord = tip.chord;

    const pod = new THREE.Mesh(
      new THREE.CapsuleGeometry(tipChord * 0.08, tipChord * 0.46, 3, 7), trimMat,
    );
    pod.rotation.x = Math.PI / 2;
    pod.position.set(side * tip.x, tipY, tipZ + tipChord * 0.12);
    group.add(pod);

    const nav = new THREE.Mesh(
      new THREE.SphereGeometry(tipChord * 0.1, 8, 6),
      MAT.glow(side > 0 ? 0x2fff6a : 0xff3344),
    );
    nav.position.set(side * tip.x, tipY, tipZ - tipChord * 0.16);
    group.add(nav);
    parts.navLights.push(nav);
    parts.lights.push(nav);

    const strobe = new THREE.Mesh(new THREE.SphereGeometry(tipChord * 0.08, 8, 6), MAT.glow(0xffffff));
    strobe.position.set(side * tip.x, tipY, tipZ + tipChord * 0.4);
    group.add(strobe);
    parts.strobes.push(strobe);

    // Landing light recessed into the wing leading edge.
    const ll = planAt(0.24);
    const lz = wingZ + ll.sweep - ll.chord * 0.2;
    const ly = wingY + ll.dihedral - ll.chord * ll.thickness * 0.18;
    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.15, radius * 0.12, radius * 0.1, 10), darkMat,
    );
    socket.rotation.x = Math.PI / 2;
    socket.position.set(side * ll.x, ly, lz);
    group.add(socket);

    const landing = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.11, 8, 6), MAT.glow(0xfff3d0));
    landing.scale.z = 0.4;
    landing.position.set(side * ll.x, ly, lz - radius * 0.03);
    group.add(landing);
    parts.landingLights.push(landing);
  }

  // ---------------------------------------------------------------------- gear
  const gearGroup = new THREE.Group();
  const groundClear = Math.max(...BODY[cls].map((s) => -(s.y - s.h * 0.5))) * radius;
  const legLen = groundClear * 0.55 + radius * 0.5;

  const addLeg = (x, z, main) => {
    const bb = bodyAt(z / len);
    const top = main ? wingY : bb.y - bb.h * 0.42;
    const wheelR = radius * (main ? 0.3 : 0.22);
    const tyreW = radius * (main ? 0.16 : 0.12);

    // Oleo: a polished inner tube inside a wider outer one, which is what a strut is.
    const outer = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.075, radius * 0.075, legLen * 0.55, 8), darkMat,
    );
    outer.position.set(x, top - legLen * 0.27, z);
    gearGroup.add(outer);
    const inner = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.052, radius * 0.052, legLen * 0.6, 8), metalMat,
    );
    inner.position.set(x, top - legLen * 0.68, z);
    gearGroup.add(inner);

    // Axle and wheels. Mains get a pair, the nose leg a single.
    const wheels = main ? [-1, 1] : [0];
    for (const w of wheels) {
      const tyre = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelR, wheelR, tyreW, 14), rubberMat,
      );
      tyre.rotation.z = Math.PI / 2;
      tyre.position.set(x + w * tyreW * 0.8, top - legLen + wheelR, z);
      tyre.castShadow = true;
      gearGroup.add(tyre);
      const hubm = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelR * 0.5, wheelR * 0.5, tyreW * 1.06, 10), metalMat,
      );
      hubm.rotation.z = Math.PI / 2;
      hubm.position.copy(tyre.position);
      gearGroup.add(hubm);
      parts.gear.push(tyre);
    }

    // Torque link, and a door on the fuselage side of the leg.
    const link = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 0.03, legLen * 0.34, radius * 0.06), metalMat,
    );
    link.position.set(x + radius * 0.07, top - legLen * 0.5, z + radius * 0.04);
    link.rotation.x = 0.25;
    gearGroup.add(link);

    const door = new THREE.Mesh(
      new THREE.BoxGeometry(main ? 0.05 : 0.04, legLen * 0.46, main ? legLen * 0.46 : legLen * 0.38),
      bodyMat,
    );
    door.position.set(x + (main ? Math.sign(x) * 0.13 : 0.1), top - legLen * 0.24, z);
    gearGroup.add(door);
  };
  addLeg(0, -len * 0.33, false);
  addLeg(m.wingspan * 0.15, len * 0.05, true);
  addLeg(-m.wingspan * 0.15, len * 0.05, true);
  group.add(gearGroup);
  parts.gearGroup = gearGroup;

  group.userData.parts = parts;
  group.userData.spec = spec;
  group.userData.anim = { propPhase: 0, fanPhase: 0, gearBlend: 1, strobe: 0, beacon: 0 };
  return group;
}

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Per-frame animation: propeller/fan, control surfaces following the player's input,
 * gear retraction, and the light rhythms an aircraft actually keeps - navigation
 * lights steady, a beacon at about one a second, strobes in a double flash. Purely
 * visual feedback for physics that has already happened (spec §66).
 */
export function animateAircraft(group, dt, telemetry, control) {
  const parts = group.userData.parts;
  const anim = group.userData.anim;
  if (!parts || !anim) return;

  // Propeller: spin rate follows power, and the disc fades in as the blades blur.
  const rpm = 8 + telemetry.throttle * 46 + telemetry.speed * 0.12;
  anim.propPhase += rpm * dt;
  for (const p of parts.props) p.rotation.z = anim.propPhase;
  for (const disc of parts.propDiscs ?? []) {
    disc.material.opacity = clamp01(0.04 + telemetry.throttle * 0.2);
  }
  // Fans spool with the engine but never look stopped in flight.
  anim.fanPhase += (12 + telemetry.throttle * 70) * dt;
  for (const f of parts.fans ?? []) f.rotation.z = anim.fanPhase;

  // Afterburner cone: only visible on turbo, scaled by how hard it is working.
  const burn = telemetry.turbo ? 1 : 0;
  for (const f of parts.afterburners) {
    f.material.opacity = damp(f.material.opacity, burn * 0.85, 9, dt);
    const flicker = 1 + Math.sin(performance.now() * 0.05) * 0.09;
    const target = burn ? flicker : 0.25;
    f.scale.set(target, target, target);
    f.visible = f.material.opacity > 0.02;
  }

  // Control surfaces mirror the commanded input. These are hinges now, so the
  // deflection swings the trailing edge.
  if (control) {
    const defl = 0.42;
    if (parts.aileronRight) parts.aileronRight.rotation.x = -control.roll * defl;
    if (parts.aileronLeft) parts.aileronLeft.rotation.x = control.roll * defl;
    if (parts.elevator) parts.elevator.rotation.x = -control.pitch * defl * 0.7;
    if (parts.rudder) parts.rudder.rotation.y = -control.yaw * defl;
    if (parts.rudderSlave) parts.rudderSlave.rotation.y = -control.yaw * defl;
  }

  // Gear: slide up into the fuselage and switch off once stowed.
  const wantGear = telemetry.gearDown ? 1 : 0;
  anim.gearBlend = damp(anim.gearBlend, wantGear, 3.2, dt);
  if (parts.gearGroup) {
    parts.gearGroup.visible = anim.gearBlend > 0.03;
    parts.gearGroup.position.y = lerp(1.1, 0, anim.gearBlend);
    parts.gearGroup.scale.setScalar(lerp(0.2, 1, anim.gearBlend));
  }
  // Landing lights come on with the gear, which is when a real one uses them.
  for (const l of parts.landingLights ?? []) {
    l.material.opacity = anim.gearBlend * 0.95;
    l.visible = anim.gearBlend > 0.05;
  }

  // Navigation lights are steady. The old code flashed them along with everything
  // else, which is the one thing a navigation light never does.
  for (const l of parts.navLights ?? []) l.material.opacity = 0.95;

  // Strobes: a double flash, then a long gap.
  anim.strobe += dt;
  const cycle = anim.strobe % 1.6;
  const flashing = cycle < 0.06 || (cycle > 0.16 && cycle < 0.22);
  for (const l of parts.strobes ?? []) {
    l.material.opacity = flashing ? 1 : 0;
    l.visible = flashing;
  }

  // Beacon: slower, red, and it fades rather than blinks.
  anim.beacon += dt;
  if (parts.beacon) {
    const phase = (anim.beacon % 1.1) / 1.1;
    parts.beacon.material.opacity = Math.max(0, Math.sin(phase * Math.PI) ** 6);
  }
}

/** Frees the geometry and materials this factory created. */
export function disposeAircraft(group) {
  const seen = new Set();
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose?.(); }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mm of mats) {
      if (mm && !seen.has(mm)) { seen.add(mm); mm.dispose?.(); }
    }
  });
}
