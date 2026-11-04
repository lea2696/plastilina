/**
 * Whether a WebGL2 context can be created, asked on a throwaway canvas. The renderer needs WebGL2 and logs a
 * stack of console errors when it cannot get one; asking first means a browser without it gets the message on
 * the page («Este navegador no ofrece WebGL...») and a clean console. The probe context is released at once:
 * a page may only hold a few.
 */
export function webgl2Available(doc: Pick<Document, 'createElement'> = document): boolean {
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    if (gl === null) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
