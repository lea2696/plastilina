import { describe, expect, it, vi } from 'vitest';
import { Store } from './store';

interface S { a: number; b: string; c: { n: number } }
const initial = (): S => ({ a: 1, b: 'x', c: { n: 0 } });

describe('Store', () => {
  it('holds the initial state', () => {
    const s = new Store(initial());
    expect(s.getState()).toEqual(initial());
  });

  it('replaces the state object when something changed and tells every listener once', () => {
    const s = new Store(initial());
    const first = vi.fn();
    const second = vi.fn();
    s.subscribe(first);
    s.subscribe(second);
    const before = s.getState();
    expect(s.patch({ a: 2, b: 'y' })).toBe(true);
    expect(s.getState()).not.toBe(before);
    expect(s.getState()).toMatchObject({ a: 2, b: 'y' });
    // The old object is untouched: React compares references.
    expect(before.a).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nothing changed, so reading components are not re-rendered', () => {
    const s = new Store(initial());
    const listener = vi.fn();
    s.subscribe(listener);
    const before = s.getState();
    expect(s.patch({ a: 1, b: 'x' })).toBe(false);
    expect(s.patch({})).toBe(false);
    expect(s.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('compares objects by reference', () => {
    const s = new Store(initial());
    const same = s.getState().c;
    expect(s.patch({ c: same })).toBe(false);
    expect(s.patch({ c: { n: 0 } })).toBe(true);
  });

  it('shows the new state to the listeners that run', () => {
    const s = new Store(initial());
    let seen = 0;
    s.subscribe(() => { seen = s.getState().a; });
    s.patch({ a: 9 });
    expect(seen).toBe(9);
  });

  it('stops telling a listener that unsubscribed, even from inside a notification', () => {
    const s = new Store(initial());
    const late = vi.fn();
    let unsubscribeLate = () => {};
    s.subscribe(() => unsubscribeLate());
    unsubscribeLate = s.subscribe(late);
    s.patch({ a: 2 });
    s.patch({ a: 3 });
    expect(late.mock.calls.length).toBeLessThanOrEqual(1);
    const gone = vi.fn();
    const off = s.subscribe(gone);
    off();
    s.patch({ a: 4 });
    expect(gone).not.toHaveBeenCalled();
  });

  it('exposes getState and subscribe as stand-alone functions', () => {
    const s = new Store(initial());
    const { getState, subscribe } = s;
    const listener = vi.fn();
    subscribe(listener);
    s.patch({ a: 5 });
    expect(getState().a).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
