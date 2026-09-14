import * as THREE from 'three';

/**
 * Aircraft geometry primitives.
 *
 * The factory used to build wings by extruding a flat outline, which gives a plate of
 * constant thickness with square edges - the single thing that reads as "game model"
 * from any angle. Everything here exists to replace that with surfaces an aircraft
 * actually has: a section with a rounded leading edge and a sharp trailing one, chord
 * that tapers toward the tip, sweep, dihedral and washout, and an engine with a lip
 * you can see into.
 *
 * It is all still procedural and still measured in the same metres the flight model
 * uses, so nothing downstream has to know the shapes got better.
 */

/**
 * Symmetric four-digit section, trailing edge round the top to the leading edge and
 * back along the bottom. Returns points in chord units: x from 0 at the leading edge
 * to 1 at the trailing edge, y as half-thickness.
 */
export function airfoil(thickness = 0.12, steps = 9) {
  const yt = (x) => 5 * thickness * (
    0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4
  );
  const upper = [];
  const lower = [];
  for (let i = 0; i <= steps; i++) {
    // Cosine spacing: points bunch up at the leading edge, which is where the curve is.
    const x = 0.5 * (1 - Math.cos((i / steps) * Math.PI));
    upper.push(new THREE.Vector2(x, yt(x)));
    lower.push(new THREE.Vector2(x, -yt(x)));
  }
  // One closed loop, trailing edge first, no duplicated points at either end.
  return [...upper.slice(0, -1).reverse(), ...lower.slice(1)];
}

/**
 * Lofts a surface through a list of equally sized rings of points and caps the last
 * one. Rings run root to tip; the winding is chosen so the outside faces out.
 */
export function loft(rings, { capTip = true, capRoot = false } = {}) {
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
  geo.computeVertexNormals();
  return geo;
}

/**
 * A half wing, root at x=0 running out to +x, chord along z (nose at -z).
 *
 * Taper, sweep, dihedral and washout are what make a wing look like it was designed
 * rather than cut out: the tip is smaller than the root, set back from it, slightly
 * higher, and twisted a degree or two nose-down.
 */
export function halfWing({
  span, rootChord, taper = 0.55, sweep = 0.25, dihedral = 0.035,
  thickness = 0.11, twist = -0.035, winglet = 0, stations = 7,
}) {
  const section = airfoil(thickness);
  const rings = [];
  const half = span * 0.5;

  for (let s = 0; s < stations; s++) {
    const t = s / (stations - 1);
    const chord = rootChord * (1 - (1 - taper) * t);
    const x = half * t;
    const z = sweep * rootChord * t;          // sweep back
    const y = dihedral * half * t;            // dihedral up
    const angle = twist * t;                  // washout, nose down toward the tip
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    rings.push(section.map((p) => {
      // Section x runs leading to trailing edge; place it along the chord in z.
      const cz = (p.x - 0.25) * chord;        // quarter-chord at the reference line
      const cy = p.y * chord;
      return new THREE.Vector3(x, y + cy * cos - cz * sin, z + cz * cos + cy * sin);
    }));
  }

  if (winglet > 0) {
    // The tip turns up over three short stations rather than stopping flat. Built by
    // carrying the tip section upward and shrinking it around its own centre, which
    // gives a swept fin without needing a rotated frame.
    const tip = rings[rings.length - 1];
    const anchor = new THREE.Vector3();
    for (const p of tip) anchor.add(p);
    anchor.multiplyScalar(1 / tip.length);
    for (let k = 1; k <= 3; k++) {
      const t = k / 3;
      const shrink = 1 - 0.45 * t;
      rings.push(tip.map((p) => new THREE.Vector3(
        anchor.x + (p.x - anchor.x) * shrink + winglet * 0.2 * t,
        anchor.y + (p.y - anchor.y) * shrink + winglet * t,
        anchor.z + (p.z - anchor.z) * shrink + winglet * 0.3 * t,
      )));
    }
  }

  return loft(rings, { capTip: true, capRoot: true });
}

/**
 * Fuselage of revolution with a rounded nose, a full mid-section and a tapered tail.
 * More segments than the old lathe: at chase-camera distance the facets were visible
 * along the top of the nose.
 */
export function fuselage(length, radius, { nose = 'round', segments = 22 } = {}) {
  const profile = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = nose === 'sharp'
      ? Math.sin(Math.pow(t, 0.62) * Math.PI) ** 0.72
      : Math.sin(Math.pow(t, 0.5) * Math.PI) ** 0.55;
    profile.push(new THREE.Vector2(Math.max(0.035, r * radius), (t - 0.5) * length));
  }
  const geo = new THREE.LatheGeometry(profile, segments);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Engine nacelle: an inlet lip that curls from the duct out to the cowl, a straight
 * cowl, and a tapered exhaust. Drawn as one surface of revolution so the inside of
 * the intake is real geometry - a cylinder with a dark disc on the front is the thing
 * that always reads as a prop rather than an engine.
 */
export function nacelle(radius, length, segments = 18) {
  const r = radius;
  const l = length;
  const profile = [
    new THREE.Vector2(r * 0.58, -l * 0.46),   // inner duct, deep
    new THREE.Vector2(r * 0.62, -l * 0.5),    // duct mouth
    new THREE.Vector2(r * 0.74, -l * 0.53),   // lip, curling outward
    new THREE.Vector2(r * 0.9, -l * 0.52),
    new THREE.Vector2(r * 0.99, -l * 0.46),
    new THREE.Vector2(r, -l * 0.3),           // cowl
    new THREE.Vector2(r, l * 0.1),
    new THREE.Vector2(r * 0.88, l * 0.34),    // boat tail
    new THREE.Vector2(r * 0.7, l * 0.5),      // nozzle
  ];
  const geo = new THREE.LatheGeometry(profile, segments);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A propeller blade: tapered, twisted, and thin at the tip. */
export function propBlade(radius, chord) {
  const section = airfoil(0.14, 6);
  const rings = [];
  const stations = 5;
  for (let s = 0; s < stations; s++) {
    const t = s / (stations - 1);
    const c = chord * (1 - 0.55 * t) * (t < 0.12 ? 0.6 : 1);
    const angle = lerpAngle(0.95, 0.28, t);   // coarse at the root, fine at the tip
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    rings.push(section.map((p) => {
      const cx = (p.x - 0.4) * c;
      const cy = p.y * c;
      return new THREE.Vector3(radius * (0.08 + 0.92 * t), cy * cos - cx * sin, cx * cos + cy * sin);
    }));
  }
  return loft(rings, { capTip: true, capRoot: true });
}

function lerpAngle(a, b, t) {
  return a + (b - a) * t;
}
