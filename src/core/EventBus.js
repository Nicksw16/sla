/**
 * Minimal pub/sub. Systems talk through this instead of holding references to
 * each other, which is what keeps FlightModel, MissionManager, AudioManager and
 * the HUD independently testable (spec §90-91: no god script).
 */
export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy first: handlers are allowed to subscribe/unsubscribe while dispatching.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}
