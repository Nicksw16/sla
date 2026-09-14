import * as THREE from 'three';

/**
 * Aircraft geometry primitives.
 *
 * The rule here is that nothing is a primitive solid. A fuselage built as a lathe is
 * a body of revolution, and a body of revolution is the one shape no real aircraft
 * has: real fuselages are non-circular, they carry a cockpit, they are waisted where
 * the wing passes through, and their tail cone rises. Every one of those is a
 * silhouette cue the eye reads before it reads any surface detail, so all of it is
 * built from lofted sections rather than approximated with a cylinder.
 *
 * Everything is procedural and in the same metres the flight model uses.
 */

/**
 * One cross-section of a body, as a superellipse.
 *
 *   |x/a|^n + |y/b|^n = 1
 *
 * n = 2 is an ellipse, n = 4 is a rounded rectangle, n below 2 tends toward a
 * diamond. Real fuselages are rarely circular: an airliner is a pair of circular
 * arcs joined at the cabin floor (the "double bubble"), and a fighter forebody is
 * closer to a rounded triangle. One knob covers that whole range.
 */
export function superellipse(width, height, n = 2, segments = 24, yOffset = 0) {
  const pts = [];
  const a = width * 0.5;
  const b = height * 0.5;
  const e = 2 / n;
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(new THREE.Vector2(
      Math.sign(c) * Math.pow(Math.abs(c), e) * a,
      Math.sign(s) * Math.pow(Math.abs(s), e) * b + yOffset,
    ));
  }
  return pts;
}

/**
 * Lofts a surface through equally sized rings of points.
 *
 * Rings run root to tip (or nose to tail); the winding is chosen so the outside
 * faces out. Degenerate rings - a nose or tail that closes to a point - are welded
 * to a single vertex rather than left as a ring of coincident points, because a
 * fan of zero-area triangles produces garbage normals right on the nose, which is
 * the most-looked-at part of the whole model.
 */
export function loft(rings, { capTip = true, capRoot = false, smooth = true } = {}) {
  const ringSize = rings[0].length;
  const position = [];
  const index = [];
  for (const ring of rings) for (const p of ring) position.push(p.x, p.y, p.z);

  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < ringSize; i++) {
      const j = (i + 1) % ringSize;
      const a = s * ringSize + i;
      const b = s * ringSize + j;
      const c = (s + 1) * ringSize + i;
      const d = (s + 1) * ringSize + j;
      index.push(a, c, b, b, c, d);
    }
  }

  const capRing = (ringIndex, flip) => {
    const centre = new THREE.Vector3();
    for (const p of rings[ringIndex]) centre.add(p);
    centre.multiplyScalar(1 / ringSize);
    const centreIdx = position.length / 3;
    position.push(centre.x, centre.y, centre.z);
    for (let i = 0; i < ringSize; i++) {
      const a = ringIndex * ringSize + i;
      const b = ringIndex * ringSize + ((i + 1) % ringSize);
      if (flip) index.push(centreIdx, b, a);
      else index.push(centreIdx, a, b);
    }
  };
  if (capTip) capRing(rings.length - 1, false);
  if (capRoot) capRing(0, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  if (smooth) geo.computeVertexNormals();
  else { geo.deleteAttribute('normal'); geo.computeVertexNormals(); }
  return geo;
}

/**
 * A fuselage lofted through a list of stations.
 *
 * Each station is { z, w, h, y, n }: position along the body in metres, width and
 * height of the section, how far the section centre is raised, and the superellipse
 * exponent. Stations are resampled with a Catmull-Rom pass so a handful of control
 * stations produce a smoothly swelling body rather than a faceted one.
 */
export function fuselageFromStations(stations, { segments = 24, subdivide = 3 } = {}) {
  const dense = resampleStations(stations, subdivide);
  const rings = dense.map((st) => {
    const sec = superellipse(st.w, st.h, st.n, segments, st.y);
    return sec.map((p) => new THREE.Vector3(p.x, p.y, st.z));
  });
  return loft(rings, { capTip: true, capRoot: true });
}

/** Catmull-Rom between stations, so a few control points give a smooth hull. */
function resampleStations(stations, subdivide) {
  if (subdivide <= 1) return stations;
  const keys = ['z', 'w', 'h', 'y', 'n'];
  const curves = {};
  for (const k of keys) {
    curves[k] = new THREE.SplineCurve(
      stations.map((s, i) => new THREE.Vector2(i / (stations.length - 1), s[k] ?? 0)),
    );
  }
  const out = [];
  const count = (stations.length - 1) * subdivide + 1;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const st = {};
    for (const k of keys) st[k] = curves[k].getPoint(t).y;
    // Width and height must never cross zero, or the section inverts.
    st.w = Math.max(st.w, 0.0005);
    st.h = Math.max(st.h, 0.0005);
    st.n = Math.max(st.n, 1.2);
    out.push(st);
  }
  return out;
}

/**
 * Symmetric four-digit section, trailing edge round the top to the leading edge and
 * back along the bottom, in chord units: x from 0 at the leading edge to 1 at the
 * trailing edge, y as half-thickness.
 */
export function airfoil(thickness = 0.12, steps = 9) {
  const yt = (x) => 5 * thickness * (
    0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4
  );
  const upper = [];
  const lower = [];
  for (let i = 0; i <= steps; i++) {
    // Cosine spacing: points bunch at the leading edge, which is where the curve is.
    const x = 0.5 * (1 - Math.cos((i / steps) * Math.PI));
    upper.push(new THREE.Vector2(x, yt(x)));
    lower.push(new THREE.Vector2(x, -yt(x)));
  }
  return [...upper.slice(0, -1).reverse(), ...lower.slice(1)];
}

/**
 * A half wing, root at x=0 running out to +x, chord along z (nose at -z).
 *
 * `panels` lets the planform kink: an airliner's inner wing is far less swept than
 * its outer wing, a delta has a leading-edge extension ahead of the main panel, and
 * a straight wing has a stub of constant chord before it starts tapering. One list
 * of breakpoints covers all of them, and a kinked leading edge is one of the first
 * things that separates an aircraft silhouette from a paper dart.
 *
 * Each panel is { frac, chord, sweep, dihedral, thickness, twist } where frac is the
 * fraction of half-span at which that breakpoint sits.
 */
export function wing({ span, panels, thickness = 0.11, stations = 4, winglet = 0, wingletSweep = 0.35 }) {
  const half = span * 0.5;
  const rings = [];
  const pushStation = (t) => {
    const p = interpPanels(panels, t);
    const section = airfoil(p.thickness ?? thickness, 9);
    const x = half * t;
    const y = p.dihedral;
    const z = p.sweep;
    const cos = Math.cos(p.twist);
    const sin = Math.sin(p.twist);
    rings.push(section.map((s) => {
      const cz = (s.x - 0.25) * p.chord;
      const cy = s.y * p.chord;
      return new THREE.Vector3(x, y + cy * cos - cz * sin, z + cz * cos + cy * sin);
    }));
  };

  // A station at every breakpoint, plus intermediate ones so the surface curves.
  for (let i = 0; i < panels.length; i++) {
    const a = panels[i].frac;
    pushStation(a);
    if (i < panels.length - 1) {
      const b = panels[i + 1].frac;
      for (let s = 1; s < stations; s++) pushStation(a + (b - a) * (s / stations));
    }
  }

  if (winglet > 0) {
    // The tip turns up over four short stations, shrinking around its own centre and
    // sweeping back as it rises, rather than stopping in a flat cut.
    const tip = rings[rings.length - 1];
    const anchor = new THREE.Vector3();
    for (const p of tip) anchor.add(p);
    anchor.multiplyScalar(1 / tip.length);
    for (let k = 1; k <= 4; k++) {
      const t = k / 4;
      const shrink = 1 - 0.55 * t;
      const rise = winglet * Math.pow(t, 0.8);
      rings.push(tip.map((p) => new THREE.Vector3(
        anchor.x + (p.x - anchor.x) * shrink + winglet * 0.12 * t,
        anchor.y + (p.y - anchor.y) * shrink + rise,
        anchor.z + (p.z - anchor.z) * shrink + wingletSweep * rise,
      )));
    }
  }

  return loft(rings, { capTip: true, capRoot: true });
}

/** Linear interpolation of the panel breakpoints at a given span fraction. */
function interpPanels(panels, t) {
  let i = 0;
  while (i < panels.length - 2 && panels[i + 1].frac < t) i++;
  const a = panels[i];
  const b = panels[i + 1] ?? a;
  const span = Math.max(1e-5, b.frac - a.frac);
  const k = Math.min(1, Math.max(0, (t - a.frac) / span));
  const lerp = (p, q) => p + (q - p) * k;
  return {
    chord: lerp(a.chord, b.chord),
    sweep: lerp(a.sweep ?? 0, b.sweep ?? 0),
    dihedral: lerp(a.dihedral ?? 0, b.dihedral ?? 0),
    thickness: lerp(a.thickness ?? 0.11, b.thickness ?? 0.11),
    twist: lerp(a.twist ?? 0, b.twist ?? 0),
  };
}

/**
 * The fairing where a wing meets a body.
 *
 * Real aircraft never join a wing to a fuselage at a bare corner - the junction is
 * filled with a fillet that starts ahead of the leading edge and runs well aft of
 * the trailing edge. Leaving it out is what makes a model read as parts bolted
 * together rather than one aeroplane, and a squashed sphere in its place reads as a
 * blister. This lofts a proper one: a section that starts as a thin sliver on the
 * wing and swells into the body.
 */
export function wingFairing({ length, height, width, rootZ, stations = 9 }) {
  // Built as a closed lens rather than a half-section clipped at x=0. Clipping left a
  // degenerate edge where every vertex of the inner half collapsed onto one line,
  // which inverts the winding along that seam and lights the fairing from the inside -
  // it came out as a bright blister glued to the flank, which is worse than the bare
  // corner it was meant to hide. Most of this body is buried in the wing and the
  // fuselage; only the outer sliver of it is ever seen.
  const st = [];
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    // Fat just aft of mid, drawn to a point at each end: a fairing always runs
    // further behind the trailing edge than it does ahead of the leading edge.
    const bulge = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.62);
    st.push({
      z: rootZ + (t - 0.5) * length,
      w: Math.max(0.002, width * bulge),
      h: Math.max(0.002, height * bulge),
      y: 0,
      n: 2.5,
    });
  }
  return fuselageFromStations(st, { segments: 16, subdivide: 2 });
}

/**
 * Engine nacelle: an inlet lip that curls from the duct out to the cowl, a cowl,
 * and a tapered exhaust. Drawn as one surface of revolution so the inside of the
 * intake is real geometry - a cylinder with a dark disc on the front is the thing
 * that always reads as a prop rather than an engine.
 */
export function nacelle(radius, length, segments = 20, { scoop = 0 } = {}) {
  const r = radius;
  const l = length;
  const profile = [
    [r * 0.54, -l * 0.42],   // inner duct, deep
    [r * 0.60, -l * 0.47],   // duct mouth
    [r * 0.70, -l * 0.505],  // lip, curling outward
    [r * 0.86, -l * 0.503],
    [r * 0.96, -l * 0.46],
    [r * 1.00, -l * 0.30],   // cowl, widest just aft of the lip
    [r * 0.99, l * 0.02],
    [r * 0.93, l * 0.26],    // boat tail
    [r * 0.80, l * 0.42],
    [r * 0.66, l * 0.5],     // nozzle
  ];
  const rings = [];
  for (const [rr, zz] of profile) {
    // A scoop flattens the underside, the way a fighter intake is not round.
    const sec = superellipse(rr * 2, rr * 2 * (1 - scoop * 0.28), 2 + scoop * 1.4, segments,
      -rr * scoop * 0.1);
    rings.push(sec.map((p) => new THREE.Vector3(p.x, p.y, zz)));
  }
  return loft(rings, { capTip: false, capRoot: false });
}

/**
 * A fighter's side intake: a rectangular lip standing proud of the flank, opening
 * into a duct that narrows as it runs aft into the body.
 *
 * Open at the front on purpose. A capped box with a black rectangle painted across
 * its face reads as a sticker; leaving the mouth genuinely open, with a darker throat
 * lofted just inside it, is what gives an intake the depth the eye is looking for.
 */
export function intake({ length, width, height, n = 3.2, segments = 18, taper = 0.66 }) {
  const prof = [
    [1.00, -0.50],   // lip
    [1.07, -0.455],  // the lip rolls outward, as a real one does
    [1.03, -0.30],
    [0.98, 0.02],
    [taper, 0.50],
  ];
  const rings = prof.map(([sc, z]) =>
    superellipse(width * sc, height * sc, n, segments).map((q) => new THREE.Vector3(q.x, q.y, z * length)));
  return loft(rings, { capTip: true, capRoot: false });
}

/** The exhaust cone sitting inside the nozzle, visible from behind. */
export function exhaustCone(radius, length, segments = 16) {
  const rings = [];
  const profile = [[radius, -length * 0.5], [radius * 0.92, 0], [radius * 0.5, length * 0.34], [0.01, length * 0.5]];
  for (const [r, z] of profile) {
    rings.push(superellipse(r * 2, r * 2, 2, segments).map((p) => new THREE.Vector3(p.x, p.y, z)));
  }
  return loft(rings, { capTip: true, capRoot: true });
}

/** A propeller blade: tapered, twisted, and thin at the tip. */
export function propBlade(radius, chord) {
  const section = airfoil(0.13, 6);
  const rings = [];
  const stations = 6;
  for (let s = 0; s < stations; s++) {
    const t = s / (stations - 1);
    const c = chord * (1 - 0.5 * t) * (t < 0.14 ? 0.55 : 1);
    const angle = 0.95 + (0.26 - 0.95) * t;   // coarse at the root, fine at the tip
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    rings.push(section.map((p) => {
      const cx = (p.x - 0.4) * c;
      const cy = p.y * c;
      return new THREE.Vector3(radius * (0.07 + 0.93 * t), cy * cos - cx * sin, cx * cos + cy * sin);
    }));
  }
  return loft(rings, { capTip: true, capRoot: true });
}

/**
 * Canopy glazing lofted along the spine rather than a sphere dropped on top.
 *
 * A windscreen is flat-ish and steeply raked, the canopy behind it is a curved
 * bubble, and the whole thing fairs back into the spine. A scaled sphere gets none
 * of those and reads as a glass blister every time.
 */
export function canopy({ length, width, height, rake = 0.42, tail = 0.5, segments = 18 }) {
  const rings = [];
  const stations = 11;
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    // Rises fast over the windscreen, holds through the canopy, fairs away aft.
    const rise = t < rake
      ? Math.pow(t / rake, 0.72)
      : 1 - Math.pow((t - rake) / (1 - rake), 1.7) * tail;
    const w = width * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.45);
    const h = height * rise;
    const sec = superellipse(Math.max(w, 0.001), Math.max(h, 0.001) * 2, 2.5, segments, 0);
    // Only the top half: the glazing sits on the fuselage, it does not wrap under it.
    rings.push(sec.map((p) => new THREE.Vector3(p.x, Math.max(p.y, 0) * 0.5, (t - 0.5) * length)));
  }
  return loft(rings, { capTip: true, capRoot: true });
}
