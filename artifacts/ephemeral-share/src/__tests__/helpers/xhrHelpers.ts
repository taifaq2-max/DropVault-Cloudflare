/**
 * Returns a class whose instances never resolve their XHR (so the Uploading
 * phase stays active indefinitely) but correctly fire `onabort` when
 * `.abort()` is called.  Pass the result directly to `vi.stubGlobal`.
 */
export function makeStuckAbortableXHR() {
  return class StuckAbortableXHR {
    status = 0;
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    open(_method: string, _url: string) {}
    setRequestHeader(_key: string, _value: string) {}
    abort() { this.onabort?.(); }
    send(_data: unknown) { /* never resolves */ }
  };
}

/**
 * Queue of HTTP status codes consumed by `MockXHR`.  Each call to
 * `MockXHR#send()` shifts one code off the front; when the queue is empty it
 * falls back to 200 (success).  Use `setXhrResponseQueue` to replace the
 * contents between tests (direct reassignment of imported bindings is not
 * permitted in ES modules).
 */
export const xhrResponseQueue: number[] = [];

/**
 * Replace the contents of `xhrResponseQueue` in-place.  Call this in
 * `beforeEach` or at the start of individual tests instead of reassigning the
 * exported binding.
 */
export function setXhrResponseQueue(codes: number[]): void {
  xhrResponseQueue.splice(0, xhrResponseQueue.length, ...codes);
}

/**
 * A minimal XHR mock whose `send()` method resolves synchronously (via
 * `setTimeout 0`) with the next status code from `xhrResponseQueue`.
 * Pass the class itself to `vi.stubGlobal("XMLHttpRequest", MockXHR)`.
 */
export class MockXHR {
  status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(_method: string, _url: string) {}
  setRequestHeader(_key: string, _value: string) {}

  abort() {
    this.onabort?.();
  }

  send(_data: unknown) {
    const responseStatus =
      xhrResponseQueue.length > 0 ? xhrResponseQueue.shift()! : 200;
    const self = this;
    setTimeout(() => {
      self.status = responseStatus;
      self.onload?.();
    }, 0);
  }
}
