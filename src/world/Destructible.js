import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';

/**
 * Structural destruction for the city's landmark towers.
 *
 * The project carries no third-party physics engine - the flight model is written by
 * hand against an AABB spatial hash - so "rigid body" here means an integrator in
 * this file rather than a component borrowed from one. That turns out to be the right
 * trade anyway: a general solver would have to be fed a mesh this game builds
 * procedurally, and the only bodies that ever need simulating are a few dozen slabs
 * and some debris, all of them convex boxes falling onto a heightfield.
 *
 * The separation that makes this affordable is visual against structural. A tower's
 * visual representation stays exactly what it was - the same curtain wall, the same
 * proportions - and is simply drawn in pieces, all of them instances of one box in a
 * single draw call. Underneath it sits a lattice of modules that carries the mass,
 * the strength, the damage and the connections. Nothing in the lattice is visible; it
 * is the thing that decides what falls.
 *
 * The chain the whole file exists to produce:
 *
 *   impact -> localised damage -> modules fail -> support is lost -> the loss
 *   propagates -> what is no longer held up becomes a falling body -> it lands
 *
 * No step of that is a timeline. A tower that loses a corner low down comes apart
 * because the modules above it can no longer trace a path to the ground, and if the
 * damage is not enough to break that path, nothing falls at all.
 */

export const MODULE_STATE = {
  INTACT: 'intact',
  DAMAGED: 'damaged',
  CRITICAL: 'critical',
  DETACHED: 'detached',   // no longer structural; falling under gravity
  SETTLED: 'settled',     // came to rest; physics asleep
  DESTROYED: 'destroyed', // removed from the world
};

/**
 * How far below a body's underside a surface may sit and still count as the floor it
 * lands on, in metres. It exists because a block resting on the lattice starts exactly
 * flush with the slab beneath it, and floating-point exactness is not something to
 * stake a collapse on.
 */
const CONTACT_SKIN = 0.35;

/** What is left of a block's horizontal run after a frame spent inside the structure. */
const WALL_FRICTION = 0.25;

/** Tuning shared by every destructible. Distances are metres, speeds metres/second. */
export const DESTRUCTION = {
  // How far an impact's damage reaches, in metres, measured from each block's
  // surface rather than its centre so the one actually struck takes the full hit.
  //
  // Metres, not blocks. Tying the reach to the module size meant that making the
  // blocks smaller made the wound smaller - the exact opposite of what finer rubble
  // is for. An aircraft should open the same hole in a building whatever the
  // simulation happens to be chopping that building into, and a faster one should
  // open a bigger one: the radius grows with the energy delivered, up to a gash
  // wider than one of these towers is across.
  //
  // The floor carries about two more blocks of reach in every direction than it
  // first shipped with: the trainer's bite went from two blocks by three over two
  // storeys to four by six over four, and everything from the mid-tier up now carries
  // clean through the plan. The ceiling does not, because past about seventy metres the
  // sphere clears a whole storey of the plan, and the tower above it loses the ground
  // entirely and shears off. That cliff is sharp: seventy leaves the fastest jet a
  // fourteen-storey crater with nothing at all following it down, seventy-four drops
  // twelve hundred more blocks.
  BLAST_BASE: 44,
  BLAST_PER_STRENGTH: 3.1,
  BLAST_MAX: 70,
  BLAST_FALLOFF: 1.05,
  // How hard the blast throws what it breaks, in metres per second per unit of
  // impact strength, and the ceiling on that. The first version deliberately kept
  // this to a shove so the blocks would read as falling masonry rather than as a
  // firework - but at block sizes this small, a shove reads as the facade quietly
  // sliding off. Thrown properly they come out of the wound in a spray, which is
  // both what an aircraft's worth of kinetic energy would actually do to them and
  // the thing worth watching. The upward bias is what turns a sideways spray into
  // an arc; the spin is what stops them looking like cards.
  BLAST_PUSH: 30,
  BLAST_PUSH_MAX: 115,
  BLAST_LIFT: 0.22,
  BLAST_SPIN: 4.4,
  // The most of the throw that may be spent going up, as a fraction of it. What is
  // left over goes outwards, so the spray leaves the wound rather than standing up
  // into a fountain over it - which is what used to put the wreckage on the roof.
  BLAST_VERT_MAX: 0.4,
  // Kinetic energy that counts as a full-strength hit, in the game's own units:
  // aircraft mass is a 0.55-1.4 factor and speed is metres per second.
  //
  // Calibrated against the catalogue rather than picked: the number is what the
  // slowest, lightest trainer in the game carries flat out, so flying *anything*
  // into a tower at its own top speed breaks the module it hit. That is the whole
  // point of the feature, and the first version of this got it wrong - it was set
  // for a heavy airframe at 160 m/s, which meant the aircraft the player actually
  // starts with delivered an eighth of what one module could take and a direct hit
  // left nothing but a scuff. The ceiling is where the curve flattens, so the
  // fastest jet in the catalogue is devastating but not unbounded.
  REFERENCE_ENERGY: 1720,
  ENERGY_CEILING: 18,
  // A block keeps standing while it can still trace a path to the ground. That is
  // the only rule. There used to be a second one - a block also had to keep enough
  // of its own immediate support - and it meant that punching a hole in a tower
  // sheared everything above the hole off, because those blocks had lost the column
  // they were sitting on. Correct statics, and wrong for a game about flying into
  // buildings: what you want when you hit one is the wall blowing outward, not the
  // skyline quietly subsiding. A hole is a hole now, and the roof stays where it is
  // as long as anything at all still reaches the ground.
  //
  // What survives is the case no local rule could ever have caught: a slab of
  // building severed from the earth entirely - a whole storey taken out, or the base
  // cut away - which has nothing left to stand on and comes down as one.
  // Falling bodies. Gravity is stronger than the real thing because the city is
  // built at arcade scale - at 9.81 a slab takes ten seconds to come down from the
  // roof and the collapse reads as slow motion.
  GRAVITY: -19,
  AIR_DRAG: 0.05,
  RESTITUTION: 0.18,
  FRICTION: 0.6,
  SLEEP_SPEED: 1.6,
  SLEEP_TIME: 0.6,
  // What a falling block does to the floor it lands on, as a speed: damage is the
  // impact speed over this, so a block that has dropped one storey bruises the one
  // underneath and a block that has fallen two hundred metres goes through it. That
  // is the whole of progressive collapse - the front accelerates because each storey
  // it takes lengthens the fall onto the next, and nothing anywhere schedules it.
  //
  // It has to stay well clear of a single storey's drop. Weaken the blocks and leave
  // this where it was and one block falling sixteen metres punches the floor under
  // it, which turns every hole in the building into a hole all the way to the street.
  PANCAKE_SPEED: 110,
  PANCAKE_MAX: 3,
  // Masonry does not survive arriving at terminal velocity. Accumulated impact speed
  // past this and the block stops being a block and becomes the rubble it throws off.
  //
  // It has to be retuned every time the blast gets harder or the blocks get smaller,
  // because both make the average block fall further before it stops. Too low and a
  // collapse pulverises everything and sweeps its own footprint clean, leaving no
  // mound at all. Measured on the shipped towers: roughly two fifths pulverised, a
  // mound over most of the plan, and wreckage flung five hundred metres out.
  BREAKUP_SPEED: 115,
  // Slabs land skewed and interlock, so a stack of them is shorter than the sum of
  // their thicknesses. Measured against the shipped towers: at these two numbers a
  // full collapse pulverises about five sixths of the building and leaves a mound
  // roughly a third of its height. Left at 1.0 and without break-up, the wreckage of
  // a four-hundred-metre tower piled back up to four hundred metres.
  PILE_COMPACTION: 0.4,
  // Budgets. These ceilings are what keep a collapse off the frame budget.
  MAX_PHYSICAL_MODULES: 3500,
  // How many detachments in one batch are worth an effect. A tower shearing in half
  // is one event to the player, not eighty, and eighty would empty the particle pool
  // on the first frame of it.
  MAX_EFFECTS_PER_BATCH: 10,
  SETTLED_LIFETIME: 30,
  // Beyond this the player cannot see the difference, so falling modules are put
  // straight on the ground instead of being integrated frame by frame.
  PHYSICS_ACTIVATION_DISTANCE: 2600,
};

const IDENTITY = new THREE.Quaternion();
let nextModuleId = 1;

/**
 * The visual half of a destructible, as one instanced box mesh.
 *
 * Every module is an instance, so a tower of sixty-four slabs still costs one draw
 * call - the same as the single box it replaced. Instance matrices are expressed in
 * the mesh's own frame, which means the shader can read `instanceMatrix * position`
 * and get a coordinate in tower space: that is what keeps the curtain wall's columns
 * and floor lines running continuously across the module seams instead of restarting
 * at every slab.
 */
export class ModuleShell {
  constructor({ parent, material, size, count, origin, extent, overlap = 1.002 }) {
    // A hair of overlap between neighbours. Boxes that merely touch can show a
    // hairline of background between them once the projection rounds differently on
    // each side of the seam; the excess is under a tenth of a metre and hidden
    // inside solid geometry everywhere else.
    this.geometry = new THREE.BoxGeometry(
      size.x * overlap, size.y * overlap, size.z * overlap,
    );
    this.mesh = new THREE.InstancedMesh(this.geometry, material, count);
    this.mesh.position.copy(origin);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Culling stays on, against a sphere set by hand rather than recomputed from the
    // instance matrices every frame. Turning it off instead cost a quarter of the
    // frame rate: a four-hundred-metre tower and its shadow were submitted on every
    // frame of every mission, including the ones flown on the far side of the city.
    // The sphere is tight around the intact building and widened only while
    // something is actually in the air - see DestructibleBuilding.update.
    this.tightRadius = extent;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), extent);
    this.mesh.frustumCulled = true;
    parent.add(this.mesh);

    this.origin = origin.clone();
    this.capacity = count;
    this.used = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    this._zero = new THREE.Vector3(0, 0, 0);
    this._colour = new THREE.Color();
    this._dirty = true;
    this._tinted = false;
    for (let i = 0; i < count; i++) {
      this.hide(i);
      // Claims the per-instance colour up front. It is what lets a module that has
      // been hit but not broken show it - without which a slow impact does real,
      // accumulating structural damage that the player has no way of seeing.
      this.mesh.setColorAt(i, this._colour.setRGB(1, 1, 1));
    }
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  /**
   * Scorches an instance by how much of its strength is gone, in [0, 1].
   *
   * Squared, so a block that has been lightly shaken by a blast forty metres away is
   * barely marked while one at the edge of the wound is black. Linear looked right
   * on blocks the size of a room; on blocks the size of a car it turned the whole
   * blast radius into a speckled checkerboard that read as noise rather than damage.
   */
  damage(index, amount) {
    const t = clamp01(amount);
    const k = t * t;
    this.mesh.setColorAt(index, this._colour.setRGB(
      1 - k * 0.6, 1 - k * 0.65, 1 - k * 0.67,
    ));
    this._tinted = true;
  }

  /** Claims an instance and puts it where the module was built. */
  create(centre) {
    const index = this.used++;
    this.place(index, centre, IDENTITY);
    return index;
  }

  place(index, position, quaternion) {
    this._p.copy(position).sub(this.origin);
    this._m.compose(this._p, quaternion ?? IDENTITY, this._one);
    this.mesh.setMatrixAt(index, this._m);
    this._dirty = true;
  }

  hide(index) {
    this._m.compose(this._zero, IDENTITY, this._zero);
    this.mesh.setMatrixAt(index, this._m);
    this._dirty = true;
  }

  /**
   * Widens or tightens the culling sphere. Called when the building starts and
   * stops having pieces in the air, so the cost of being generous is paid only for
   * the few seconds a collapse actually lasts.
   */
  setReach(radius) {
    if (this.mesh.boundingSphere.radius !== radius) this.mesh.boundingSphere.radius = radius;
  }

  /** One upload per frame however many modules moved. */
  flush() {
    if (this._tinted) {
      this.mesh.instanceColor.needsUpdate = true;
      this._tinted = false;
    }
    if (!this._dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this._dirty = false;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
  }
}

/**
 * One structural module: a slab of building with mass, strength and neighbours.
 *
 * It owns its instance in the shell and its entry in the collision grid, so when it
 * fails the same object knows how to stop being part of the building and start being
 * a thing falling through the air.
 */
export class StructuralModule {
  constructor({ building, visual, centre, size, level, cell, mass, strength, grounded }) {
    this.id = nextModuleId++;
    this.building = building;
    this.visual = visual;        // instance index in the building's shell
    this.centre = centre.clone();
    this.origin = centre.clone();
    this.size = size.clone();
    this.level = level;
    this.cell = cell;            // index within the level, for neighbour lookups
    this.mass = mass;
    this.strength = strength;
    this.damage = 0;
    this.grounded = grounded;    // sits on the ground: support of last resort
    this.state = MODULE_STATE.INTACT;
    this.group = null;           // the collision box this block belongs to
    this.supports = [];          // modules that hold this one up
    this.carries = [];           // modules this one holds up
    this.neighbours = [];        // modules this one shares a face with

    // Rigid-body state, unused until the module detaches.
    this.velocity = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.restTimer = 0;
    this.age = 0;
    this.breakup = 0;             // accumulated impact speed since it came away
    // How much of that it can take before it stops being a block. Spread per block
    // rather than one figure for all of them: identical thresholds sit right on the
    // speed of a fall from the roof, so a collapse either pulverised everything or
    // nothing at all depending on which side of it the arithmetic landed. Real
    // masonry is not uniform and neither is this.
    this.toughness = DESTRUCTION.BREAKUP_SPEED * (0.5 + Math.random() * 1.1);
  }

  get intact() {
    return this.state === MODULE_STATE.INTACT
      || this.state === MODULE_STATE.DAMAGED
      || this.state === MODULE_STATE.CRITICAL;
  }

  get integrity() {
    return clamp01(1 - this.damage / this.strength);
  }

  /** Distance from a point to this module's box, zero for a point inside it. */
  distanceTo(point) {
    const dx = Math.max(Math.abs(point.x - this.centre.x) - this.size.x * 0.5, 0);
    const dy = Math.max(Math.abs(point.y - this.centre.y) - this.size.y * 0.5, 0);
    const dz = Math.max(Math.abs(point.z - this.centre.z) - this.size.z * 0.5, 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  applyDamage(amount) {
    if (!this.intact || amount <= 0) return false;
    this.damage += amount;
    if (this.damage >= this.strength) {
      this.state = MODULE_STATE.CRITICAL;
      return true;                                  // ready to come away
    }
    this.state = this.damage > this.strength * 0.45
      ? MODULE_STATE.CRITICAL
      : MODULE_STATE.DAMAGED;
    return false;
  }
}

/**
 * Something the structure carries but does not simulate as part of the lattice: a
 * roof cap, a skybridge. It stays exactly where it was built while enough of the
 * modules under it are standing, and falls as one rigid body when they are not.
 *
 * Keeping these out of the lattice is deliberate. A skybridge is held up by two
 * different towers, which no single building's support graph can express, and a roof
 * parapet is a decoration rather than a load path. Both want the same answer: watch
 * the modules I sit on, and drop when they go.
 */
export class RigidProp {
  constructor({ object, supports, required = 0.5, spread = 0, colliderIndex = -1 }) {
    this.object = object;
    this.supports = supports;
    this.required = required;
    this.spread = spread;               // how wide a shove it gets when it goes
    this.colliderIndex = colliderIndex; // its own entry in the collision grid, if any
    this.home = object.position.clone();
    this.homeQuaternion = object.quaternion.clone();
    this.state = MODULE_STATE.INTACT;
    this.velocity = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.restTimer = 0;
    this.age = 0;
  }

  get fallen() {
    return this.state !== MODULE_STATE.INTACT;
  }

  /** True on the frame it lets go. */
  check() {
    if (this.fallen || this.supports.length === 0) return false;
    let alive = 0;
    for (const m of this.supports) if (m.intact) alive++;
    if (alive / this.supports.length >= this.required) return false;
    this.state = MODULE_STATE.DETACHED;
    this.velocity.set(
      (Math.random() - 0.5) * this.spread, -1.5, (Math.random() - 0.5) * this.spread,
    );
    this.spin.set(
      (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.7,
    );
    return true;
  }

  reset() {
    this.state = MODULE_STATE.INTACT;
    this.object.position.copy(this.home);
    this.object.quaternion.copy(this.homeQuaternion);
    this.object.visible = true;
    this.velocity.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.restTimer = 0;
    this.age = 0;
  }
}

/**
 * A tower built from structural modules.
 *
 * Construction is driven by a description rather than hard-coded, so the same class
 * raises both towers and would raise a third of a different size without changes.
 */
export class DestructibleBuilding {
  constructor({
    name, parent, grid, material, origin, width, depth, height,
    levels = 16, cells = 2, density = 0.135, baseStrength = 1.0,
    groupCells = 3, groupLevels = 3,
  }) {
    this.name = name;
    this.grid = grid;
    this.origin = origin.clone();          // centre of the footprint, at ground level
    this.width = width;
    this.depth = depth;
    this.height = height;
    this.levels = levels;
    this.cells = cells;
    this.modules = [];
    this.falling = [];
    this.props = [];
    this.collapsed = false;
    this.damaged = false;
    // How high the wreckage stands in each column of the plan. Without it every
    // slab in a collapse falls to the same height and the tower reads as melting
    // into the ground instead of piling up on it.
    this.pile = new Float32Array(cells * cells).fill(-Infinity);
    // The plaza the building stands on. Flat by construction, so a block over the
    // footprint never has to ask the world how high the ground is.
    this.groundLevel = origin.y;
    // The highest level still standing in each column, so the search for what is
    // under a falling body starts at the structure rather than at the sky.
    this.columnTop = new Int16Array(cells * cells).fill(levels - 1);
    this.onEvent = null;

    const levelHeight = height / levels;
    const cellW = width / cells;
    const cellD = depth / cells;
    this.moduleSize = new THREE.Vector3(cellW, levelHeight, cellD);
    // Mass follows volume rather than being a number per block, so chopping the same
    // building into finer pieces does not quietly multiply what it weighs.
    this.moduleMass = Math.max(1, density * cellW * cellD * levelHeight);

    // The shell's frame is the centre of the tower, so instance coordinates read as
    // "metres from the middle of the building" - exactly what the curtain wall
    // shader wants, and the same range the single box it replaced used to give it.
    this.shell = new ModuleShell({
      parent,
      material,
      size: this.moduleSize,
      count: levels * cells * cells,
      origin: new THREE.Vector3(origin.x, origin.y + height * 0.5, origin.z),
      extent: Math.hypot(Math.hypot(width, depth) * 0.5, height * 0.5),
    });
    // How far a block can get from the middle of the building before it lands: the
    // whole height, plus an allowance for being thrown sideways. It has to cover the
    // throw, or the culling sphere clips the spray and blocks wink out mid-flight.
    this.fallReach = this.shell.tightRadius + height * 1.2
      + DESTRUCTION.BLAST_PUSH_MAX * 4;

    const centre = new THREE.Vector3();
    for (let level = 0; level < levels; level++) {
      for (let cz = 0; cz < cells; cz++) {
        for (let cx = 0; cx < cells; cx++) {
          centre.set(
            origin.x + (cx - (cells - 1) * 0.5) * cellW,
            origin.y + (level + 0.5) * levelHeight,
            origin.z + (cz - (cells - 1) * 0.5) * cellD,
          );
          // Lower floors carry more of the building, so they are built stronger -
          // which is both true and what stops a tower being trivially felled at the
          // ankles by a glancing blow.
          const heightFrac = level / Math.max(1, levels - 1);
          const strength = baseStrength * (1.55 - 0.7 * heightFrac);
          const m = new StructuralModule({
            building: this,
            visual: this.shell.create(centre),
            centre,
            size: this.moduleSize,
            level,
            cell: cz * cells + cx,
            mass: this.moduleMass,
            strength,
            grounded: level === 0,
          });
          this.modules.push(m);
        }
      }
    }

    // --- collision. The lattice is far too fine to hand to the spatial hash: it
    //     holds a few thousand boxes per tower, they all land in one or two of its
    //     cells, and every query near the building - every falling body asking what
    //     is under it, every aircraft asking what is in front of it - then walks the
    //     lot. Measured at nine-by-nine: a second per frame during a collapse.
    //
    //     So collision gets its own, coarse representation. Blocks are grouped into
    //     boxes a few cells and a few storeys across, one entry each, and a group
    //     stops colliding when the last block inside it has gone. That is a hundred
    //     and twenty-six boxes for a tower instead of three and a half thousand, and
    //     it costs nothing that matters: a hole reads as open air once the blocks
    //     around it are gone, a few metres later than the visual hole appears.
    this.groups = [];
    const gc = Math.max(1, Math.min(cells, groupCells));
    const gl = Math.max(1, Math.min(levels, groupLevels));
    for (let l0 = 0; l0 < levels; l0 += gl) {
      for (let z0 = 0; z0 < cells; z0 += gc) {
        for (let x0 = 0; x0 < cells; x0 += gc) {
          const members = [];
          for (let l = l0; l < Math.min(levels, l0 + gl); l++) {
            for (let cz = z0; cz < Math.min(cells, z0 + gc); cz++) {
              for (let cx = x0; cx < Math.min(cells, x0 + gc); cx++) {
                members.push(this.at(l, cx, cz));
              }
            }
          }
          if (!members.length) continue;
          const lo = members[0];
          const hi = members[members.length - 1];
          const group = {
            building: this, members, remaining: members.length, colliderIndex: -1,
          };
          group.colliderIndex = grid.add(
            lo.centre.x - cellW * 0.5, hi.centre.x + cellW * 0.5,
            lo.centre.z - cellD * 0.5, hi.centre.z + cellD * 0.5,
            lo.centre.y - levelHeight * 0.5, hi.centre.y + levelHeight * 0.5,
            'landmark', group,
          );
          for (const m of members) m.group = group;
          this.groups.push(group);
        }
      }
    }

    // --- connections: the level below holds this one up, and the modules beside it
    //     share load laterally. Both matter: vertical support is what a tower stands
    //     on, lateral connection is what lets a damaged corner hang on for a moment
    //     instead of dropping the instant its own column goes.
    for (let level = 0; level < levels; level++) {
      for (let cz = 0; cz < cells; cz++) {
        for (let cx = 0; cx < cells; cx++) {
          const m = this.at(level, cx, cz);
          const below = this.at(level - 1, cx, cz);
          if (below) { m.supports.push(below); below.carries.push(m); }
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = this.at(level, cx + dx, cz + dz);
            if (n) m.neighbours.push(n);
          }
        }
      }
    }
  }

  /** Which cell of the plan a world-space point falls in, or -1 for outside it. */
  cellAt(x, z) {
    const cx = Math.floor((x - (this.origin.x - this.width * 0.5)) / this.moduleSize.x);
    const cz = Math.floor((z - (this.origin.z - this.depth * 0.5)) / this.moduleSize.z);
    if (cx < 0 || cx >= this.cells || cz < 0 || cz >= this.cells) return -1;
    return cz * this.cells + cx;
  }

  /**
   * The top of the highest module still standing under a point.
   *
   * This is what a falling body lands on. Without it a slab that comes away from
   * storey nine drops through the nine storeys underneath it and lands in the street,
   * which is the one thing that would give away that the tower is not solid. With it
   * the wreckage piles on the stump, which is also what a building does.
   */
  supportTopBelow(x, z, y) {
    const m = this.moduleUnder(x, z, y);
    return m ? m.centre.y + m.size.y * 0.5 : -Infinity;
  }

  /**
   * The module still standing directly under a point, or null.
   *
   * Every falling body asks this every frame, so the scan starts at the highest
   * level in that column still standing rather than at the body's own level. During
   * a collapse almost every body is somewhere above the stump, and without that the
   * scan walks the entire height of the building for each of them - which, at a
   * couple of thousand bodies and thirty-four storeys, is the whole cost of the
   * integrator.
   */
  moduleUnder(x, z, y) {
    const cell = this.cellAt(x, z);
    if (cell < 0) return null;
    const top = this.columnTop[cell];
    if (top < 0) return null;
    const cx = cell % this.cells;
    const cz = (cell / this.cells) | 0;
    const start = Math.min(top, this.levelAt(y));
    for (let level = start; level >= 0; level--) {
      const m = this.at(level, cx, cz);
      if (m && m.intact) return m;
    }
    return null;
  }

  /** Recomputes the highest level still standing in one column. */
  _lowerColumnTop(cell) {
    const cx = cell % this.cells;
    const cz = (cell / this.cells) | 0;
    let top = this.columnTop[cell];
    while (top >= 0) {
      const m = this.at(top, cx, cz);
      if (m && m.intact) break;
      top--;
    }
    this.columnTop[cell] = top;
  }

  /** How high the rubble already stands in the column over a point. */
  pileTopAt(x, z) {
    const cell = this.cellAt(x, z);
    return cell < 0 ? -Infinity : this.pile[cell];
  }

  at(level, cx, cz) {
    const { levels, cells } = this;
    if (level < 0 || level >= levels || cx < 0 || cx >= cells || cz < 0 || cz >= cells) {
      return null;
    }
    return this.modules[level * cells * cells + cz * cells + cx];
  }

  /** Every module on one storey, for hanging a roof or a bridge off it. */
  levelModules(level) {
    return this.modules.filter((m) => m.level === level);
  }

  /** The storey a height above ground falls in. */
  levelAt(y) {
    return clamp(
      Math.floor((y - this.origin.y) / (this.height / this.levels)), 0, this.levels - 1,
    );
  }

  addProp(prop) {
    this.props.push(prop);
    return prop;
  }

  get standing() {
    return this.modules.some((m) => m.intact);
  }

  get integrity() {
    let sum = 0;
    for (const m of this.modules) sum += m.intact ? m.integrity : 0;
    return sum / this.modules.length;
  }

  /** Cheap rejection before any real work: is this impact even near the building? */
  reaches(point, radius = 0) {
    const halfW = this.width * 0.5 + radius;
    const halfD = this.depth * 0.5 + radius;
    return Math.abs(point.x - this.origin.x) <= halfW
      && Math.abs(point.z - this.origin.z) <= halfD
      && point.y >= this.origin.y - radius
      && point.y <= this.origin.y + this.height + radius;
  }

  /**
   * Localised damage from one impact.
   *
   * Strength falls off with distance from the contact point - measured to the
   * module's surface, so the slab actually struck takes the whole hit - and a blow
   * driven into the face does more than one that slides along it. Nothing here knows
   * about the building as a whole: a tower comes down, when it does, because of what
   * the support pass below makes of the hole this leaves.
   */
  applyImpact(impact) {
    const reach = clamp(
      DESTRUCTION.BLAST_BASE + impact.strength * DESTRUCTION.BLAST_PER_STRENGTH,
      DESTRUCTION.BLAST_BASE, DESTRUCTION.BLAST_MAX,
    );
    const broken = [];
    let absorbed = 0;

    for (const m of this.modules) {
      if (!m.intact) continue;
      const d = m.distanceTo(impact.position);
      if (d > reach) continue;
      let share = Math.pow(1 - clamp01(d / reach), DESTRUCTION.BLAST_FALLOFF);
      if (impact.direction) {
        const dir = _v1.copy(m.centre).sub(impact.position);
        if (dir.lengthSq() > 1e-4) {
          dir.normalize();
          share *= 0.55 + 0.45 * clamp01(impact.direction.dot(dir) * 0.5 + 0.5);
        }
      }
      const dealt = impact.strength * share;
      if (dealt <= 0.001) continue;
      absorbed += dealt;
      if (m.applyDamage(dealt)) broken.push(m);
      else this.shell.damage(m.visual, 1 - m.integrity);
    }

    if (absorbed <= 0) return { broke: 0, absorbed: 0 };
    this.damaged = true;
    for (const m of broken) this._detach(m, impact);
    this.settleStructure();
    this.shell.flush();
    return { broke: broken.length, absorbed };
  }

  /**
   * The support pass.
   *
   * One rule, run to a fixed point: a block has to be able to trace a path back to
   * the ground through blocks that are still standing. Anything that cannot is an
   * island - a slab of building severed from the earth - and it comes down.
   *
   * Running to a fixed point is what makes this propagation rather than a script:
   * each pass removes what the previous pass stopped holding up, and the collapse
   * ends where the structure happens to be able to take it. In practice a single
   * hole never triggers it, because the rest of the plan still reaches the ground
   * around the hole; cutting a storey through, or taking the base out, does.
   */
  settleStructure() {
    // The bound is the height of the building, not a round number. Failure climbs at
    // most one storey per pass, so a fixed twelve stopped being a fixed point the
    // moment the lattice grew past twelve levels: a cut low down left the top two
    // storeys of the sheared columns standing on nothing at all.
    const limit = this.levels + 2;
    for (let pass = 0; pass < limit; pass++) {
      const reachable = this._reachableFromGround();
      const doomed = [];
      for (const m of this.modules) {
        if (m.intact && !reachable.has(m)) doomed.push(m);
      }
      if (doomed.length === 0) break;
      // Detached with no impact, always. These blocks were not touched by the blast -
      // they are coming down because what was holding them up is gone - and _detach
      // says as much, but the impact used to be handed straight through to them, so
      // every block in a tower the blast brought down got thrown as if the blast had
      // reached it. It never showed while the throw was mostly upwards: the building
      // went up and came back down roughly where it stood. Flattened into the
      // horizontal it showed immediately, as a collapsing tower sliding two hundred
      // and fifty metres sideways and leaving its own footprint swept clean.
      for (const m of doomed) this._detach(m, null);
    }
    for (const p of this.props) {
      if (!p.check()) continue;
      // A prop that has let go stops being something to fly into.
      if (p.colliderIndex >= 0) this.grid.remove(p.colliderIndex);
      this.onEvent?.({ type: 'prop', prop: p, building: this });
    }
    if (!this.standing && !this.collapsed) {
      this.collapsed = true;
      this.onEvent?.({ type: 'collapse', building: this });
    }
  }

  /** Flood fill up from the ground through modules that are still standing. */
  _reachableFromGround() {
    const seen = new Set();
    const stack = [];
    for (const m of this.modules) {
      if (m.grounded && m.intact) { seen.add(m); stack.push(m); }
    }
    while (stack.length) {
      const m = stack.pop();
      // Anything this module holds up, or stands beside, is reachable through it.
      for (const list of [m.carries, m.neighbours]) {
        for (const other of list) {
          if (seen.has(other) || !other.intact) continue;
          seen.add(other);
          stack.push(other);
        }
      }
    }
    return seen;
  }

  /** A module stops being structure and becomes a body falling through the air. */
  _detach(m, impact) {
    if (!m.intact) return;
    m.state = MODULE_STATE.DETACHED;
    m.damage = Math.max(m.damage, m.strength);
    // The block's collision group only stops blocking once every block in it is gone.
    if (m.group && --m.group.remaining <= 0) this.grid.remove(m.group.colliderIndex);
    if (m.level === this.columnTop[m.cell]) this._lowerColumnTop(m.cell);

    // Thrown out of the wound, hardest at the centre of it and falling away with
    // distance, plus a lift so the spray arcs and a hard tumble so the blocks read
    // as masonry rather than as cards. A block that comes away later because its
    // support went gets none of this - it just falls, which is the difference
    // between the explosion and the collapse that follows it.
    let thrown = 0;
    if (impact) {
      const away = _v1.copy(m.centre).sub(impact.position);
      const dist = Math.max(1, away.length());
      away.normalize();
      // The falloff is gentler than it was: at 30/dist only the blocks right at the
      // wound were really thrown and the rest sagged out, so the spray had a hard
      // edge a few metres wide. Half the blast radius keeps most of the opening
      // moving at speed and still lets the far side of the building merely drop.
      thrown = clamp(impact.strength * DESTRUCTION.BLAST_PUSH, 0, DESTRUCTION.BLAST_PUSH_MAX)
        * clamp(70 / dist, 0.15, 1);
      // Flattened, not weakened.
      //
      // Radially, a block sitting above the wound is thrown straight up at the full
      // push, and with the lift on top of that the biggest hits fired everything over
      // the wound hundreds of metres into the air on a fountain that came back down on
      // the roof. A blast inside a building cannot push through the floors above and
      // below it anything like as easily as it vents out of the face it has just
      // opened, so no more than a set share of the throw is allowed to be vertical.
      //
      // Scaling the vertical component would not have been enough on its own: for a
      // block directly over the wound the radial direction is (0, 1, 0), and scaling
      // that leaves it pointing straight up however hard it is scaled. What it needs
      // is somewhere to go, so the balance is put back into the horizontal - outwards
      // if there is any outward to speak of, and along the aircraft's own track for
      // the handful of blocks sitting exactly over the impact.
      const capY = DESTRUCTION.BLAST_VERT_MAX;
      if (Math.abs(away.y) > capY) {
        const sideways = Math.sqrt(1 - capY * capY);
        const hl = Math.hypot(away.x, away.z);
        if (hl > 1e-4) {
          away.x = (away.x / hl) * sideways;
          away.z = (away.z / hl) * sideways;
        } else {
          const d = impact.direction;
          const dl = d ? Math.hypot(d.x, d.z) : 0;
          const a = Math.random() * Math.PI * 2;
          away.x = dl > 1e-4 ? (d.x / dl) * sideways : Math.cos(a) * sideways;
          away.z = dl > 1e-4 ? (d.z / dl) * sideways : Math.sin(a) * sideways;
        }
        away.y = Math.sign(away.y) * capY;
      }
      m.velocity.copy(away).multiplyScalar(thrown * 0.75);
      m.velocity.addScaledVector(impact.direction ?? away, thrown * 0.3);
      m.velocity.y += thrown * DESTRUCTION.BLAST_LIFT;
    }
    m.velocity.y -= 1.2;
    // Spin scales with the throw: what is flung tumbles, what merely drops turns over
    // slowly, and one number does both.
    const tumble = 0.7 + thrown * 0.055;
    m.spin.set(
      (Math.random() - 0.5) * DESTRUCTION.BLAST_SPIN * tumble,
      (Math.random() - 0.5) * DESTRUCTION.BLAST_SPIN * 0.7 * tumble,
      (Math.random() - 0.5) * DESTRUCTION.BLAST_SPIN * tumble,
    );

    if (this.falling.length < DESTRUCTION.MAX_PHYSICAL_MODULES) {
      this.falling.push(m);
      this.onEvent?.({ type: 'detach', module: m, building: this });
    } else {
      // Over budget: skip the simulation and retire it, so a very large collapse
      // degrades by dropping detail rather than by dropping frames.
      this._retire(m);
    }
  }

  _retire(m) {
    m.state = MODULE_STATE.DESTROYED;
    // A retired body is not simulated again, so leaving its last velocity on it is a
    // lie that anything reading the wreckage afterwards will believe.
    m.velocity.set(0, 0, 0);
    m.spin.set(0, 0, 0);
    this.shell.hide(m.visual);
  }

  /**
   * Integrates the modules currently in the air.
   *
   * `simulate` is false when the player is too far away to tell the difference, in
   * which case everything in flight is put on the ground and put to sleep in one
   * step rather than costing a frame's work every frame for the next ten seconds.
   */
  update(dt, groundAt, onLanded, simulate = true) {
    // Only widen the culling sphere while there is something outside the building.
    this.shell.setReach(this.falling.length ? this.fallReach : this.shell.tightRadius);
    // Props are checked every frame because one of them can be held up by another
    // building - but only once this building has been touched at all, which for the
    // whole of a normal mission is never.
    if (this.damaged) for (const p of this.props) {
      // Checked here as well as after an impact, because a prop can be held up by
      // modules in another building - the skybridge is - and that building's own
      // settle pass is the only thing that would otherwise notice.
      if (p.check()) {
        if (p.colliderIndex >= 0) this.grid.remove(p.colliderIndex);
        this.onEvent?.({ type: 'prop', prop: p, building: this });
      }
      this._updateProp(p, dt, groundAt, simulate);
    }
    if (this.falling.length === 0) { this.shell.flush(); return; }
    const g = DESTRUCTION.GRAVITY;
    // Floors crushed by what landed on them this frame. Collected rather than acted
    // on inside the loop, so the support pass runs once over a settled structure.
    const crushed = [];

    for (let i = this.falling.length - 1; i >= 0; i--) {
      const m = this.falling[i];
      m.age += dt;

      if (m.state === MODULE_STATE.SETTLED) {
        if (m.age > DESTRUCTION.SETTLED_LIFETIME) {
          this._retire(m);
          this.falling.splice(i, 1);
        }
        continue;
      }

      if (!simulate) {
        m.centre.y = groundAt(m.centre.x, m.centre.z, m.centre.y) + m.size.y * 0.5;
        m.state = MODULE_STATE.SETTLED;
        m.velocity.set(0, 0, 0);
        m.spin.set(0, 0, 0);
        m.age = 0;
        this.shell.place(m.visual, m.centre, m.quaternion);
        continue;
      }

      // Where the underside was before this step. It, not the position after the
      // step, is what decides which surfaces count as "below": a roof the body was
      // above a moment ago is exactly the roof it is now landing on, and asking
      // after the step means the roof stops counting on the very frame the body
      // reaches it and the body drops straight through.
      const wasAbove = m.centre.y - m.size.y * 0.5;
      m.velocity.y += g * dt;
      m.velocity.multiplyScalar(1 - DESTRUCTION.AIR_DRAG * dt);
      m.centre.addScaledVector(m.velocity, dt);

      // Contact. The floor is whichever is higher: the structure still standing
      // under this point, the nearest roof beneath it, or the terrain - so a slab
      // that slides off the plaza lands on the street rather than at sea level, one
      // that drops straight down piles onto the stump rather than falling through
      // it, and one thrown clear comes to rest on the neighbours' roofs.
      // Three candidate surfaces: the street or the nearest roof, the building still
      // standing under this point, and the wreckage already down in this column.
      const cell = this.cellAt(m.centre.x, m.centre.z);
      const standing = this.moduleUnder(m.centre.x, m.centre.z, m.centre.y);

      /**
       * A surface is only a floor if the body was already above it.
       *
       * Without that test a block thrown sideways out of the wound finds the storey it
       * is level with "underneath" it the moment it crosses into the part of the tower
       * still standing, gets stood on top of that storey, and does the same again on
       * the next frame - climbing the building one storey per frame until it pops out
       * on the roof, half a second later, having passed straight through forty floors.
       * It was two thirds of everything a hit broke off: sixty-four of the ninety-six
       * blocks the trainer knocked loose ended up on the roof, and the rubble piled to
       * six hundred metres over a four-hundred-and-sixty-metre building.
       */
      const floorAt = (top) => (top <= wasAbove + CONTACT_SKIN ? top : -Infinity);
      const structureTop = standing ? standing.centre.y + standing.size.y * 0.5 : -Infinity;
      const onStructure = floorAt(structureTop);
      const onRubble = cell < 0 ? -Infinity : floorAt(this.pile[cell]);
      // Over its own footprint there is nothing the world can offer that this
      // building does not already know about - its own structure, its own rubble and
      // the plaza - so the world query is skipped entirely. It is only worth asking
      // for blocks thrown clear, which is where the neighbours' roofs are.
      const surface = cell >= 0
        ? Math.max(this.groundLevel, onStructure, onRubble)
        : Math.max(groundAt(m.centre.x, m.centre.z, wasAbove), onStructure, onRubble);
      const floor = surface + m.size.y * 0.5;

      // Inside what is still standing rather than on top of it: the block has run into
      // the wall of the shaft, not landed on a floor. It cannot climb the storey it is
      // level with, and it should not sail through it either, so the run is killed and
      // gravity takes it down the face of the building.
      if (standing && onStructure === -Infinity && structureTop > -Infinity) {
        m.velocity.x *= WALL_FRICTION;
        m.velocity.z *= WALL_FRICTION;
      }

      if (m.centre.y <= floor) {
        m.centre.y = floor;
        if (m.velocity.y < -DESTRUCTION.SLEEP_SPEED) {
          const hitSpeed = -m.velocity.y;

          // The structure under this point takes the blow, whether the block came
          // down on it directly or on the rubble heaped over it - a metre of loose
          // masonry does not isolate a floor from what lands on top of it. This is
          // the pancake: if the blow is bigger than the floor, the floor comes away
          // too and the collapse moves down a storey. The front accelerates on its
          // own because every storey it takes lengthens the fall onto the next one,
          // and damage accumulates, so a storey that shrugs off the first block to
          // reach it does not shrug off the fifteenth. Nothing here is scheduled.
          if (standing && standing.intact && onStructure > -Infinity) {
            const blow = clamp(
              (m.mass / this.moduleMass) * hitSpeed / DESTRUCTION.PANCAKE_SPEED,
              0, DESTRUCTION.PANCAKE_MAX,
            );
            if (standing.applyDamage(blow)) crushed.push(standing);
            else this.shell.damage(standing.visual, 1 - standing.integrity);
          }

          m.velocity.y = hitSpeed * DESTRUCTION.RESTITUTION;
          m.velocity.x *= DESTRUCTION.FRICTION;
          m.velocity.z *= DESTRUCTION.FRICTION;
          m.spin.multiplyScalar(0.5);
          onLanded?.(m, hitSpeed);

          // And the slab itself. Masonry does not survive arriving at speed; past a
          // point it stops being a block and becomes the rubble it throws off.
          m.breakup += hitSpeed;
          if (m.breakup > m.toughness) {
            this.onEvent?.({ type: 'shatter', module: m, building: this });
            this._retire(m);
            this.falling.splice(i, 1);
            continue;
          }
        } else {
          m.velocity.set(0, 0, 0);
        }
      }

      // Sleep once it has stopped moving, which is what stops a pile of slabs
      // jittering against the ground for the rest of the session.
      if (m.velocity.lengthSq() < DESTRUCTION.SLEEP_SPEED * DESTRUCTION.SLEEP_SPEED) {
        m.restTimer += dt;
        if (m.restTimer > DESTRUCTION.SLEEP_TIME) {
          m.state = MODULE_STATE.SETTLED;
          m.velocity.set(0, 0, 0);
          m.spin.set(0, 0, 0);
          m.age = 0;
          const cell = this.cellAt(m.centre.x, m.centre.z);
          if (cell >= 0) {
            this.pile[cell] = Math.max(
              this.pile[cell],
              m.centre.y + m.size.y * 0.5 * DESTRUCTION.PILE_COMPACTION,
            );
          }
        }
      } else {
        m.restTimer = 0;
      }

      if (m.spin.lengthSq() > 1e-6) {
        _e1.set(m.spin.x * dt, m.spin.y * dt, m.spin.z * dt);
        m.quaternion.multiply(_q1.setFromEuler(_e1));
      }
      this.shell.place(m.visual, m.centre, m.quaternion);
    }

    // One pass for every floor that gave way under the wreckage this frame. Whatever
    // those floors were holding up now has nothing under it, so it joins the fall -
    // which is the next storey of the collapse, arrived at rather than scripted.
    if (crushed.length) {
      for (const c of crushed) this._detach(c, null);
      this.settleStructure();
    }
    this.shell.flush();
  }

  _updateProp(p, dt, groundAt, simulate) {
    if (p.state !== MODULE_STATE.DETACHED) return;
    p.age += dt;
    const o = p.object;
    if (!simulate) {
      o.position.y = groundAt(o.position.x, o.position.z, o.position.y);
      p.state = MODULE_STATE.SETTLED;
      return;
    }
    const wasAbove = o.position.y;
    p.velocity.y += DESTRUCTION.GRAVITY * dt;
    p.velocity.multiplyScalar(1 - DESTRUCTION.AIR_DRAG * dt);
    o.position.addScaledVector(p.velocity, dt);
    _e1.set(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt);
    o.quaternion.multiply(_q1.setFromEuler(_e1));
    const floor = Math.max(
      groundAt(o.position.x, o.position.z, wasAbove),
      this.supportTopBelow(o.position.x, o.position.z, o.position.y),
    );
    if (o.position.y <= floor) {
      o.position.y = floor;
      p.state = MODULE_STATE.SETTLED;
      p.velocity.set(0, 0, 0);
      p.spin.set(0, 0, 0);
    }
  }

  /** Puts the building back exactly as it was built. */
  reset() {
    for (const m of this.modules) {
      m.damage = 0;
      m.state = MODULE_STATE.INTACT;
      m.centre.copy(m.origin);
      m.velocity.set(0, 0, 0);
      m.spin.set(0, 0, 0);
      m.quaternion.identity();
      m.restTimer = 0;
      m.age = 0;
      m.breakup = 0;
      this.shell.place(m.visual, m.origin, m.quaternion);
      this.shell.damage(m.visual, 0);

    }
    this.shell.flush();
    // Collision boxes never moved - a block in the air is not something to fly into,
    // so detaching retires its group rather than dragging it along - which means
    // putting the building back is only a matter of putting the boxes back in play.
    for (const g of this.groups) {
      g.remaining = g.members.length;
      this.grid.revive(g.colliderIndex);
    }
    for (const p of this.props) {
      p.reset();
      if (p.colliderIndex >= 0) this.grid.revive(p.colliderIndex);
    }
    this.falling.length = 0;
    this.collapsed = false;
    this.damaged = false;
    this.pile.fill(-Infinity);
    this.columnTop.fill(this.levels - 1);
    this.shell.setReach(this.shell.tightRadius);
  }
}

/**
 * What one collision hands the structure.
 *
 * Kinetic energy is the honest measure - half m v squared - but what a module needs
 * is a number on the same scale as its own strength. The reference energy converts
 * one into the other, and the ceiling stops the fastest aircraft in the catalogue
 * turning into an order-of-magnitude problem.
 */
export function makeImpact({ position, normal, direction, velocity, mass, speed }) {
  const v = speed ?? velocity?.length() ?? 0;
  const m = Math.max(0.05, mass ?? 1);
  const energy = 0.5 * m * v * v;
  const strength = clamp(
    energy / DESTRUCTION.REFERENCE_ENERGY, 0, DESTRUCTION.ENERGY_CEILING,
  );
  return {
    position: position.clone(),
    normal: normal ? normal.clone() : new THREE.Vector3(0, 1, 0),
    direction: direction ? direction.clone().normalize() : new THREE.Vector3(0, -1, 0),
    speed: v,
    mass: m,
    energy,
    strength,
  };
}

/**
 * Owns every destructible in the world and is the one thing the rest of the game
 * talks to: hand it a collision and it decides what, if anything, comes apart.
 *
 * It exists so that neither WorldManager nor the flight model has to know how a
 * building is put together, and so that a second pair of towers - or any other
 * structure built out of modules - joins the simulation by being added here.
 */
export class DestructionField {
  constructor({ bus = null, debris = null } = {}) {
    this.bus = bus;
    this.debris = debris;
    this.buildings = [];
    this.stats = { impacts: 0, detached: 0, collapses: 0 };
    this._v = new THREE.Vector3();
    this._propExtent = new THREE.Vector3(14, 4, 14);
    this._effects = 0;
    this._landings = 0;
  }

  add(building) {
    building.onEvent = (e) => this._onEvent(e);
    this.buildings.push(building);
    return building;
  }

  get anyActive() {
    return this.buildings.some((b) => b.falling.length > 0);
  }

  /**
   * Routes one collision to the structure it hit.
   *
   * The grid hands back the module that was struck, so the usual path is exact. The
   * fallback - asking every building whether the point is inside it - only runs when
   * something collided with a landmark that has no module behind it.
   */
  impact(payload) {
    if (!payload?.point) return null;
    this._effects = 0;
    let building = payload.ref?.building ?? null;
    if (!building) {
      for (const b of this.buildings) {
        if (b.reaches(payload.point, 14)) { building = b; break; }
      }
    }
    if (!building || !building.standing) return null;

    const impact = makeImpact({
      position: payload.point,
      normal: payload.normal,
      direction: payload.direction ?? (payload.normal
        ? this._v.copy(payload.normal).multiplyScalar(-1) : null),
      speed: payload.speed,
      mass: payload.mass,
    });
    const result = building.applyImpact(impact);
    this.stats.impacts++;
    if (result.broke > 0 || result.absorbed > 0.15) {
      this.bus?.emit('structure:impact', {
        building: building.name,
        point: impact.position,
        strength: impact.strength,
        broke: result.broke,
      });
    }
    return result;
  }

  update(dt, focus, groundAt) {
    this._landings = 0;
    for (const b of this.buildings) {
      const simulate = !focus
        || b.origin.distanceTo(focus) < DESTRUCTION.PHYSICS_ACTIVATION_DISTANCE;
      b.update(dt, groundAt, (m, speed) => this._onLanded(m, speed), simulate);
    }
    this.debris?.update(dt, focus, groundAt);
  }

  reset() {
    for (const b of this.buildings) b.reset();
    this.debris?.clear();
    this.stats.impacts = 0;
    this.stats.detached = 0;
    this.stats.collapses = 0;
  }

  _onEvent(e) {
    if (e.type === 'detach') {
      this.stats.detached++;
      if (this._effects++ >= DESTRUCTION.MAX_EFFECTS_PER_BATCH) return;
      const m = e.module;
      // Chunks leave with the block, not at a fixed speed: a block flung out of the
      // wound sheds its rubble into the same spray.
      this.debris?.burst(m.centre, m.size, 10, 9 + m.velocity.length() * 0.55);
      this.bus?.emit('structure:detach', {
        building: e.building.name,
        point: m.centre.clone(),
        // Where to look from outside. Anything framing this wants the building, not
        // the module: the collapse happens over four hundred metres, and the slab
        // that came away is the least of it.
        focus: new THREE.Vector3(
          e.building.origin.x,
          e.building.origin.y + e.building.height * 0.45,
          e.building.origin.z,
        ),
        span: Math.max(e.building.width, e.building.height),
        size: Math.max(m.size.x, m.size.z),
      });
    } else if (e.type === 'shatter') {
      // A block arriving at speed does not stay a block. The pieces it becomes are
      // what the pile is actually made of.
      const m = e.module;
      this.debris?.burst(m.centre, m.size, 14, 13);
      this.bus?.emit('structure:landed', {
        point: m.centre.clone(), speed: 55, size: Math.max(m.size.x, m.size.z),
      });
    } else if (e.type === 'prop') {
      this.debris?.burst(e.prop.object.position, this._propExtent, 6, 7);
    } else if (e.type === 'collapse') {
      this.stats.collapses++;
      this.bus?.emit('structure:collapse', {
        building: e.building.name,
        point: e.building.origin.clone(),
      });
    }
  }

  _onLanded(m, speed) {
    // Spread over frames rather than over the batch: a collapse lands a few slabs
    // per frame and each one is worth a puff, but a pancaking pile is not worth
    // sixty of them at once.
    if (this._landings++ >= 4) return;
    this.debris?.burst(m.centre, m.size, 6, 8);
    this.bus?.emit('structure:landed', {
      point: m.centre.clone(),
      speed,
      size: Math.max(m.size.x, m.size.z),
    });
  }
}

const _v1 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
