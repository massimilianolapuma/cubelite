/**
 * Test helper: install an in-memory `window.localStorage`.
 * Needed because Node ≥22 defines an experimental `localStorage` global that
 * shadows jsdom's and resolves to `undefined` without --localstorage-file.
 */

export function installLocalStorageMock(): Storage {
  const map = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
  };
  Object.defineProperty(window, "localStorage", {
    value: mock,
    configurable: true,
  });
  return mock;
}
