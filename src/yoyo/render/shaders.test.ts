import { describe, expect, it } from 'vitest';
import { MAX_BONES } from './handGeometry';
import * as shaders from './shaders';

/**
 * Shaders only compile on a GPU, and the browser fixture (scripts/yoyo-render-shots.ts) is what proves they
 * do: it fails on any console error, and three logs a shader compile error as one. These checks are the
 * cheap part that needs no GPU: the shared loop bound cannot drift from the geometry module, and an edit
 * cannot leave a brace or a parenthesis unbalanced.
 */

const ALL = Object.entries(shaders).filter(([, value]) => typeof value === 'string') as Array<[string, string]>;

/** Counts the characters of `open` and `close` outside comments. */
function balanced(source: string, open: string, close: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  let depth = 0;
  for (const ch of code) {
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('shader sources', () => {
  it('exports the shaders the renderer uses', () => {
    const names = ALL.map(([name]) => name);
    for (const expected of [
      'BACKDROP_VERTEX', 'BACKDROP_FRAGMENT', 'WORLD_QUAD_VERTEX', 'HAND_FRAGMENT', 'GUIDE_FRAGMENT',
      'SPIN_RING_FRAGMENT', 'FLAT_FRAGMENT', 'FACE_VERTEX_DECLARATIONS', 'FACE_VERTEX_BODY',
      'FACE_FRAGMENT_DECLARATIONS', 'FACE_FRAGMENT_BODY',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(ALL)('%s has balanced braces and parentheses', (_name, source) => {
    expect(balanced(source, '{', '}')).toBe(true);
    expect(balanced(source, '(', ')')).toBe(true);
    expect(balanced(source, '[', ']')).toBe(true);
  });

  it.each(ALL.filter(([name]) => name.endsWith('_FRAGMENT') && !name.startsWith('FACE')))('%s writes gl_FragColor', (_name, source) => {
    expect(source).toMatch(/gl_FragColor\s*=/);
  });

  it('the hand and guide shaders loop over exactly the capsule slots the geometry module fills', () => {
    for (const source of [shaders.HAND_FRAGMENT, shaders.GUIDE_FRAGMENT]) {
      expect(source).toContain(`#define NB ${MAX_BONES}`);
      expect(source).toMatch(/uniform vec4 uSeg\[NB\]/);
      expect(source).toMatch(/uniform vec2 uRad\[NB\]/);
    }
  });

  it('the face patch only touches the PBR variables it is allowed to: colour, metalness, roughness', () => {
    // Anything else (normals, emissive, opacity) would change how the body is lit in ways the tests cannot see.
    expect(shaders.FACE_FRAGMENT_BODY).toMatch(/diffuseColor\.rgb\s*=/);
    expect(shaders.FACE_FRAGMENT_BODY).toMatch(/metalnessFactor\s*=/);
    expect(shaders.FACE_FRAGMENT_BODY).toMatch(/roughnessFactor\s*=/);
    expect(shaders.FACE_FRAGMENT_BODY).not.toMatch(/\bnormal\s*=|totalEmissiveRadiance\s*=|diffuseColor\.a\s*=/);
  });

  it('nothing refers to an external resource', () => {
    for (const [, source] of ALL) expect(source).not.toMatch(/https?:|\.png|\.jpg|\.hdr|\.exr|sampler2D/);
  });
});
