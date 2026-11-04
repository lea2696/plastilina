/** Monotonic time in milliseconds; world coordinates in metres, y=0 table. */
export type Vec3 = readonly [number, number, number];
export interface Landmark { x: number; y: number; z: number }
/** Original model landmarks: normalized image coordinates; no per-landmark confidence. */
export interface HandDetection { landmarks: readonly Landmark[]; handedness: 'Left'|'Right'|'Unknown'; handednessScore?: number }
export interface HandFrame { timestampMs: number; source: 'camera'|'replay'; hands: readonly HandDetection[] }
export type HandBasis = readonly [Vec3, Vec3, Vec3];
/** proximity: 0 far from the clay, 1 touching its surface; a depth cue for the renderer. */
export interface MappedHand { id: string; timestampMs: number; points: readonly Vec3[]; velocities?: readonly Vec3[]; contactPoints?: readonly number[]; proximity?: number; handedness: HandDetection['handedness']; state: 'free'|'contact'|'grasp'|'releasing'|'lost' }
/** Grasp colliders describe material anchors, not solid spheres. basis is an orthonormal world frame. */
/** handId/landmarks say which hand points light up when the solver reports this collider in contact. */
export interface HandCollider { id: string; kind: 'tip'|'segment'|'palm'; center: Vec3; end?: Vec3; radius: number; velocity: Vec3; grasp?: boolean; basis?: HandBasis; gripStrength?: number; handId?: string; landmarks?: readonly number[] }
export interface InteractionFrame { timestampMs: number; colliders: readonly HandCollider[]; hands: readonly MappedHand[] }
export interface SimulationStep { timestampMs: number; dt: number; input: InteractionFrame }
/** Borrowed typed buffers. Reader must copy before next physics step. */
export interface SurfaceState { positions: Float32Array; indices: Uint32Array; normals?: Float32Array; version: number }
export interface ContactAudioEvent { timestampMs: number; kind: 'press'|'stretch'|'knead'|'land'|'intro'; intensity: number }
