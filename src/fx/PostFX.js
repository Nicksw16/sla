import * as THREE from 'three';

/**
 * Post-processing (spec §118-120).
 *
 * Written by hand rather than assembled from EffectComposer passes, because the cost
 * here is measured in full-screen fills and a stock composer spends several of them on
 * copies this pipeline does not need. The chain is:
 *
 *   scene  -> HDR target (float, so a lit window can be brighter than white)
 *          -> bright pass at quarter resolution
 *          -> separable blur, twice, still at quarter resolution
 *          -> one final full-screen pass: add the bloom, expose, grade, tone map,
 *             vignette, and write sRGB.
 *
 * Two full-resolution passes in total, three cheap ones. Everything a frame needs
 * happens in the final shader so there is no second full-screen blit to pay for.
 *
 * Tone mapping moves here from the renderer: mapping into the HDR buffer first would
 * clamp exactly the highlights the bloom is meant to find.
 */

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Soft knee: highlights ramp into the bloom instead of switching on at a hard
    // threshold, which is what makes a light source pulse as the camera moves.
    float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float contribution = max(soft, lum - uThreshold) / max(lum, 1e-4);
    gl_FragColor = vec4(c * contribution, 1.0);
  }`;

const BLUR_FRAG = `
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;   // texel-sized step, horizontal or vertical
  varying vec2 vUv;
  void main() {
    // Nine taps on a Gaussian, folded to five samples with linear filtering.
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
    vec2 o1 = uDirection * 1.3846153846;
    vec2 o2 = uDirection * 3.2307692308;
    sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
    sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }`;

const FINAL_FRAG = `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform float uExposure;
  uniform float uVignette;
  uniform vec3 uLift;     // pushed into the shadows
  uniform vec3 uGain;     // multiplied into the highlights
  uniform float uSaturation;
  varying vec2 vUv;

  // ACES, the filmic curve three uses, kept here so tone mapping happens after the
  // bloom has been added rather than before it.
  vec3 aces(vec3 x) {
    const mat3 IN = mat3(0.59719, 0.07600, 0.02840,
                         0.35458, 0.90834, 0.13383,
                         0.04823, 0.01566, 0.83777);
    const mat3 OUT = mat3( 1.60475, -0.10208, -0.00327,
                          -0.53108,  1.10813, -0.07276,
                          -0.07367, -0.00605,  1.07602);
    // The 0.6 is three's own normalisation. Without it this curve sits two thirds of
    // a stop brighter than the renderer's, and the whole game washes out the moment
    // post-processing is switched on.
    vec3 v = IN * (x / 0.6);
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return clamp(OUT * (a / b), 0.0, 1.0);
  }

  void main() {
    vec3 hdr = texture2D(tScene, vUv).rgb;
    hdr += texture2D(tBloom, vUv).rgb * uBloom;
    hdr *= uExposure;

    // Grade in linear light: lift the shadows toward the night sky, gain the
    // highlights toward the sun of the hour.
    hdr = hdr * uGain + uLift * (1.0 - smoothstep(0.0, 0.35, hdr));
    float lum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
    hdr = mix(vec3(lum), hdr, uSaturation);

    vec3 mapped = aces(max(hdr, 0.0));

    // A vignette this gentle is not visible as an effect, only as depth.
    vec2 d = vUv - 0.5;
    mapped *= 1.0 - uVignette * dot(d, d);

    gl_FragColor = vec4(pow(mapped, vec3(0.4545454545)), 1.0);
  }`;

function fullScreenQuad(material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geo };
}

export class PostFX {
  constructor({ renderer, settings }) {
    this.renderer = renderer;
    this.settings = settings;
    this.enabled = false;
    this.width = 1;
    this.height = 1;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const targetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    };
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    this.brightTarget = new THREE.WebGLRenderTarget(1, 1, { ...targetOptions, depthBuffer: false });
    this.blurTarget = new THREE.WebGLRenderTarget(1, 1, { ...targetOptions, depthBuffer: false });

    this.brightMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv;\n${VERT}`,
      fragmentShader: `precision highp float;\n${BRIGHT_FRAG}`,
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 0.82 },
        uKnee: { value: 0.42 },
      },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv;\n${VERT}`,
      fragmentShader: `precision highp float;\n${BLUR_FRAG}`,
      uniforms: { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });
    this.finalMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv;\n${VERT}`,
      fragmentShader: `precision highp float;\n${FINAL_FRAG}`,
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        tBloom: { value: this.blurTarget.texture },
        uBloom: { value: 0.55 },
        uExposure: { value: 1.05 },
        uVignette: { value: 0.34 },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uSaturation: { value: 1.06 },
      },
      depthTest: false, depthWrite: false,
    });

    this.quad = fullScreenQuad(this.brightMat);
  }

  /**
   * Enabling moves tone mapping out of the renderer: the scene has to reach the
   * bright pass unmapped or every highlight is already clamped to white.
   */
  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }

  setSize(width, height) {
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneTarget.setSize(w, h);
    // Bloom lives at a quarter of the frame in each axis: sixteen times fewer pixels
    // for a blur nobody can tell is low resolution.
    this.brightTarget.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.blurTarget.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
  }

  /** Exposure, grade and bloom strength for the hour and the weather. */
  setGrade({ exposure = 1.05, bloom = 0.55, lift, gain, saturation = 1.06, vignette = 0.34 }) {
    const u = this.finalMat.uniforms;
    u.uExposure.value = exposure;
    u.uBloom.value = bloom;
    u.uSaturation.value = saturation;
    u.uVignette.value = vignette;
    if (lift) u.uLift.value.set(lift.r, lift.g, lift.b);
    if (gain) u.uGain.value.set(gain.r, gain.g, gain.b);
  }

  _blit(material, target) {
    this.quad.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad.scene, this.camera);
  }

  /** Replaces renderer.render for the world; returns false if it did nothing. */
  render(scene, camera) {
    if (!this.enabled) return false;
    const renderer = this.renderer;

    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);

    this.brightMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this._blit(this.brightMat, this.brightTarget);

    const bw = this.brightTarget.width;
    const bh = this.brightTarget.height;
    this.blurMat.uniforms.tDiffuse.value = this.brightTarget.texture;
    this.blurMat.uniforms.uDirection.value.set(1 / bw, 0);
    this._blit(this.blurMat, this.blurTarget);

    this.blurMat.uniforms.tDiffuse.value = this.blurTarget.texture;
    this.blurMat.uniforms.uDirection.value.set(0, 1 / bh);
    this._blit(this.blurMat, this.brightTarget);

    this.finalMat.uniforms.tScene.value = this.sceneTarget.texture;
    this.finalMat.uniforms.tBloom.value = this.brightTarget.texture;
    this._blit(this.finalMat, null);
    return true;
  }

  dispose() {
    this.sceneTarget.dispose();
    this.brightTarget.dispose();
    this.blurTarget.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.finalMat.dispose();
    this.quad.geo.dispose();
  }
}
