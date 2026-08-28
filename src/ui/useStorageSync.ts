import { useEffect } from 'react'

/**
 * Keep one piece of persisted panel state the same in every Twitch tab.
 *
 * WHY THIS EXISTS
 *
 * The panel already stores its collapsed state and its geometry in
 * localStorage, which is origin-scoped and therefore already shared by every
 * twitch.tv tab. What was missing is that nothing ever LISTENED: the value is
 * read once, in a useState initialiser, so a new tab inherited the last saved
 * state and an already-open tab never changed. Collapsing the panel in one tab
 * and finding it open in the next reads as the extension forgetting.
 *
 * See docs/reports/friends-beta-investigation-2026-08-27.md §4 (#7).
 *
 * WHY THERE IS NO FEEDBACK LOOP
 *
 * The `storage` event does not fire in the tab that performed the write - that
 * is in the specification, not a browser quirk - so applying an incoming value
 * cannot echo back to its origin. The one remaining path, a tab re-persisting
 * a value it has just received, is closed at the writer: see `writeStored` in
 * usePanelLayout.ts, which skips a write that would not change anything.
 *
 * `apply` must be stable - wrap it in useCallback - because the listener is
 * re-registered whenever it changes.
 */
export function useStorageSync(key: string, apply: (value: string | null) => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const onStorage = (event: StorageEvent) => {
      // A null key means the whole area was cleared, which concerns every key.
      if (event.key !== null && event.key !== key) return
      // sessionStorage writes raise the same event on the same window.
      if (event.storageArea && event.storageArea !== window.localStorage) return
      apply(event.key === null ? null : event.newValue)
    }

    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, apply])
}
