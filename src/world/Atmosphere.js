import * as THREE from 'three';

/**
 * Aerial perspective (spec §62, §119).
 *
 * Three's fog mixes every distant surface toward one colour, which reads as a flat
 * grey curtain. Real haze is lit by the sun: looking into it the air glows warm, and
 * looking away from it the air stays cold. That difference is most of what tells the
 * eye how far away a building is, and it costs one dot product.
 *
 * The patch carries its own view-space varying rather than borrowing vViewPosition,
 * which three only declares for some material configurations, and the sun arrives
 * already in view space because the alternative is reconstructing world position in
 * the fragment shader.
 */
export function createAtmosphere() {
  return {
    uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
    uHazeSun: { value: new THREE.Color(0xffd9a8) },
    uHazeSky: { value: new THREE.Color(0x9dc4e8) },
    uHazeStrength: { value: 0.6 },
  };
}

/** Patches a lit material's fog so it takes the sun into account. */
export function applyAerialPerspective(material, atmosphere) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uSunDirView = atmosphere.uSunDirView;
    shader.uniforms.uHazeSun = atmosphere.uHazeSun;
    shader.uniforms.uHazeSky = atmosphere.uHazeSky;
    shader.uniforms.uHazeStrength = atmosphere.uHazeStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vAerialView;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vAerialView = mvPosition.xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
        uniform vec3 uSunDirView;
        uniform vec3 uHazeSun;
        uniform vec3 uHazeSky;
        uniform float uHazeStrength;
        varying vec3 vAerialView;`)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          vec3 viewDir = normalize(vAerialView);
          // 1 looking straight into the sun, 0 with it behind you.
          float toSun = max(dot(viewDir, uSunDirView), 0.0);
          vec3 haze = mix(uHazeSky, uHazeSun, pow(toSun, 3.0) * uHazeStrength);
          // The authored fog colour still sets the overall key; this only bends it.
          haze = mix(fogColor, haze, 0.55);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, fogFactor);
        #endif`);
  };
  material.customProgramCacheKey = () => 'aerial';
  material.needsUpdate = true;
}
