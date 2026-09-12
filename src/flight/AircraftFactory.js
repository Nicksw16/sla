import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/MathUtils.js';
import { PAINTS } from '../data/upgrades.js';

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
 */

const MAT = {
  body: (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.42 }),
  trim: (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.35 }),
  dark: () => new THREE.MeshStandardMaterial({ color: 0x1b2028, metalness: 0.6, roughness: 0.5 }),
  glass: () => new THREE.MeshStandardMaterial({
    color: 0x8fd0e8, metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.55,
  }),
  glow: (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
};

/** Half-wing in plan view, extruded thin and laid flat. */
function wingGeometry(kind, span, rootChord) {
  const half = span / 2;
  const shape = new THREE.Shape();
  switch (kind) {
    case 'delta':
      shape.moveTo(0, rootChord * 0.55);
      shape.lineTo(half, -rootChord * 0.5);
      shape.lineTo(half * 0.92, -rootChord * 0.62);
      shape.lineTo(0, -rootChord * 0.62);
      break;
    case 'swept':
      shape.moveTo(0, rootChord * 0.5);
      shape.lineTo(half, -rootChord * 0.12);
      shape.lineTo(half, -rootChord * 0.44);
      shape.lineTo(0, -rootChord * 0.5);
      break;
    case 'tapered':
      shape.moveTo(0, rootChord * 0.5);
      shape.lineTo(half, rootChord * 0.06);
      shape.lineTo(half, -rootChord * 0.24);
      shape.lineTo(0, -rootChord * 0.5);
      break;
    default: // straight
      shape.moveTo(0, rootChord * 0.5);
      shape.lineTo(half, rootChord * 0.42);
      shape.lineTo(half, -rootChord * 0.42);
      shape.lineTo(0, -rootChord * 0.5);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: rootChord * 0.07, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

function fuselageGeometry(length, radius, nose = 'round') {
  const profile = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Pointed nose, full mid-section, tapered tail.
    let r;
    if (nose === 'sharp') r = Math.sin(Math.pow(t, 0.62) * Math.PI) ** 0.72;
    else r = Math.sin(Math.pow(t, 0.5) * Math.PI) ** 0.55;
    profile.push(new THREE.Vector2(Math.max(0.04, r * radius), (t - 0.5) * length));
  }
  const geo = new THREE.LatheGeometry(profile, 14);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

export function buildAircraft(spec, paintId = 'factory') {
  const m = spec.model;
  const paint = PAINTS[paintId] ?? PAINTS.factory;
  const bodyMat = MAT.body(paint.body);
  const trimMat = MAT.trim(paint.trim);
  const accentMat = MAT.trim(m.colorAccent ?? 0xffffff);
  const darkMat = MAT.dark();

  const group = new THREE.Group();
  group.name = `aircraft:${spec.id}`;
  const parts = { props: [], propDiscs: [], afterburners: [], gear: [], lights: [] };

  const len = m.length;
  const radius = Math.max(0.42, len * 0.085);

  // ---- fuselage
  const fuse = new THREE.Mesh(
    fuselageGeometry(len, radius, m.engines === 'jet' ? 'sharp' : 'round'),
    bodyMat,
  );
  fuse.castShadow = true;
  group.add(fuse);

  // ---- main wing
  const rootChord = Math.max(1.1, m.wingspan * (m.wing === 'delta' ? 0.42 : 0.2));
  const wingGeo = wingGeometry(m.wing, m.wingspan, rootChord);
  const wingZ = m.wing === 'delta' ? len * 0.1 : -len * 0.02;
  for (const side of [1, -1]) {
    const w = new THREE.Mesh(wingGeo, bodyMat);
    w.scale.x = side;
    w.position.set(0, m.wing === 'delta' ? -radius * 0.25 : radius * 0.1, wingZ);
    w.castShadow = true;
    group.add(w);

    // Ailerons: separate slivers so control input is visible from the chase cam (§66).
    const ail = new THREE.Mesh(
      new THREE.BoxGeometry(m.wingspan * 0.26, rootChord * 0.06, rootChord * 0.2),
      accentMat,
    );
    ail.position.set(side * m.wingspan * 0.33, w.position.y, wingZ - rootChord * 0.35);
    group.add(ail);
    parts[side > 0 ? 'aileronRight' : 'aileronLeft'] = ail;

    // Wingtip navigation light: green right, red left.
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.2, 6, 5),
      MAT.glow(side > 0 ? 0x2fff6a : 0xff3344),
    );
    light.position.set(side * m.wingspan * 0.5, w.position.y, wingZ - rootChord * 0.1);
    group.add(light);
    parts.lights.push(light);
  }

  // ---- tail
  const tailZ = len * 0.42;
  const finHeight = Math.max(0.9, len * 0.2);
  if (m.tail === 'twin-boom') {
    for (const side of [1, -1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, finHeight, len * 0.16), trimMat);
      fin.position.set(side * m.wingspan * 0.2, finHeight * 0.45, tailZ);
      fin.castShadow = true;
      group.add(fin);
    }
    const stab = new THREE.Mesh(new THREE.BoxGeometry(m.wingspan * 0.42, 0.12, len * 0.13), bodyMat);
    stab.position.set(0, finHeight * 0.85, tailZ);
    group.add(stab);
    parts.elevator = stab;
  } else if (m.tail === 'canard') {
    // Delta + canard: small foreplanes, single fin.
    for (const side of [1, -1]) {
      const canard = new THREE.Mesh(new THREE.BoxGeometry(m.wingspan * 0.2, 0.1, len * 0.09), accentMat);
      canard.position.set(side * m.wingspan * 0.17, radius * 0.5, -len * 0.26);
      group.add(canard);
      if (side > 0) parts.elevator = canard;
    }
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, finHeight * 1.1, len * 0.16), trimMat);
    fin.position.set(0, finHeight * 0.5, tailZ);
    fin.castShadow = true;
    group.add(fin);
    parts.rudder = fin;
  } else {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, finHeight, len * 0.17), trimMat);
    fin.position.set(0, finHeight * 0.45, tailZ);
    fin.castShadow = true;
    group.add(fin);
    parts.rudder = fin;
    const stabY = m.tail === 't-tail' ? finHeight * 0.95 : radius * 0.3;
    const stab = new THREE.Mesh(new THREE.BoxGeometry(m.wingspan * 0.4, 0.12, len * 0.13), bodyMat);
    stab.position.set(0, stabY, tailZ - (m.tail === 't-tail' ? 0 : len * 0.02));
    stab.castShadow = true;
    group.add(stab);
    parts.elevator = stab;
  }

  // ---- canopy
  const canopyLen = m.canopy === 'airliner' ? len * 0.3 : len * 0.2;
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.82, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    MAT.glass(),
  );
  canopy.scale.set(0.9, 0.72, canopyLen / (radius * 0.82) * 0.7);
  canopy.position.set(0, radius * 0.62, m.canopy === 'fighter' ? -len * 0.16 : -len * 0.22);
  group.add(canopy);
  parts.canopy = canopy;

  // ---- engines
  if (m.engines === 'prop') {
    // One prop sits on the nose; a twin hangs its engines off the wing, which is the
    // silhouette that tells a heavy hauler apart from a sport aircraft at a glance.
    const count = m.propCount ?? 1;
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      const x = side * m.wingspan * 0.26;
      const z = count > 1 ? -len * 0.1 : -len * 0.5 - radius * 0.3;

      if (count > 1) {
        const nacelle = new THREE.Mesh(
          new THREE.CylinderGeometry(radius * 0.42, radius * 0.34, len * 0.34, 10), trimMat,
        );
        nacelle.rotation.x = Math.PI / 2;
        nacelle.position.set(x, radius * 0.05, z + len * 0.1);
        nacelle.castShadow = true;
        group.add(nacelle);
      }

      const spinner = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.34, radius * 0.8, 10), accentMat);
      spinner.rotation.x = -Math.PI / 2;
      spinner.position.set(x, count > 1 ? radius * 0.05 : 0, z);
      group.add(spinner);

      const propGroup = new THREE.Group();
      propGroup.position.copy(spinner.position);
      const bladeGeo = new THREE.BoxGeometry(m.propRadius * 2, 0.04, 0.16);
      for (let b = 0; b < 2; b++) {
        const blade = new THREE.Mesh(bladeGeo, darkMat);
        blade.rotation.z = (b / 2) * Math.PI;
        propGroup.add(blade);
      }
      // Blur disc: what you actually perceive once the prop is turning.
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(m.propRadius, 20),
        new THREE.MeshBasicMaterial({ color: 0x9fb0c0, transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
      );
      propGroup.add(disc);
      group.add(propGroup);
      parts.props.push(propGroup);
      parts.propDiscs.push(disc);
    }
  } else {
    const count = m.jetCount ?? 1;
    const nacelleR = radius * (count > 1 ? 0.52 : 0.78);
    for (let i = 0; i < count; i++) {
      const side = count > 1 ? (i === 0 ? 1 : -1) : 0;
      const x = side * m.wingspan * (m.wing === 'delta' ? 0.12 : 0.2);
      const z = count > 1 ? len * 0.26 : len * 0.3;
      const nacelle = new THREE.Mesh(
        new THREE.CylinderGeometry(nacelleR, nacelleR * 0.86, len * 0.3, 12),
        trimMat,
      );
      nacelle.rotation.x = Math.PI / 2;
      nacelle.position.set(x, count > 1 ? radius * 0.2 : 0, z);
      nacelle.castShadow = true;
      group.add(nacelle);

      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(nacelleR * 0.82, len * 0.45, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x6fd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      flame.rotation.x = -Math.PI / 2;
      flame.position.set(x, nacelle.position.y, z + len * 0.34);
      group.add(flame);
      parts.afterburners.push(flame);
    }
  }

  // ---- landing gear (three legs, hidden when retracted)
  const gearGroup = new THREE.Group();
  const legLen = Math.max(1.1, radius * 2.1);
  const legGeo = new THREE.CylinderGeometry(0.07, 0.07, legLen, 6);
  const wheelGeo = new THREE.CylinderGeometry(legLen * 0.22, legLen * 0.22, 0.14, 10);
  const addLeg = (x, z) => {
    const leg = new THREE.Mesh(legGeo, darkMat);
    leg.position.set(x, -legLen * 0.5 - radius * 0.4, z);
    gearGroup.add(leg);
    const wheel = new THREE.Mesh(wheelGeo, darkMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, -legLen - radius * 0.4, z);
    gearGroup.add(wheel);
  };
  addLeg(0, -len * 0.3);
  addLeg(m.wingspan * 0.16, len * 0.06);
  addLeg(-m.wingspan * 0.16, len * 0.06);
  group.add(gearGroup);
  parts.gearGroup = gearGroup;

  group.userData.parts = parts;
  group.userData.spec = spec;
  group.userData.anim = { propPhase: 0, gearBlend: 1, strobe: 0 };
  return group;
}

/**
 * Per-frame animation: propeller/afterburner, control surfaces following the
 * player's input, gear retraction, strobes. Purely visual feedback for physics
 * that has already happened (spec §66).
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

  // Afterburner cone: only visible on turbo, scaled by how hard it is working.
  const burn = telemetry.turbo ? 1 : 0;
  for (const f of parts.afterburners) {
    f.material.opacity = damp(f.material.opacity, burn * 0.85, 9, dt);
    const flicker = 1 + Math.sin(performance.now() * 0.05) * 0.09;
    const target = burn ? flicker : 0.25;
    f.scale.set(target, target, target);
    f.visible = f.material.opacity > 0.02;
  }

  // Control surfaces mirror the commanded input.
  if (control) {
    const defl = 0.42;
    if (parts.aileronRight) parts.aileronRight.rotation.x = -control.roll * defl;
    if (parts.aileronLeft) parts.aileronLeft.rotation.x = control.roll * defl;
    if (parts.elevator) parts.elevator.rotation.x = -control.pitch * defl * 0.7;
    if (parts.rudder) parts.rudder.rotation.y = -control.yaw * defl;
  }

  // Gear: slide up into the fuselage and switch off once stowed.
  const wantGear = telemetry.gearDown ? 1 : 0;
  anim.gearBlend = damp(anim.gearBlend, wantGear, 3.2, dt);
  if (parts.gearGroup) {
    parts.gearGroup.visible = anim.gearBlend > 0.03;
    parts.gearGroup.position.y = lerp(1.1, 0, anim.gearBlend);
    parts.gearGroup.scale.setScalar(lerp(0.2, 1, anim.gearBlend));
  }

  // Strobes, ~1 Hz.
  anim.strobe += dt;
  const on = anim.strobe % 1 < 0.12;
  for (const l of parts.lights) l.material.opacity = on ? 1 : 0.45;
}

/** Frees the geometry and materials this factory created. */
export function disposeAircraft(group) {
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((mm) => mm.dispose?.());
      else o.material?.dispose?.();
    }
  });
}
