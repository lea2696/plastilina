/**
 * Puts a WebGL2 context back to its initial state.
 *
 * Why: three.js assumes a context it is handed is in the default state (its state cache starts at the
 * defaults and it never reads GL back). `dispose()` on a renderer leaves the context alive, with whatever
 * the last frame left bound and enabled: pixel-store flags, bindings, blend and depth state. A new
 * renderer on the same canvas, which is exactly what React StrictMode does on mount, unmount, mount, then
 * starts from a cache that lies about the context: three logs INVALID_OPERATION for the 3D textures it
 * creates while FLIP_Y is still on, and later draws with the wrong state. Resetting on dispose makes the
 * next renderer's assumption true.
 */

/** Texture units to clear: three binds at most 16 per draw; 32 is the usual hardware limit. */
const TEXTURE_UNITS = 32;

export function resetContextState(gl: WebGL2RenderingContext): void {
  // Pixel store: the flags that make three log warnings when they leak into the next renderer.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

  // Bindings.
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  gl.useProgram(null);
  const reported = Number(gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS));
  const units = Math.min(TEXTURE_UNITS, Number.isFinite(reported) && reported > 0 ? reported : TEXTURE_UNITS);
  for (let unit = 0; unit < units; unit++) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }
  gl.activeTexture(gl.TEXTURE0);

  // Capabilities three may have switched on. (DITHER is on by default and three never touches it.)
  for (const capability of [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SCISSOR_TEST, gl.STENCIL_TEST]) {
    gl.disable(capability);
  }

  // State values, back to the WebGL defaults.
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.colorMask(true, true, true, true);
  gl.frontFace(gl.CCW);
  gl.cullFace(gl.BACK);
  gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);
  gl.blendEquation(gl.FUNC_ADD);
  gl.polygonOffset(0, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clearStencil(0);
  gl.lineWidth(1);
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.scissor(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
}
