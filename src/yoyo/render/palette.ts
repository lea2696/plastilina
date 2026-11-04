/**
 * Colours of the yoyó scene. The yoyo colours are the user's choice (ephemeral, PRD §1.3); the rest is the
 * dark theme: a deep blue-grey backdrop, a cool translucent hand, a cream string that turns warm under
 * tension, and an amber accent for the tie ring and the flashes.
 */

export interface YoyoColor { name: string; value: string }

/**
 * Selectable body colours (anodised look), first = default. Spanish names for the picker. Chosen to read
 * on the dark backdrop once PBR shading and tone mapping have had their say, and to be easy to tell apart.
 */
export const YOYO_COLORS: ReadonlyArray<YoyoColor> = [
  { name: 'Rojo', value: '#e5383b' },
  { name: 'Naranja', value: '#ff8a1c' },
  { name: 'Amarillo', value: '#f2c230' },
  { name: 'Verde', value: '#2fbf71' },
  { name: 'Turquesa', value: '#19b4c8' },
  { name: 'Azul', value: '#3b7bff' },
  { name: 'Violeta', value: '#9061f9' },
];

export const DEFAULT_YOYO_COLOR = YOYO_COLORS[0].value;

/** Display-referred sRGB triples (0..1) for the shaders that write straight to the canvas. */
export const SCENE = {
  /** Backdrop: wall darkens toward the top; the glow sits behind the play area. */
  wallTop: [0.055, 0.075, 0.1],
  wallBottom: [0.105, 0.135, 0.175],
  glow: [0.035, 0.05, 0.065],
  floorNear: [0.145, 0.18, 0.225],
  floorFar: [0.07, 0.09, 0.115],
  floorLine: [0.45, 0.55, 0.68],
  /** Hand silhouette: cool, translucent; warms on a flash or at the frame edge. */
  handTint: [0.62, 0.78, 0.94],
  handBright: [1.0, 0.93, 0.78],
  handWarm: [1.0, 0.68, 0.25],
  /** Guide outline. */
  guide: [0.72, 0.86, 1.0],
} as const;

/** String: cream when relaxed, amber under tension (hex strings, converted by three to linear). */
export const STRING_NEUTRAL = '#ece4d2';
export const STRING_WARM = '#ffa957';
/** Tie ring on the middle finger and the mouse grip marker. */
export const RING_COLOR = '#ffb454';
/** Bare polished metal used for the hub, edge and blades (sRGB, slightly cool aluminium). */
export const POLISH_COLOR = '#dfe3ea';
