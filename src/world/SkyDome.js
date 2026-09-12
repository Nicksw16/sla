import * as THREE from 'three';

/**
 * Sky dome, sun, stars and a cloud layer, all in one shader on one inverted sphere.
 *
 * Everything the sky needs to do here is a function of view direction, so a single
 * dome is both the cheapest and the most controllable option: the lighting rig sets
 * a handful of uniforms and the horizon, the sun halo, the star field and the cloud
 * cover all follow together instead of drifting out of agreement.
 */
export function createSkyDome() {
  const geo = new THREE.SphereGeometry(1, 32, 20);

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.5).normalize() },
    uZenith: { value: new THREE.Color(0x2f6fb5) },
    uHorizon: { value: new THREE.Color(0xbcd7ea) },
    uGroundHaze: { value: new THREE.Color(0x9fb0bd) },
    uSunColor: { value: new THREE.Color(0xfff2d0) },
    uSunSize: { value: 1 },
    uStars: { value: 0 },
    uCloudCover: { value: 0.15 },
    uCloudTint: { value: new THREE.Color(0xffffff) },
    uTime: { value: 0 },
    uFlash: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // Keep the dome pinned around the camera regardless of where it flies.
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p;
      }`,
    fragmentShader: `
      uniform vec3 uSunDir, uZenith, uHorizon, uGroundHaze, uSunColor, uCloudTint;
      uniform float uSunSize, uStars, uCloudCover, uTime, uFlash;
      varying vec3 vDir;

      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += noise(p) * a; p *= 2.03; a *= 0.5; }
        return v;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float up = clamp(dir.y, -1.0, 1.0);

        // Base gradient: haze below the horizon, zenith above.
        vec3 col = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.55));
        col = mix(col, uGroundHaze, smoothstep(0.02, -0.22, up));

        // Sun: a disc, a tight halo, and a broad forward-scatter glow that is what
        // actually makes a low sun feel like a low sun.
        float sd = max(dot(dir, normalize(uSunDir)), 0.0);
        float disc = smoothstep(0.9993, 0.99975, sd) * uSunSize;
        float halo = pow(sd, 220.0) * 0.55 + pow(sd, 28.0) * 0.22;
        float scatter = pow(sd, 4.0) * 0.16;
        col += uSunColor * (disc * 8.0 + halo + scatter);

        // Stars, only once the sky is dark enough to hide the gradient.
        if (uStars > 0.001) {
          vec2 sp = dir.xz / max(abs(dir.y) + 0.22, 0.06) * 42.0;
          float s = hash(floor(sp));
          float star = smoothstep(0.9955, 0.9995, s) * clamp(up * 3.0, 0.0, 1.0);
          float twinkle = 0.7 + 0.3 * sin(uTime * 2.7 + s * 90.0);
          col += vec3(0.85, 0.9, 1.0) * star * twinkle * uStars * 3.0;
        }

        // Cloud layer, projected onto the dome and drifting with the wind.
        if (uCloudCover > 0.01 && up > -0.05) {
          vec2 cp = dir.xz / max(up + 0.16, 0.05) * 1.35;
          float n = fbm(cp * 0.55 + vec2(uTime * 0.012, uTime * 0.006));
          n += fbm(cp * 1.6 - vec2(uTime * 0.02, 0.0)) * 0.35;
          float threshold = 1.0 - uCloudCover;
          float cloud = smoothstep(threshold * 0.95, threshold * 0.95 + 0.26, n);
          cloud *= smoothstep(-0.02, 0.16, up);
          // Clouds lit from the sun side, shaded away from it.
          float lit = 0.55 + 0.45 * clamp(dot(normalize(uSunDir), dir), 0.0, 1.0);
          vec3 cloudCol = uCloudTint * lit;
          col = mix(col, cloudCol, cloud * 0.93);
        }

        col += vec3(0.55, 0.6, 0.75) * uFlash;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.scale.setScalar(1);
  mesh.userData.uniforms = uniforms;
  mesh.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return mesh;
}

/** The dome rides with the camera, so it never gets closer or further away. */
export function updateSkyDome(mesh, camera, dt) {
  mesh.position.copy(camera.position);
  const scale = camera.far * 0.9;
  mesh.scale.setScalar(scale);
  mesh.userData.uniforms.uTime.value += dt;
}
