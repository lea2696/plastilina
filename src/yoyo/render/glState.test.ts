import { describe, expect, it } from 'vitest';
import { resetContextState } from './glState';

/**
 * A stand-in context: upper-case names are distinct numeric constants, everything else is a function that
 * records its call. Enough to check WHAT is reset without a GPU.
 */
function recordingContext(): { gl: WebGL2RenderingContext; calls: Array<[string, unknown[]]>; constant: (name: string) => number } {
  const calls: Array<[string, unknown[]]> = [];
  const constants = new Map<string, number>();
  const constant = (name: string) => {
    if (!constants.has(name)) constants.set(name, 0x1000 + constants.size * 7);
    return constants.get(name)!;
  };
  const gl = new Proxy({}, {
    get(_target, name: string) {
      if (name === 'drawingBufferWidth') return 640;
      if (name === 'drawingBufferHeight') return 400;
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) return constant(name);
      return (...args: unknown[]) => {
        calls.push([name, args]);
        return name === 'getParameter' ? 16 : undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls, constant };
}

describe('resetContextState', () => {
  it('turns the pixel-store flags that break the next three.js renderer back off', () => {
    const { gl, calls, constant } = recordingContext();
    resetContextState(gl);
    const store = calls.filter(([name]) => name === 'pixelStorei');
    const find = (parameter: string) => store.find(([, args]) => args[0] === constant(parameter));
    expect(find('UNPACK_FLIP_Y_WEBGL')?.[1][1]).toBe(false);
    expect(find('UNPACK_PREMULTIPLY_ALPHA_WEBGL')?.[1][1]).toBe(false);
    expect(find('UNPACK_COLORSPACE_CONVERSION_WEBGL')?.[1][1]).toBe(constant('BROWSER_DEFAULT_WEBGL'));
    expect(find('UNPACK_ALIGNMENT')?.[1][1]).toBe(4);
  });

  it('unbinds buffers, framebuffers, vertex arrays, programs and every texture target on every unit', () => {
    const { gl, calls, constant } = recordingContext();
    resetContextState(gl);
    const bound = (fn: string, target?: string) => calls.filter(([name, args]) => name === fn && (target === undefined || args[0] === constant(target)) && args[args.length - 1] === null);
    expect(bound('bindVertexArray')).toHaveLength(1);
    expect(bound('bindBuffer', 'ARRAY_BUFFER')).toHaveLength(1);
    expect(bound('bindBuffer', 'ELEMENT_ARRAY_BUFFER')).toHaveLength(1);
    expect(bound('bindFramebuffer', 'FRAMEBUFFER')).toHaveLength(1);
    expect(bound('useProgram')).toHaveLength(1);
    // The fake reports 16 units: each gets all four texture targets cleared.
    for (const target of ['TEXTURE_2D', 'TEXTURE_CUBE_MAP', 'TEXTURE_3D', 'TEXTURE_2D_ARRAY']) {
      expect(bound('bindTexture', target)).toHaveLength(16);
    }
    // And the active unit is left at 0.
    const active = calls.filter(([name]) => name === 'activeTexture');
    expect(active[active.length - 1][1][0]).toBe(constant('TEXTURE0'));
  });

  it('disables every capability three switches on and restores the default depth, blend and viewport state', () => {
    const { gl, calls, constant } = recordingContext();
    resetContextState(gl);
    const disabled = new Set(calls.filter(([name]) => name === 'disable').map(([, args]) => args[0]));
    for (const capability of ['BLEND', 'CULL_FACE', 'DEPTH_TEST', 'POLYGON_OFFSET_FILL', 'SCISSOR_TEST', 'STENCIL_TEST']) {
      expect(disabled.has(constant(capability))).toBe(true);
    }
    const last = (fn: string) => calls.filter(([name]) => name === fn).pop()?.[1];
    expect(last('depthFunc')).toEqual([constant('LESS')]);
    expect(last('depthMask')).toEqual([true]);
    expect(last('colorMask')).toEqual([true, true, true, true]);
    expect(last('blendEquation')).toEqual([constant('FUNC_ADD')]);
    expect(last('blendFuncSeparate')).toEqual([constant('ONE'), constant('ZERO'), constant('ONE'), constant('ZERO')]);
    expect(last('viewport')).toEqual([0, 0, 640, 400]);
    expect(last('scissor')).toEqual([0, 0, 640, 400]);
  });

  it('never creates, deletes or draws anything: it only resets', () => {
    const { gl, calls } = recordingContext();
    resetContextState(gl);
    for (const [name] of calls) expect(name).not.toMatch(/^(create|delete|draw|clear$|texImage|bufferData|compile|link)/);
  });
});
