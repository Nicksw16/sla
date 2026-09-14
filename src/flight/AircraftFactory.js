import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/MathUtils.js';
import { PAINTS } from '../data/upgrades.js';
import { halfWing, fuselage, nacelle, propBlade, airfoil, loft } from './AircraftGeometry.js';

/**
 * Builds aircraft out of geometry at runtime (no art assets are available, so
 * everything here is procedural — spec §139-140 permits functional stand-ins so
 * long as the system can accept real art later; swapping in a glTF only means
 * replacing build() and keeping the same part names).
 *
 * Each class gets a genuinely different silhouette, because "the aircraft really
 * are different" is a stated pillar and a recoloured mesh does not deliver it (§56).
 * Parts are named so the animation pass can find them: prop, gear, ailerons,
 * elevator, rudder, afterburner.
 *
 * What makes these read as aircraft rather than as assembled primitives is mostly not
 * polygon count. It is that the wings have a section and a taper, the control surfaces
 * hinge at their leading edge instead of spinning about their middle, the intakes are
 * open, and the paint, the metal, the rubber and the glass are four materials that
 * answer the light differently.
 */

const MAT = {
  // Paint over aluminium: barely metallic, or with no environment to reflect it goes
  // black. The sheen comes from roughness, not from metalness.
  paint: (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.24, roughness: 0.38 }),
  trim: (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.32 }),
  // Bare metal: engine cowls, exhausts, oleos.
  metal: (color = 0x9aa3ad) => new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.28 }),
  // Anything structural and unpainted: hinges, ducts, antennas.
  dark: () => new THREE.MeshStandardMaterial({ color: 0x1b2028, metalness: 0.55, roughness: 0.55 }),
  // Tyres: no metal at all, and rough enough to stay matt in any light.
  rubber: () => new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.0, roughness: 0.94 }),
  // Canopy glazing: a tinted, smooth, reflective surface rather than a dark hole.
  glass: () => new THREE.MeshStandardMaterial({
    color: 0x2c4f63, metalness: 0.6, roughness: 0.07,
    transparent: true, opacity: 0.62, envMapIntensity: 1.4,
  }),
  // Inside the intake and the exhaust: dark, so the duct reads as depth.
  duct: () => new THREE.MeshStandardMaterial({ color: 0x0d1014, metalness: 0.4, roughness: 0.7, side: THREE.DoubleSide }),
  glow: (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
};

/**
 * A control surface that hinges at its leading edge. The group is the hinge, the mesh
 * sits behind it, so a deflection swings the trailing edge instead of rotating the
 * panel about its own centre - which is what an aileron on a real wing does and what
 * the old one, a box spinning about its middle, did not.
 */
function hinged(width, chord, thickness, material, { vertical = false } = {}) {
  const pivot = new THREE.Group();
  const box = vertical
    ? new THREE.BoxGeometry(thickness, width, chord)
    : new THREE.BoxGeometry(width, thickness, chord);
  const mesh = new THREE.Mesh(box, material);
  mesh.position.z = chord * 0.5;
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

/** Wing parameters per class: the shape differences that make a silhouette. */
function wingPlan(kind, span, rootChord) {
  switch (kind) {
    case 'delta':
      // A taper of 0.14 gave a tip so small the outer wing vanished at range and the
      // navigation lights read as beads floating in air. 0.22 is still a delta.
      return { span, rootChord, taper: 0.22, sweep: 1.5, dihedral: 0.01, thickness: 0.09, winglet: 0 };
    case 'swept':
      return { span, rootChord, taper: 0.42, sweep: 0.85, dihedral: 0.045, thickness: 0.1, winglet: rootChord * 0.5 };
    case 'tapered':
      return { span, rootChord, taper: 0.6, sweep: 0.18, dihedral: 0.05, thickness: 0.12, winglet: 0 };
    default: // straight
      return { span, rootChord, taper: 0.72, sweep: 0.06, dihedral: 0.055, thickness: 0.14, winglet: 0 };
  }
}

export function buildAircraft(spec, paintId = 'factory') {
  const m = spec.model;
  const paint = PAINTS[paintId] ?? PAINTS.factory;
  const bodyMat = MAT.paint(paint.body);
  const trimMat = MAT.trim(paint.trim);
  const accentMat = MAT.trim(m.colorAccent ?? 0xffffff);
  const darkMat = MAT.dark();
  const metalMat = MAT.metal();
  const rubberMat = MAT.rubber();
  const ductMat = MAT.duct();

  const group = new THREE.Group();
  group.name = `aircraft:${spec.id}`;
  const parts = {
    props: [], propDiscs: [], afterburners: [], gear: [], lights: [],
    navLights: [], strobes: [], fans: [], landingLights: [],
  };

  const len = m.length;
  const radius = Math.max(0.42, len * 0.085);
  const isJet = m.engines === 'jet';

  // ---- fuselage
  const fuse = new THREE.Mesh(fuselage(len, radius, { nose: isJet ? 'sharp' : 'round' }), bodyMat);
  fuse.castShadow = true;
  fuse.receiveShadow = true;
  group.add(fuse);

  // A spine fairing along the top: the line that stops a fuselage of revolution from
  // reading as a cigar.
  const spine = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius * 0.3, len * 0.34, 4, 8),
    trimMat,
  );
  spine.rotation.x = Math.PI / 2;
  spine.position.set(0, radius * 0.72, len * 0.1);
  spine.castShadow = true;
  group.add(spine);

  // ---- main wing
  const rootChord = Math.max(1.1, m.wingspan * (m.wing === 'delta' ? 0.42 : 0.22));
  const plan = wingPlan(m.wing, m.wingspan, rootChord);
  const wingGeo = halfWing(plan);
  const wingZ = m.wing === 'delta' ? len * 0.1 : -len * 0.02;
  const wingY = m.wing === 'delta' ? -radius * 0.25 : radius * 0.05;

  for (const side of [1, -1]) {
    const w = new THREE.Mesh(wingGeo, bodyMat);
    w.scale.x = side;
    w.position.set(0, wingY, wingZ);
    w.castShadow = true;
    w.receiveShadow = true;
    group.add(w);

    // Wing root fairing, where the wing meets the body.
    const fillet = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.62, 8, 6),
      bodyMat,
    );
    fillet.scale.set(0.5, 0.45, rootChord / (radius * 0.62) * 0.5);
    fillet.position.set(side * radius * 0.55, wingY, wingZ + rootChord * 0.05);
    group.add(fillet);

    // Aileron on the outer trailing edge, hinged.
    const tipChord = rootChord * plan.taper;
    const ail = hinged(m.wingspan * 0.2, tipChord * 0.28, plan.thickness * tipChord * 0.6, accentMat);
    ail.position.set(
      side * m.wingspan * 0.34,
      wingY + plan.dihedral * m.wingspan * 0.34,
      wingZ + plan.sweep * rootChord * 0.68 + tipChord * 0.42,
    );
    group.add(ail);
    parts[side > 0 ? 'aileronRight' : 'aileronLeft'] = ail;

    // Flap inboard of it. It does not move with the stick, but it breaks up the
    // trailing edge, which is most of what tells the eye a wing has structure.
    const flap = new THREE.Mesh(
      new THREE.BoxGeometry(m.wingspan * 0.18, plan.thickness * rootChord * 0.5, rootChord * 0.2),
      trimMat,
    );
    flap.position.set(
      side * m.wingspan * 0.16,
      wingY + plan.dihedral * m.wingspan * 0.16,
      wingZ + plan.sweep * rootChord * 0.32 + rootChord * 0.42,
    );
    group.add(flap);

    // ---- wingtip light cluster
    // The tip frame, taken from the same taper/sweep/dihedral the wing was lofted
    // with, so the fittings sit on the wing rather than near it.
    const half = m.wingspan * 0.5;
    const tipT = 0.97;
    const tipX = side * half * tipT;
    const tipY = wingY + plan.dihedral * half * tipT
      + (plan.winglet > 0 ? plan.winglet * 0.85 : 0);
    const tipZ = wingZ + plan.sweep * rootChord * tipT
      + (plan.winglet > 0 ? plan.winglet * 0.3 : 0);

    // A housing first. Without something opaque to sit in, a glowing sphere at the
    // tip always reads as a bead hanging off the end of the wing.
    const pod = new THREE.Mesh(
      new THREE.CapsuleGeometry(tipChord * 0.09, tipChord * 0.5, 3, 6),
      trimMat,
    );
    pod.rotation.x = Math.PI / 2;
    pod.position.set(tipX, tipY, tipZ + tipChord * 0.12);
    group.add(pod);

    // Navigation light: green on the right wing, red on the left. Steady, small, and
    // set at the leading edge where it belongs.
    const nav = new THREE.Mesh(
      new THREE.SphereGeometry(tipChord * 0.11, 7, 6),
      MAT.glow(side > 0 ? 0x2fff6a : 0xff3344),
    );
    nav.position.set(tipX, tipY, tipZ - tipChord * 0.16);
    group.add(nav);
    parts.navLights.push(nav);
    parts.lights.push(nav);

    // Strobe at the other end of the same pod, white, flashing.
    const strobe = new THREE.Mesh(
      new THREE.SphereGeometry(tipChord * 0.085, 7, 6),
      MAT.glow(0xffffff),
    );
    strobe.position.set(tipX, tipY, tipZ + tipChord * 0.4);
    group.add(strobe);
    parts.strobes.push(strobe);

    // Landing light recessed into the wing leading edge, on with the gear: a lens in
    // a dark socket rather than a ball stuck under the wing.
    const lightZ = wingZ + plan.sweep * rootChord * 0.4 - rootChord * 0.22;
    const lightY = wingY + plan.dihedral * half * 0.4 - plan.thickness * rootChord * 0.18;
    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.16, radius * 0.13, radius * 0.1, 8),
      darkMat,
    );
    socket.rotation.x = Math.PI / 2;
    socket.position.set(side * m.wingspan * 0.22, lightY, lightZ);
    group.add(socket);

    const landing = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.12, 7, 6),
      MAT.glow(0xfff3d0),
    );
    landing.scale.z = 0.4;                    // a lens, not a bulb
    landing.position.set(side * m.wingspan * 0.22, lightY, lightZ - radius * 0.03);
    group.add(landing);
    parts.landingLights.push(landing);
  }

  // ---- tail
  const tailZ = len * 0.42;
  const finHeight = Math.max(0.9, len * 0.2);
  const finChord = Math.max(0.8, len * 0.16);
  // The fin is a wing stood on its end: a section, a taper and a swept leading edge,
  // instead of the flat slab it used to be.
  const finGeo = halfWing({
    span: finHeight * 2, rootChord: finChord, taper: 0.5, sweep: 0.9,
    dihedral: 0, thickness: 0.13, twist: 0, stations: 5,
  });
  const stabGeo = halfWing({
    span: m.wingspan * 0.42, rootChord: finChord * 0.8, taper: 0.5, sweep: 0.5,
    dihedral: 0.02, thickness: 0.09, twist: 0, stations: 5,
  });

  const addFin = (x, z, height, mat, { fillet = true } = {}) => {
    const fin = new THREE.Mesh(finGeo, mat);
    fin.rotation.z = Math.PI / 2;             // stand the half-wing upright, span up
    fin.scale.setScalar(height / finHeight);
    fin.position.set(x, radius * 0.35, z);
    fin.castShadow = true;
    group.add(fin);

    if (fillet) {
      // Dorsal fillet: the long shallow wedge that runs from the spine up into the
      // fin's leading edge. Real aircraft have one because the fin root needs the
      // area; here it also stops the fin being a sliver when seen from dead astern.
      const filletLen = height * 1.5;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(filletLen, 0);
      shape.lineTo(filletLen, height * 0.42);
      shape.quadraticCurveTo(filletLen * 0.42, height * 0.06, 0, 0);
      const dorsal = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, {
          depth: radius * 0.3, bevelEnabled: true,
          bevelSize: radius * 0.07, bevelThickness: radius * 0.05, bevelSegments: 2,
        }),
        mat,
      );
      // Extruded in the XY plane growing along +Z; stand it up so the wedge runs
      // forward along the spine and rises toward the fin.
      dorsal.rotation.set(0, -Math.PI / 2, 0);
      dorsal.position.set(x + radius * 0.15, radius * 0.35, z - filletLen + finChord * 0.3);
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

  if (m.tail === 'twin-boom') {
    for (const side of [1, -1]) {
      // Booms running back from the wing to carry the tail.
      const boom = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius * 0.3, len * 0.4, 4, 8), trimMat,
      );
      boom.rotation.x = Math.PI / 2;
      boom.position.set(side * m.wingspan * 0.2, wingY + radius * 0.1, len * 0.2);
      boom.castShadow = true;
      group.add(boom);
      // No dorsal fillet on a boom-mounted fin: there is no spine for it to run along.
      addFin(side * m.wingspan * 0.2, tailZ, finHeight, trimMat, { fillet: false });
      const rud = hinged(finHeight * 0.8, finChord * 0.3, 0.13, trimMat, { vertical: true });
      rud.position.set(side * m.wingspan * 0.2, radius * 0.35 + finHeight * 0.55, tailZ + finChord * 0.4);
      group.add(rud);
      // Both move together; the animation only knows about one, so the second follows.
      if (side > 0) parts.rudder = rud; else parts.rudderSlave = rud;
    }
    const stab = addStab(finHeight * 0.85, tailZ, bodyMat);
    const elev = hinged(m.wingspan * 0.4, finChord * 0.3, 0.1, accentMat);
    elev.position.set(0, finHeight * 0.85, tailZ + finChord * 0.35);
    group.add(elev);
    parts.elevator = elev;
    parts.stabiliser = stab;
  } else if (m.tail === 'canard') {
    // Delta plus canard: small foreplanes ahead of the wing, one fin.
    const canardGeo = halfWing({
      span: m.wingspan * 0.42, rootChord: finChord * 0.6, taper: 0.4, sweep: 0.7,
      dihedral: 0.02, thickness: 0.08, twist: 0, stations: 5,
    });
    const canards = new THREE.Group();
    for (const side of [1, -1]) {
      const c = new THREE.Mesh(canardGeo, accentMat);
      c.scale.x = side;
      c.castShadow = true;
      canards.add(c);
    }
    canards.position.set(0, radius * 0.45, -len * 0.26);
    group.add(canards);
    parts.elevator = canards;   // the whole foreplane moves, as on a real canard
    const fin = addFin(0, tailZ, finHeight * 1.1, trimMat);
    parts.rudderFin = fin;
    const rud = hinged(finHeight * 0.9, finChord * 0.32, 0.14, trimMat, { vertical: true });
    rud.position.set(0, radius * 0.35 + finHeight * 0.62, tailZ + finChord * 0.42);
    group.add(rud);
    parts.rudder = rud;
  } else {
    const fin = addFin(0, tailZ, finHeight, trimMat);
    parts.rudderFin = fin;
    const rud = hinged(finHeight * 0.85, finChord * 0.34, 0.14, trimMat, { vertical: true });
    rud.position.set(0, radius * 0.35 + finHeight * 0.55, tailZ + finChord * 0.4);
    group.add(rud);
    parts.rudder = rud;

    const stabY = m.tail === 't-tail' ? radius * 0.35 + finHeight * 0.95 : radius * 0.3;
    const stabZ = tailZ - (m.tail === 't-tail' ? 0 : len * 0.02);
    parts.stabiliser = addStab(stabY, stabZ, bodyMat);
    const elev = hinged(m.wingspan * 0.38, finChord * 0.3, 0.1, accentMat);
    elev.position.set(0, stabY, stabZ + finChord * 0.34);
    group.add(elev);
    parts.elevator = elev;

    // White tail navigation light, facing aft.
    const tailNav = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.1, 6, 5), MAT.glow(0xffffff));
    tailNav.position.set(0, radius * 0.35 + finHeight * 0.95, tailZ + finChord * 0.45);
    group.add(tailNav);
    parts.navLights.push(tailNav);
    parts.lights.push(tailNav);
  }

  // Beacon on the spine: red, slow, the light that says the engine is running.
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.11, 6, 5), MAT.glow(0xff2a2a));
  beacon.position.set(0, radius * 1.0, len * 0.06);
  group.add(beacon);
  parts.beacon = beacon;

  // ---- canopy: tinted glazing with a frame around it
  const canopyLen = m.canopy === 'airliner' ? len * 0.3 : len * 0.2;
  const canopyZ = m.canopy === 'fighter' ? -len * 0.16 : -len * 0.22;
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.82, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    MAT.glass(),
  );
  canopy.scale.set(0.9, 0.72, canopyLen / (radius * 0.82) * 0.7);
  canopy.position.set(0, radius * 0.62, canopyZ);
  group.add(canopy);
  parts.canopy = canopy;

  // Canopy rail and arch: the structure that holds the glass, without which it reads
  // as a bubble stuck on the back.
  const rail = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.74, radius * 0.045, 5, 14, Math.PI),
    trimMat,
  );
  rail.rotation.set(0, 0, 0);
  rail.position.set(0, radius * 0.6, canopyZ + canopyLen * 0.34);
  group.add(rail);

  if (m.canopy === 'airliner') {
    // Cabin windows: one thin dark strip a side, which at this scale is what a row of
    // windows actually looks like.
    for (const side of [1, -1]) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, radius * 0.16, len * 0.4), MAT.glass(),
      );
      strip.position.set(side * radius * 0.92, radius * 0.28, len * 0.02);
      group.add(strip);
    }
  }

  // ---- engines
  if (m.engines === 'prop') {
    // One prop sits on the nose; a twin hangs its engines off the wing, which is the
    // silhouette that tells a heavy hauler apart from a sport aircraft at a glance.
    const count = m.propCount ?? 1;
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      const x = side * m.wingspan * 0.26;
      const z = count > 1 ? -len * 0.1 : -len * 0.5 - radius * 0.28;
      const y = count > 1 ? wingY + radius * 0.12 : 0;

      if (count > 1) {
        // A cowl rather than a bare cylinder: rounded front, tapered back.
        const cowl = new THREE.Mesh(nacelle(radius * 0.46, len * 0.32, 14), trimMat);
        cowl.position.set(x, y, z + len * 0.1);
        cowl.castShadow = true;
        group.add(cowl);
      }

      // Spinner, then real blades: tapered, twisted, thin at the tip.
      const spinner = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 0.3, radius * 0.85, 12), accentMat,
      );
      spinner.rotation.x = -Math.PI / 2;
      spinner.position.set(x, y, z - radius * 0.2);
      group.add(spinner);

      const propGroup = new THREE.Group();
      propGroup.position.set(x, y, z);
      const bladeGeo = propBlade(m.propRadius, m.propRadius * 0.3);
      const blades = m.propCount > 1 ? 4 : 3;
      for (let b = 0; b < blades; b++) {
        const blade = new THREE.Mesh(bladeGeo, darkMat);
        blade.rotation.z = (b / blades) * Math.PI * 2;
        blade.castShadow = true;
        propGroup.add(blade);
      }
      // Blur disc: what you actually perceive once the prop is turning.
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(m.propRadius, 20),
        new THREE.MeshBasicMaterial({
          color: 0x9fb0c0, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
        }),
      );
      propGroup.add(disc);
      group.add(propGroup);
      parts.props.push(propGroup);
      parts.propDiscs.push(disc);
    }
  } else {
    const count = m.jetCount ?? 1;
    const nacelleR = radius * (count > 1 ? 0.52 : 0.78);
    const nacelleLen = len * 0.34;
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      const x = side * m.wingspan * (m.wing === 'delta' ? 0.12 : 0.2);
      const y = count > 1 ? wingY - nacelleR * 0.5 : 0;
      const z = count > 1 ? len * 0.16 : len * 0.24;

      // The duct first, so the intake has an inside to see.
      const duct = new THREE.Mesh(
        new THREE.CylinderGeometry(nacelleR * 0.56, nacelleR * 0.5, nacelleLen * 0.9, 14, 1, true),
        ductMat,
      );
      duct.rotation.x = Math.PI / 2;
      duct.position.set(x, y, z);
      group.add(duct);

      // Then the cowl around it: inlet lip, straight side, boat-tailed nozzle.
      const cowl = new THREE.Mesh(nacelle(nacelleR, nacelleLen, 16), trimMat);
      cowl.position.set(x, y, z);
      cowl.castShadow = true;
      group.add(cowl);

      if (count > 1) {
        // Pylon joining the engine to the wing. A flat plate left the nacelle looking
        // parked under the wing rather than hung from it, so this is a short wing
        // stood on end: a section, a taper, and enough chord to reach both surfaces.
        const wingSurfaceY = wingY + plan.dihedral * Math.abs(x) - plan.thickness * rootChord * 0.3;
        const gap = Math.max(nacelleR * 0.5, wingSurfaceY - (y + nacelleR * 0.35));
        const pylonGeo = halfWing({
          span: gap * 2.4, rootChord: nacelleLen * 0.62, taper: 0.78, sweep: 0.12,
          dihedral: 0, thickness: 0.16, twist: 0, stations: 4,
        });
        const pylon = new THREE.Mesh(pylonGeo, trimMat);
        pylon.rotation.z = Math.PI / 2;       // span upward, from nacelle to wing
        pylon.position.set(x, y + nacelleR * 0.35, z - nacelleLen * 0.08);
        pylon.castShadow = true;
        group.add(pylon);

        // Fairing where the pylon meets the nacelle, which is the join the eye checks.
        const shoulder = new THREE.Mesh(
          new THREE.SphereGeometry(nacelleR * 0.5, 8, 6), trimMat,
        );
        shoulder.scale.set(0.55, 0.7, nacelleLen * 0.5 / (nacelleR * 0.5));
        shoulder.position.set(x, y + nacelleR * 0.5, z - nacelleLen * 0.08);
        group.add(shoulder);
      }

      // Fan face, set back inside the lip where the light falls off.
      const fan = new THREE.Group();
      const hub = new THREE.Mesh(new THREE.ConeGeometry(nacelleR * 0.16, nacelleR * 0.4, 10), metalMat);
      hub.rotation.x = -Math.PI / 2;
      fan.add(hub);
      const bladeGeo = new THREE.BoxGeometry(nacelleR * 0.84, 0.02, nacelleR * 0.16);
      for (let b = 0; b < 9; b++) {
        const blade = new THREE.Mesh(bladeGeo, metalMat);
        blade.rotation.z = (b / 9) * Math.PI * 2;
        blade.position.set(0, 0, 0);
        fan.add(blade);
      }
      fan.position.set(x, y, z - nacelleLen * 0.3);
      group.add(fan);
      parts.fans.push(fan);

      // Exhaust cone inside the nozzle, and the afterburner flame behind it.
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(nacelleR * 0.34, nacelleR * 1.1, 10), metalMat,
      );
      cone.rotation.x = -Math.PI / 2;
      cone.position.set(x, y, z + nacelleLen * 0.42);
      group.add(cone);

      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(nacelleR * 0.62, len * 0.45, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x6fd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      flame.rotation.x = -Math.PI / 2;
      flame.position.set(x, y, z + nacelleLen * 0.5 + len * 0.2);
      group.add(flame);
      parts.afterburners.push(flame);
    }
  }

  // ---- landing gear: leg, oleo, wheel, and a door that hangs with it
  const gearGroup = new THREE.Group();
  const legLen = Math.max(1.1, radius * 2.1);
  const legGeo = new THREE.CylinderGeometry(0.075, 0.06, legLen * 0.62, 8);
  const oleoGeo = new THREE.CylinderGeometry(0.05, 0.05, legLen * 0.5, 6);
  const wheelGeo = new THREE.CylinderGeometry(legLen * 0.22, legLen * 0.22, legLen * 0.16, 14);
  const hubGeo = new THREE.CylinderGeometry(legLen * 0.09, legLen * 0.09, legLen * 0.17, 8);
  const addLeg = (x, z, main) => {
    const top = -radius * 0.55;
    const leg = new THREE.Mesh(legGeo, metalMat);
    leg.position.set(x, top - legLen * 0.31, z);
    gearGroup.add(leg);
    // The oleo is the polished part that slides inside the leg.
    const oleo = new THREE.Mesh(oleoGeo, MAT.metal(0xc9d2da));
    oleo.position.set(x, top - legLen * 0.72, z);
    gearGroup.add(oleo);
    const wheel = new THREE.Mesh(wheelGeo, rubberMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, top - legLen, z);
    wheel.castShadow = true;
    gearGroup.add(wheel);
    const hub = new THREE.Mesh(hubGeo, metalMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(wheel.position);
    gearGroup.add(hub);
    parts.gear.push(wheel);
    // Door: a panel on the fuselage side of the leg.
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(main ? 0.06 : 0.05, legLen * 0.5, main ? legLen * 0.5 : legLen * 0.4),
      bodyMat,
    );
    door.position.set(x + (main ? Math.sign(x) * 0.14 : 0.1), top - legLen * 0.28, z);
    gearGroup.add(door);
  };
  addLeg(0, -len * 0.3, false);
  addLeg(m.wingspan * 0.16, len * 0.06, true);
  addLeg(-m.wingspan * 0.16, len * 0.06, true);
  group.add(gearGroup);
  parts.gearGroup = gearGroup;

  group.userData.parts = parts;
  group.userData.spec = spec;
  group.userData.anim = { propPhase: 0, fanPhase: 0, gearBlend: 1, strobe: 0, beacon: 0 };
  return group;
}

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
