/**
 * Every building in the city, destructible.
 *
 * The city has 3,178 buildings and the twin towers are 3,402 blocks each, so a lattice
 * for all of them up front is about 1.4 million blocks - it would not load. Buildings
 * are therefore converted the moment something hits one, and this file is about that
 * conversion being exact: one representation at a time, never both and never neither,
 * for every kind of building the generator makes.
 *
 * Runs in plain Node against the real generated city.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { generateCity } from '../src/world/CityGenerator.js';
import { CityDestruction } from '../src/world/CityDestruction.js';
import { DestructionField } from '../src/world/Destructible.js';
import { EventBus } from '../src/core/EventBus.js';
import { AIRCRAFT } from '../src/data/aircraft.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nCity destruction');

/** The real city, with the conversion layer wired the way the world wires it. */
function world() {
  const city = generateCity({ seed: 20260912 });
  const parent = new THREE.Group();
  for (const m of Object.values(city.batches)) if (m) parent.add(m);
  const events = [];
  const bus = new EventBus();
  for (const t of ['structure:impact', 'structure:detach', 'structure:collapse']) {
    bus.on(t, (e) => events.push({ type: t, ...e }));
  }
  const field = new DestructionField({ bus });
  const cd = new CityDestruction({
    recipes: city.recipes, batches: city.batches, grid: city.grid, parent, field,
  });
  cd.rememberHome();
  field.convert = (ref) => cd.convert(ref);
  return { city, cd, field, parent, events };
}

/** Flies an aircraft into a building the way the flight model does: through the grid. */
function flyInto(w, recipe, id = 'aurora', frac = 0.6) {
  const c = AIRCRAFT[id];
  const dir = new THREE.Vector3(1, 0, 0);
  const y = recipe.base + recipe.height * frac;
  const pos = new THREE.Vector3(recipe.x - recipe.w * 0.5 + 2, y, recipe.z);
  const hit = w.city.grid.sample(pos, 6, null);
  if (!hit) return null;
  return w.field.impact({
    point: hit.point, normal: hit.normal, direction: dir, ref: hit.ref,
    speed: c.maxSpeed, mass: c.mass,
  });
}

const scaleOf = (mesh, index) => {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(index, m);
  return new THREE.Vector3().setFromMatrixScale(m).length();
};

// --- the recipe the generator used to throw away --------------------------------

test('every building carries what is needed to rebuild it', () => {
  const { city } = world();
  assert.equal(city.recipes.length, city.stats.buildings,
    'one recipe per building, no more and no fewer');
  for (const r of city.recipes) {
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.z), `${r.index}: no position`);
    assert.ok(r.height > 0, `${r.index}: no height`);
    assert.ok(r.w > 0 && r.d > 0, `${r.index}: no footprint`);
    assert.ok(r.collider >= 0, `${r.index}: not registered for collision`);
    assert.ok(r.spans.box && r.spans.cyl && r.spans.roof, `${r.index}: no instance spans`);
  }
  // And every building owns at least one instance somewhere, or it is invisible.
  const orphans = city.recipes.filter((r) => Object.values(r.spans)
    .every(([a, b]) => b <= a));
  assert.equal(orphans.length, 0, `${orphans.length} buildings own no geometry`);
});

test('a hit on a city building knows which building it hit', () => {
  // This is what was missing: building colliders carried no reference at all, so an
  // impact had nothing to route to and only landmarks could ever be damaged.
  const { city } = world();
  const r = city.recipes.find((x) => x.height > 100);
  const hit = city.grid.sample(
    new THREE.Vector3(r.x, r.base + r.height * 0.5, r.z), 6, null,
  );
  assert.ok(hit, 'the grid reports the building');
  assert.equal(hit.ref?.index, r.index, 'and hands back the building that was hit');
});

// --- conversion -------------------------------------------------------------------

test('every kind of building the generator makes can be converted', () => {
  const w = world();
  const byType = {};
  for (const r of w.city.recipes) if (!byType[r.type]) byType[r.type] = r;
  assert.ok(Object.keys(byType).length >= 5, `only ${Object.keys(byType).length} types`);
  for (const [type, r] of Object.entries(byType)) {
    const b = w.cd.convert(r);
    assert.ok(b, `${type} would not convert`);
    assert.ok(b.modules.length > 0, `${type} converted to nothing`);
    assert.equal(b.standing, true, `${type} fell over on conversion`);
  }
});

test('a converted building has exactly one representation, never two and never none', () => {
  const w = world();
  const r = w.city.recipes.find((x) => x.height > 120 && x.spans.box[1] > x.spans.box[0]);
  const i = r.spans.box[0];
  assert.ok(scaleOf(w.city.batches.box, i) > 0.01, 'it is in the city mesh to begin with');

  const b = w.cd.convert(r);
  assert.ok(b, 'converted');
  assert.equal(scaleOf(w.city.batches.box, i), 0, 'and is no longer in the city mesh');
  assert.ok(b.modules.length > 0, 'while the lattice is there');
  // The old box collider must go, or there is an invisible building in the way.
  assert.equal(w.city.grid.boxes[r.collider].alive, false, 'the old collider is retired');
});

test('the block size is about the same everywhere in the city', () => {
  // A hatchback-sized block on one street and a bus-sized one on the next reads as two
  // different games, so the resolution follows the building rather than being fixed.
  const { city } = world();
  const sizes = [];
  for (const r of city.recipes) {
    const { cells, levels } = CityDestruction.latticeFor(r);
    sizes.push({ w: Math.max(r.w, r.d) / cells, h: r.height / levels, blocks: cells * cells * levels });
  }
  const widths = sizes.map((s) => s.w).sort((a, b) => a - b);
  const lo = widths[Math.floor(widths.length * 0.05)];
  const hi = widths[Math.floor(widths.length * 0.95)];
  assert.ok(hi / lo < 4, `block width spans ${lo.toFixed(1)}-${hi.toFixed(1)} m across the city`);
  // And no single building may take the whole physics budget.
  const biggest = Math.max(...sizes.map((s) => s.blocks));
  assert.ok(biggest <= 900, `one building would be ${biggest} blocks`);
});

// --- damage ------------------------------------------------------------------------

test('flying into a city building breaks it', () => {
  const w = world();
  const r = w.city.recipes.filter((x) => x.height > 150).sort((a, b) => b.height - a.height)[0];
  const result = flyInto(w, r);
  assert.ok(result, 'the impact was routed somewhere');
  assert.ok(result.broke > 0, `${result.broke} blocks broken`);
  const b = r.building;
  assert.ok(b, 'the building was converted by the impact itself');
  const gone = b.modules.filter((m) => !m.intact).length;
  assert.ok(gone >= result.broke, 'and what the blast broke is at least what it took');
  assert.ok(w.events.some((e) => e.type === 'structure:impact'), 'the world was told');
});

test('an office block gives way where a landmark tower shrugs', () => {
  // Flying into one of the Gemini Towers should feel like hitting something; flying
  // into an office block should feel like going through it. That difference is the
  // point of city buildings being weaker, and it is worth pinning down.
  const w = world();
  const r = w.city.recipes.filter((x) => x.height > 150).sort((a, b) => b.height - a.height)[0];
  flyInto(w, r, 'skylark');
  const b = r.building;
  assert.ok(b, 'the starter aircraft is enough to convert it');
  const gone = b.modules.filter((m) => !m.intact).length;
  assert.ok(gone / b.modules.length > 0.02,
    `the trainer took ${gone} of ${b.modules.length} blocks out of an office block`);
});

// --- the budget ---------------------------------------------------------------------

test('the ruins are capped, and a cleared one is whole again', () => {
  const w = world();
  const tall = w.city.recipes.filter((x) => x.height > 100 && x.spans.box[1] > x.spans.box[0]);
  assert.ok(tall.length > 20, 'enough buildings to overflow the cap');

  const first = tall[0];
  const firstIndex = first.spans.box[0];
  for (let i = 0; i < 16; i++) w.cd.convert(tall[i]);

  assert.ok(w.cd.ruins.length <= 10, `${w.cd.ruins.length} ruins standing`);
  // The oldest was cleared, so it is back in the city mesh and back in the grid.
  assert.equal(first.building, null, 'the oldest ruin was let go');
  assert.ok(scaleOf(w.city.batches.box, firstIndex) > 0.01, 'and is back in the city mesh');
  assert.equal(w.city.grid.boxes[first.collider].alive, true, 'and can be flown into again');
});

test('clearing a ruin leaves nothing behind to fly into', () => {
  // A lattice dropped without giving back its collision boxes is an invisible building.
  const w = world();
  const r = w.city.recipes.find((x) => x.height > 120);
  const b = w.cd.convert(r);
  const groups = b.groups.filter((g) => g.colliderIndex >= 0).map((g) => g.colliderIndex);
  assert.ok(groups.length > 0, 'the lattice registered collision boxes');
  w.cd._clear(r);
  for (const idx of groups) {
    assert.equal(w.city.grid.boxes[idx].alive, false, 'every one of them is retired');
  }
});

test('reset puts the whole city back', () => {
  const w = world();
  const tall = w.city.recipes.filter((x) => x.height > 100).slice(0, 6);
  for (const r of tall) flyInto(w, r);
  assert.ok(w.cd.ruins.length > 0, 'something was wrecked');
  w.cd.reset();
  assert.equal(w.cd.ruins.length, 0, 'no ruins left');
  for (const r of tall) {
    assert.equal(r.building, null, `${r.index} is a recipe again`);
    assert.equal(w.city.grid.boxes[r.collider].alive, true, `${r.index} is solid again`);
  }
});

test('converting costs less than a frame', () => {
  const w = world();
  const tall = w.city.recipes.filter((x) => x.height > 150).sort((a, b) => b.height - a.height);
  w.cd.convert(tall[0]);
  const times = [];
  for (let i = 1; i < 12; i++) {
    const t0 = performance.now();
    w.cd.convert(tall[i]);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  console.log(`       ${median.toFixed(1)} ms to convert the largest class of building`);
  assert.ok(median < 16, `${median.toFixed(1)} ms drops a frame on its own`);
});

console.log(`\n${passed} city destruction assertions passed${process.exitCode ? ', some failed' : ''}`);
