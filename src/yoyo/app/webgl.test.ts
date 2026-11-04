import { describe, expect, it, vi } from 'vitest';
import { webgl2Available } from './webgl';

/** A document whose canvas answers `getContext` with whatever the test says. */
function docWith(getContext: (kind: string) => unknown): Pick<Document, 'createElement'> {
  return { createElement: vi.fn(() => ({ getContext })) } as unknown as Pick<Document, 'createElement'>;
}

describe('webgl2Available', () => {
  it('is true when a context exists, and releases the probe context right away', () => {
    const loseContext = vi.fn();
    const getContext = vi.fn(() => ({ getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)) }));
    expect(webgl2Available(docWith(getContext))).toBe(true);
    expect(getContext).toHaveBeenCalledWith('webgl2');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('asks for WebGL2 only: a WebGL1 context is no use to the renderer', () => {
    const getContext = vi.fn(() => null);
    expect(webgl2Available(docWith(getContext))).toBe(false);
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith('webgl2');
  });

  it('is true even when the context has no lose-context extension', () => {
    expect(webgl2Available(docWith(() => ({ getExtension: () => null })))).toBe(true);
  });

  it('is false when asking throws', () => {
    expect(webgl2Available(docWith(() => { throw new Error('GPU process crashed'); }))).toBe(false);
  });
});
