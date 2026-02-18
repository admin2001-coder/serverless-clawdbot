// app/workflows/workflowPolyfills.ts
export function ensureWorkflowGlobals() {
  const g: any = globalThis;

  if (typeof g.EventTarget === "undefined") {
    class MiniEventTarget {
      private _listeners = new Map<string, Set<(evt: any) => void>>();

      addEventListener(type: string, cb: (evt: any) => void) {
        if (!cb) return;
        const set = this._listeners.get(type) ?? new Set();
        set.add(cb);
        this._listeners.set(type, set);
      }

      removeEventListener(type: string, cb: (evt: any) => void) {
        this._listeners.get(type)?.delete(cb);
      }

      dispatchEvent(evt: any) {
        const type = evt?.type;
        if (!type) return true;
        const set = this._listeners.get(type);
        if (!set) return true;
        for (const cb of set) cb(evt);
        return true;
      }
    }

    g.EventTarget = MiniEventTarget;
  }

  // Optional, but sometimes libraries expect Event to exist too
  if (typeof (globalThis as any).Event === "undefined") {
    (globalThis as any).Event = class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
  }
}
