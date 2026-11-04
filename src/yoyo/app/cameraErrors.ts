/**
 * Messages for what can go wrong when the camera starts, in the same words Masa uses (MasaEngine.cameraMessage)
 * so the two apps speak with one voice. Matching goes by `error.name`, not `instanceof DOMException`: the
 * name is the contract of getUserMedia, and it holds across realms and test doubles.
 */
export function cameraErrorMessage(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError') return 'Permiso rechazado. Habilitá la cámara en el navegador o probá con el mouse.';
  if (name === 'NotFoundError') return 'No se encontró una cámara. Podés probar con el mouse o mirar la demo.';
  if (name === 'NotReadableError') return 'La cámara está ocupada o no responde. Cerrá otras apps e intentá de nuevo.';
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** The hand-tracking model or its worker failed after the camera was already running. */
export function trackingErrorMessage(message: string): string {
  return `Seguimiento: ${message}`;
}

/** WebGL2 is missing (Masa's wording, which the unsupported screen has always used). */
export const WEBGL_UNAVAILABLE_MESSAGE = 'Este navegador no ofrece WebGL. Probá Chrome actualizado en una computadora con gráficos disponibles.';
/** The renderer could not be built even though a context exists. */
export const GRAPHICS_FAILED_MESSAGE = 'No se pudo iniciar la escena gráfica. Probá otro navegador o dispositivo.';
/** The GPU context was lost while the page was open. */
export const GRAPHICS_LOST_MESSAGE = 'Se perdió el dispositivo gráfico. Recargá la página.';
/** The render loop threw: nothing else to do but start over. */
export const UNEXPECTED_MESSAGE = 'Algo salió mal. Recargá la página para volver a empezar.';
