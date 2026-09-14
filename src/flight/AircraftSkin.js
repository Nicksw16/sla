import * as THREE from 'three';

/**
 * Procedural aircraft skin.
 *
 * The models were losing their realism at the paint, not at the geometry: a
 * MeshStandardMaterial in one flat colour reads as injection-moulded plastic no
 * matter how good the shape underneath it is. Real airframes are assembled from
 * panels, and the lines between those panels - plus the rivet rows that follow them,
 * and the dirt that collects in them - are what the eye uses to judge scale. A
 * fuselage with panel lines reads as twelve metres of aluminium; the same fuselage
 * without them could be twelve metres or twelve centimetres.
 *
 * All of it is computed from object-space position in the fragment shader, so it
 * costs no triangles, no textures and no UVs, and it scales itself correctly
 * whatever size the part is.
 */

export const SKIN = {
  BODY: 0,    // frames across the body, stringers running fore and aft
  WING: 1,    // ribs across the span, spars along the chord
  NACELLE: 2, // tight rings, the way a cowl is built
};

/**
 * Patches a MeshStandardMaterial to draw panel lines, rivets and wear.
 *
 * @param {THREE.Material} material
 * @param {object} opts
 *   mode      which panel layout to use (see SKIN)
 *   spacing   panel pitch in metres
 *   seed      decorrelates the wear between parts
 *   stripe    optional { colour, centre, height } cheatline, body mode only
 */
export function applyPanelLines(material, {
  mode = SKIN.BODY, spacing = 0.62, seed = 0, stripe = null, wear = 1,
} = {}) {
  const uniforms = {
    uSkinMode: { value: mode },
    uPanel: { value: spacing },
    uSeed: { value: seed },
    uWear: { value: wear },
    uStripe: { value: stripe ? new THREE.Color(stripe.colour) : new THREE.Color(0x000000) },
    uStripeBand: { value: new THREE.Vector2(stripe ? stripe.centre : 0, stripe ? stripe.height : -1) },
  };
  material.userData.skin = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSkinPos;
        varying vec3 vSkinNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSkinPos = position;
        vSkinNormal = normal;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSkinMode;
        uniform float uPanel;
        uniform float uSeed;
        uniform float uWear;
        uniform vec3 uStripe;
        uniform vec2 uStripeBand;
        varying vec3 vSkinPos;
        varying vec3 vSkinNormal;

        float skinHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        // Distance in metres from this fragment to the nearest line of a grid of the
        // given pitch, turned into a soft 0..1 mask. The width is driven by fwidth so
        // a panel line stays about a pixel wide however far away the aircraft is,
        // and fades out entirely once the whole grid is sub-pixel - otherwise the
        // lines alias into a crawling moire the moment the player pulls away.
        float skinLine(float v, float pitch, float weight) {
          float n = v / pitch;
          float d = abs(n - floor(n + 0.5)) * pitch;
          float px = fwidth(v);
          float w = max(weight, px * 0.8);
          float mask = 1.0 - smoothstep(w * 0.45, w * 1.05, d);
          // Fade as the pitch approaches a pixel.
          return mask * (1.0 - smoothstep(pitch * 0.22, pitch * 0.6, px));
        }`)

      // Panel lines have to reach roughness as well as colour: a lap joint is a
      // groove that holds dirt, so it is both darker and less glossy than the panel
      // around it. Colour-only lines read as a decal printed on a smooth shell.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        vec3 sp = vSkinPos;
        vec3 san = abs(normalize(vSkinNormal));
        float panelPitch = uPanel;
        float skinSeam = 0.0;
        float skinRivets = 0.0;
        float skinPanelId = 0.0;

        if (uSkinMode < 0.5) {
          // Body: frames at right angles to the spine, plus a few longitudinal lap
          // joints running the length of it. The joints are placed by angle around
          // the body, which is how a fuselage is actually skinned.
          float frames = skinLine(sp.z, panelPitch, 0.012);
          float ang = atan(sp.y, sp.x);
          float stringers = skinLine(ang, 3.14159 / 3.0, 0.03) * (1.0 - san.z);
          skinSeam = max(frames, stringers * 0.8);
          skinPanelId = floor(sp.z / panelPitch) + floor(ang / (3.14159 / 3.0)) * 7.0;
          skinRivets = frames * step(0.55, fract(ang * 9.0 / 3.14159));
        } else if (uSkinMode < 1.5) {
          // Wing: ribs across the span and spars along the chord. The leading edge
          // gets its own seam, because on a real wing it is a separate bonded part.
          float ribs = skinLine(sp.x, panelPitch, 0.010);
          float spars = skinLine(sp.z, panelPitch * 1.35, 0.010);
          skinSeam = max(ribs, spars * 0.85);
          skinPanelId = floor(sp.x / panelPitch) * 3.0 + floor(sp.z / (panelPitch * 1.35));
          skinRivets = ribs * step(0.5, fract(sp.z * 6.0));
        } else {
          // Nacelle: tight circumferential rings, as a cowl is built in bands.
          float rings = skinLine(sp.z, panelPitch * 0.55, 0.012);
          float ang2 = atan(sp.y, sp.x);
          skinSeam = max(rings, skinLine(ang2, 3.14159 / 2.0, 0.035) * 0.7);
          skinPanelId = floor(sp.z / (panelPitch * 0.55));
        }

        // Panel to panel, paint is never quite the same batch. A fraction of a stop
        // between neighbours is the difference between a skin and a shell.
        float panelTone = 0.965 + 0.07 * skinHash(vec2(skinPanelId, uSeed));
        float grime = uWear * 0.5 * skinSeam;

        roughnessFactor = clamp(roughnessFactor * (1.0 + grime * 1.1)
          + skinHash(vec2(skinPanelId * 1.7, uSeed + 3.0)) * 0.03 * uWear, 0.02, 1.0);`)

      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Cheatline: the stripe down the side of the body, measured on the section
        // rather than in world space, so it follows the hull instead of cutting
        // through it. Height is negative when the aircraft carries no stripe.
        if (uSkinMode < 0.5 && uStripeBand.y > 0.0) {
          float band = 1.0 - smoothstep(uStripeBand.y * 0.42, uStripeBand.y * 0.5,
            abs(sp.y - uStripeBand.x));
          // Only on the flanks: a stripe does not run over the spine or the belly.
          band *= smoothstep(0.15, 0.45, 1.0 - san.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, uStripe, band);
        }
        diffuseColor.rgb *= panelTone;
        // The groove itself, plus the dirt that lives in it.
        diffuseColor.rgb *= 1.0 - skinSeam * 0.17 * uWear;
        diffuseColor.rgb *= 1.0 - skinRivets * 0.06 * uWear;`);
  };

  // Materials that compile differently must not share a program.
  material.customProgramCacheKey = () => `skin:${mode}:${spacing.toFixed(3)}:${stripe ? 1 : 0}`;
  return material;
}
