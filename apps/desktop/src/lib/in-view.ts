/**
 * Calls `onVisible` once, the first time `element` scrolls into view (at
 * once without IntersectionObserver). Returns the cleanup, for `$effect`.
 */
export function observeOnce(element: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      onVisible();
      observer.disconnect();
    }
  });
  observer.observe(element);
  return () => observer.disconnect();
}
