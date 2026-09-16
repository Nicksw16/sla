import * as THREE from 'three';
import { clamp } from '../core/MathUtils.js';
import { DestructibleBuilding } from './Destructible.js';
import { latticeMaterial } from './Landmarks.js';

/**
 * Every building in the city, destructible - but only once something hits it.
 *
 * The city has 3,178 buildings. The twin towers are 3,402 blocks each and are by a wide
 * margin the most expensive objects in the world; giving all 3,178 a lattice like that
 * up front would be about 1.4 million blocks and 3,178 instanced meshes, which would not
 * load, let alone run. So a building stays what it has always been - a handful of
 * instances in one shared mesh and one box in the collision grid - until an aircraft
 * flies into it. At that moment it is rebuilt as a real lattice, the instances it owned
 * are emptied out of the shared mesh, and every part of the existing destruction system
 * applies to it unchanged: blast, throw, support pass, pancake, rubble, debris.
 *
 * What makes this cheap is that the generator already worked out everything needed to
 * rebuild a building and used to throw it away. See addBuilding: position, footprint,
 * height, colour, and which instances in the shared mesh belong to it.
 */

/**
 * Block size, in metres, aimed for when a building is converted.
 *
 * Kept near the towers' own 7.6 m so masonry is the same size everywhere in the city -
 * a hatchback-sized block in one street and a bus-sized one in the next reads as two
 * different games. The bounds are what stop a garden shed becoming one indivisible
 * lump, or a skyscraper becoming forty thousand blocks.
 */
const TARGET_BLOCK = 8.0;
const TARGET_STOREY = 10.5;
const MIN_CELLS = 2;
const MAX_CELLS = 9;
const MIN_LEVELS = 2;
const MAX_LEVELS = 30;

/**
 * How many wrecked buildings stand at once.
 *
 * Ruins persist - flying back over what you knocked down is most of the point - but not
 * without a bound. Past this the oldest wreck is cleared, which is the only way to
 * promise the frame budget holds however long somebody spends demolishing the place.
 */
const MAX_RUINS = 10;

/** Per-building block cap, so one huge tower cannot eat the whole physics budget. */
const MAX_BLOCKS = 900;

export class CityDestruction {
  constructor({ recipes, batches, grid, parent, field }) {
    this.recipes = recipes ?? [];
    this.batches = batches ?? {};
    this.grid = grid;
    this.parent = parent;
    this.field = field;
    this.ruins = [];
    this._m = new THREE.Matrix4();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  /**
   * The lattice a building of this size should become.
   *
   * Resolution follows the building rather than being fixed, so the block size stays
   * roughly constant and a shed does not get the same 3,402 blocks as a 452 m tower.
   */
  static latticeFor(recipe) {
    const span = Math.max(recipe.w, recipe.d);
    let cells = clamp(Math.round(span / TARGET_BLOCK), MIN_CELLS, MAX_CELLS);
    let levels = clamp(Math.round(recipe.height / TARGET_STOREY), MIN_LEVELS, MAX_LEVELS);
    // Trim the tallest and widest back rather than let one building take the budget.
    while (cells * cells * levels > MAX_BLOCKS && levels > MIN_LEVELS) levels--;
    while (cells * cells * levels > MAX_BLOCKS && cells > MIN_CELLS) cells--;
    return { cells, levels, blocks: cells * cells * levels };
  }

  /** Is this recipe already a live destructible? */
  static isConverted(recipe) {
    return !!recipe?.building;
  }

  /**
   * Take a building out of the shared city mesh.
   *
   * Its instances are scaled to nothing rather than removed: the mesh is one buffer
   * shared by three thousand buildings and compacting it would move every instance
   * after this one. A zero-scale instance draws nothing.
   */
  _hide(recipe) {
    for (const [name, span] of Object.entries(recipe.spans)) {
      const mesh = this.batches[name];
      if (!mesh || span[1] <= span[0]) continue;
      for (let i = span[0]; i < span[1]; i++) {
        if (i >= mesh.count) continue;
        mesh.setMatrixAt(i, this._zero);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Put it back, exactly where it was. Used when a ruin is cleared and on reset. */
  _restore(recipe) {
    for (const [name, span] of Object.entries(recipe.spans)) {
      const mesh = this.batches[name];
      if (!mesh || span[1] <= span[0] || !mesh.userData.homeMatrices) continue;
      const home = mesh.userData.homeMatrices;
      for (let i = span[0]; i < span[1]; i++) {
        if (i >= mesh.count) continue;
        this._m.fromArray(home, i * 16);
        mesh.setMatrixAt(i, this._m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Remember where every instance started, so a hidden building can be put back.
   *
   * Copied once, at build time, because the instance matrices are the only record of
   * where anything is and zeroing one is otherwise irreversible.
   */
  rememberHome() {
    for (const mesh of Object.values(this.batches)) {
      if (!mesh || mesh.userData.homeMatrices) continue;
      mesh.userData.homeMatrices = mesh.instanceMatrix.array.slice();
    }
  }

  /**
   * Turn a recipe into a real building that can be knocked down.
   *
   * Returns the live destructible, or null if this recipe cannot be converted.
   */
  convert(recipe) {
    if (!recipe) return null;
    if (recipe.building) return recipe.building;

    const { cells, levels } = CityDestruction.latticeFor(recipe);
    // The lattice stands where the building stood: same footprint centre, same base.
    const origin = new THREE.Vector3(recipe.x, recipe.base, recipe.z);
    const building = new DestructibleBuilding({
      name: `city:${recipe.index}`,
      parent: this.parent,
      grid: this.grid,
      material: latticeMaterial(recipe.color),
      origin,
      width: recipe.w,
      depth: recipe.d,
      height: recipe.height,
      levels,
      cells,
      density: 0.135,
      // Ordinary buildings are not built like the landmarks. A tower block gives way to
      // something a twin tower shrugs off, which is what makes flying into one of the
      // Gemini Towers feel like hitting something and flying into an office block feel
      // like going through it.
      baseStrength: 0.34,
      groupCells: Math.max(2, Math.ceil(cells / 3)),
      groupLevels: Math.max(2, Math.ceil(levels / 4)),
    });

    // The old representation goes at the moment the new one appears - never both.
    this._hide(recipe);
    if (recipe.collider >= 0) this.grid.remove(recipe.collider);

    recipe.building = building;
    building.recipe = recipe;
    this.field?.add(building);
    this.ruins.push(recipe);
    this._enforceBudget();
    return building;
  }

  /**
   * Clear the oldest wreck once there are too many.
   *
   * A cleared building goes back to being a recipe: its lattice and collision boxes are
   * disposed of and its instances come back. That is a visible event - a ruin you flew
   * past is whole again - so the bound is generous enough that it happens well behind
   * you rather than in front.
   */
  _enforceBudget() {
    while (this.ruins.length > MAX_RUINS) {
      const oldest = this.ruins.shift();
      this._clear(oldest);
    }
  }

  _clear(recipe) {
    const b = recipe.building;
    if (!b) return;
    this.field?.remove(b);
    b.dispose?.();
    recipe.building = null;
    this._restore(recipe);
    // Revived, not re-added. The box is still in the grid with its index intact; adding
    // a replacement would grow the array every time a ruin is recycled, which over a
    // long session of demolition is a slow leak of collision boxes.
    this.grid.revive(recipe.collider);
  }

  /** Every converted building back to a recipe, for a fresh mission. */
  reset() {
    for (const recipe of this.ruins.slice()) this._clear(recipe);
    this.ruins.length = 0;
  }

  get stats() {
    return {
      converted: this.ruins.length,
      blocks: this.ruins.reduce((a, r) => a + (r.building?.modules.length ?? 0), 0),
    };
  }
}
