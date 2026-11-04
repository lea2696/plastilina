import * as THREE from 'three';
import {
  FACE_FRAGMENT_BODY, FACE_FRAGMENT_DECLARATIONS, FACE_VERTEX_BODY, FACE_VERTEX_DECLARATIONS,
} from './shaders';
import { DEFAULT_YOYO_COLOR, POLISH_COLOR } from './palette';

/** Uniforms the renderer updates every frame. Held by reference: the compiled program reads these objects. */
export interface FaceUniforms {
  /** Spin angle reduced to one turn, rad. */
  uSpinAngle: THREE.IUniform<number>;
  /** Angle the yoyo turns during one frame (ω/60), rad: the width of the temporal smear. */
  uSmear: THREE.IUniform<number>;
  /** 0..1: strength of the concentric brushed streak. */
  uStreak: THREE.IUniform<number>;
  uPolish: THREE.IUniform<THREE.Color>;
}

export interface YoyoMaterial {
  material: THREE.MeshPhysicalMaterial;
  uniforms: FaceUniforms;
}

/**
 * Anodised-metal MeshPhysicalMaterial with a clearcoat, lit by the generated environment, whose finish
 * (colour, metalness, roughness) is overridden per fragment by the face shader. `color` is the anodised
 * colour the user picks; the polished metal is constant.
 *
 * Why patch the built-in material instead of writing a ShaderMaterial: the face keeps the whole PBR
 * pipeline (image-based lighting, clearcoat, tone mapping, colour management) and only decides what the
 * surface is made of at each point.
 */
export function createYoyoMaterial(color: THREE.ColorRepresentation = DEFAULT_YOYO_COLOR): YoyoMaterial {
  const uniforms: FaceUniforms = {
    uSpinAngle: { value: 0 },
    uSmear: { value: 0 },
    uStreak: { value: 0 },
    uPolish: { value: new THREE.Color(POLISH_COLOR) },
  };
  const material = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.9,
    roughness: 0.3,
    clearcoat: 0.3,
    clearcoatRoughness: 0.08,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACE_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FACE_VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACE_FRAGMENT_DECLARATIONS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FACE_FRAGMENT_BODY}`);
  };
  // The patched program must never be shared with a stock MeshPhysicalMaterial.
  material.customProgramCacheKey = () => 'yoyo-face-v1';
  return { material, uniforms };
}
