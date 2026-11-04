import { describe, expect, it } from 'vitest';
import { cameraErrorMessage, trackingErrorMessage } from './cameraErrors';

describe('cameraErrorMessage', () => {
  it('says the permission was refused and offers the mouse', () => {
    const message = cameraErrorMessage(new DOMException('Permission denied', 'NotAllowedError'));
    expect(message).toBe('Permiso rechazado. Habilitá la cámara en el navegador o probá con el mouse.');
  });

  it('says there is no camera and offers the mouse and the demo', () => {
    const message = cameraErrorMessage(new DOMException('Requested device not found', 'NotFoundError'));
    expect(message).toContain('No se encontró una cámara');
    expect(message).toContain('mouse');
    expect(message).toContain('demo');
  });

  it('says the camera is busy', () => {
    const message = cameraErrorMessage(new DOMException('Could not start video source', 'NotReadableError'));
    expect(message).toBe('La cámara está ocupada o no responde. Cerrá otras apps e intentá de nuevo.');
  });

  it('matches by name, so a look-alike object from another realm works too', () => {
    expect(cameraErrorMessage({ name: 'NotAllowedError', message: 'x' })).toContain('Permiso rechazado');
  });

  it('passes other errors through (HTTPS missing, model failures) and never throws on odd input', () => {
    expect(cameraErrorMessage(new Error('Cámara no disponible: se requiere HTTPS y un navegador compatible.'))).toBe('Cámara no disponible: se requiere HTTPS y un navegador compatible.');
    expect(cameraErrorMessage('boom')).toBe('boom');
    expect(cameraErrorMessage(undefined)).toBe('undefined');
    expect(cameraErrorMessage(null)).toBe('null');
    expect(cameraErrorMessage(new Error(''))).toBe('Error');
  });

  it('prefixes tracking failures like Masa does', () => {
    expect(trackingErrorMessage('modelo no disponible')).toBe('Seguimiento: modelo no disponible');
  });

  it('is all Spanish, voseo included (no «tú» imperatives)', () => {
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
      const message = cameraErrorMessage({ name });
      expect(message).not.toMatch(/\b(habilita|prueba|cierra)\b/i);
    }
  });
});
