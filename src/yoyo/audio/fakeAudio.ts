/**
 * Recording stand-ins for the parts of Web Audio the voices use, so graph wiring and lifecycle can
 * be unit-tested in Node. They are strict where the real thing is strict (an exponential ramp to 0,
 * a negative time, a non-finite value, stopping a source that never started all throw), so a test
 * that passes here is not hiding a RangeError that Chrome would raise.
 *
 * Test support only: nothing in the app imports this file.
 */

export interface ParamCall {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime' | 'setTargetAtTime' | 'cancelScheduledValues';
  args: number[];
}

export class FakeParam {
  readonly calls: ParamCall[] = [];

  constructor(public value = 0) {}

  setValueAtTime(value: number, time: number): this {
    return this.record('setValueAtTime', [value, time]);
  }

  linearRampToValueAtTime(value: number, time: number): this {
    return this.record('linearRampToValueAtTime', [value, time]);
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value === 0) throw new RangeError('exponentialRampToValueAtTime: the target value must not be 0');
    return this.record('exponentialRampToValueAtTime', [value, time]);
  }

  setTargetAtTime(target: number, time: number, timeConstant: number): this {
    if (timeConstant < 0) throw new RangeError('setTargetAtTime: negative time constant');
    return this.record('setTargetAtTime', [target, time, timeConstant]);
  }

  cancelScheduledValues(time: number): this {
    return this.record('cancelScheduledValues', [time]);
  }

  callsTo(method: ParamCall['method']): ParamCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private record(method: ParamCall['method'], args: number[]): this {
    for (const arg of args) {
      if (!Number.isFinite(arg)) throw new TypeError(`${method}: non-finite argument`);
    }
    if (method !== 'setTargetAtTime' && args.length >= 2 && args[1] < 0) throw new RangeError(`${method}: negative time`);
    this.calls.push({ method, args });
    return this;
  }
}

export class FakeNode {
  readonly outputs: Array<FakeNode | FakeParam> = [];
  disconnected = false;

  constructor(readonly kind: string) {}

  connect<T extends FakeNode | FakeParam>(target: T): T {
    this.outputs.push(target);
    return target;
  }

  disconnect(): void {
    this.outputs.length = 0;
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);

  constructor() {
    super('gain');
  }
}

export class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);

  constructor() {
    super('biquad');
  }
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);

  constructor() {
    super('compressor');
  }
}

export class FakeSource extends FakeNode {
  startedAt: number | null = null;
  startOffset: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;

  start(when = 0, offset = 0): void {
    if (this.startedAt !== null) throw new Error('InvalidStateError: start() called twice');
    if (when < 0 || offset < 0) throw new RangeError('start: negative argument');
    this.startedAt = when;
    this.startOffset = offset;
  }

  stop(when = 0): void {
    if (this.startedAt === null) throw new Error('InvalidStateError: stop() before start()');
    this.stoppedAt = when;
  }

  /** Test helper: playback ended, as the browser would report after stop time. */
  end(): void {
    this.onended?.();
  }
}

export class FakeOscillator extends FakeSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam(440);

  constructor() {
    super('oscillator');
  }
}

export class FakeBuffer {
  readonly data: Float32Array;

  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = new Float32Array(length);
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  copyToChannel(source: Float32Array): void {
    this.data.set(source);
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;

  constructor() {
    super('buffer-source');
  }
}

type ContextState = 'suspended' | 'running' | 'closed';

/** A BaseAudioContext/AudioContext stand-in. `nodes` lists everything it created, in order. */
export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  state: ContextState;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  /** Method names that should throw, to rehearse a broken Web Audio. */
  readonly throwOn = new Set<string>();
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  /** Whether resume() really starts the context; false rehearses a blocked autoplay policy. */
  allowResume = true;

  constructor(initialState: ContextState = 'running') {
    this.state = initialState;
  }

  createGain(): FakeGain {
    return this.make('createGain', new FakeGain());
  }

  createOscillator(): FakeOscillator {
    return this.make('createOscillator', new FakeOscillator());
  }

  createBiquadFilter(): FakeFilter {
    return this.make('createBiquadFilter', new FakeFilter());
  }

  createDynamicsCompressor(): FakeCompressor {
    return this.make('createDynamicsCompressor', new FakeCompressor());
  }

  createBufferSource(): FakeBufferSource {
    return this.make('createBufferSource', new FakeBufferSource());
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    this.maybeThrow('createBuffer');
    return new FakeBuffer(channels, length, sampleRate);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.allowResume && this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    if (this.state === 'running') this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: already closed'));
    this.state = 'closed';
    return Promise.resolve();
  }

  /** Every created node of a kind. */
  ofKind<T extends FakeNode>(kind: string): T[] {
    return this.nodes.filter((node) => node.kind === kind) as T[];
  }

  private make<T extends FakeNode>(method: string, node: T): T {
    this.maybeThrow(method);
    this.nodes.push(node);
    return node;
  }

  private maybeThrow(method: string): void {
    if (this.throwOn.has(method)) throw new Error(`${method} failed (rehearsed)`);
  }
}

/** The fake, typed as what the code under test expects. */
export const asBaseContext = (context: FakeAudioContext): BaseAudioContext => context as unknown as BaseAudioContext;
export const asAudioContext = (context: FakeAudioContext): AudioContext => context as unknown as AudioContext;
export const asNode = (node: FakeNode): AudioNode => node as unknown as AudioNode;
