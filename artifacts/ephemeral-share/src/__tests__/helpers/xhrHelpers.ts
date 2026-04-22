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
