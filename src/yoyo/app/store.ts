/**
 * Minimal observable state for `useSyncExternalStore`: the engine owns the truth and runs at 60 Hz, the UI
 * only hears about discrete changes (PRD §7: no React state per frame).
 *
 * The state object is replaced, never mutated, and only when a field actually changed, so a component
 * that reads it can rely on reference equality; `getState` and `subscribe` are arrow properties so they
 * can be handed to React as they are.
 */
export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  readonly getState = (): T => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Merges `changes` into the state. Fields are compared with `Object.is`: objects count as changed
   * when they are a different object, so callers pass a new one only when something inside changed.
   * Listeners run once, synchronously, after the state is in place; nothing runs when nothing changed.
   * Returns whether it changed.
   */
  patch(changes: Partial<T>): boolean {
    let changed = false;
    for (const key of Object.keys(changes) as Array<keyof T>) {
      if (!Object.is(this.state[key], changes[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    this.state = { ...this.state, ...changes };
    // A listener may unsubscribe while we notify: iterate a copy.
    for (const listener of [...this.listeners]) listener();
    return true;
  }
}
