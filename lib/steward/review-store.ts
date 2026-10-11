/**
 * Holds the review state outside React so it can be read with `useSyncExternalStore`,
 * which gives a clean server render (everything pending) and then the saved review on
 * the client without a setState-in-effect.
 *
 * Only the bundled sample is persisted (to localStorage, on this device). A review of an
 * uploaded file is kept in memory and gone when the tab closes, because decisions can
 * contain values from the data, such as an allowed code list.
 */
import {
  initialState,
  reduce,
  restoreState,
  type ReviewAction,
  type ReviewItem,
  type ReviewState,
} from "./review";
import type { Rule } from "./types";

export interface ReviewStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ReviewState;
  getServerSnapshot: () => ReviewState;
  dispatch: (action: ReviewAction, items: ReviewItem[]) => void;
}

interface Options {
  items: ReviewItem[];
  /** localStorage key, or null to keep the review in memory only. */
  persistKey: string | null;
  isValidRule: (rule: Rule) => boolean;
  now?: () => string;
}

export function createReviewStore({ items, persistKey, isValidRule, now }: Options): ReviewStore {
  const initial = initialState(items);
  const listeners = new Set<() => void>();
  let state = initial;
  let loaded = false;

  function load(): void {
    if (loaded) return;
    loaded = true;
    if (!persistKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(persistKey);
      if (raw) state = restoreState(JSON.parse(raw), items, isValidRule) ?? initial;
    } catch {
      // Unreadable or blocked storage: start from a clean review.
    }
  }

  function save(): void {
    if (!persistKey || typeof window === "undefined") return;
    try {
      if (state.audit.length === 0) window.localStorage.removeItem(persistKey);
      else window.localStorage.setItem(persistKey, JSON.stringify(state));
    } catch {
      // The review still works for this session.
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      load();
      return state;
    },
    getServerSnapshot: () => initial,
    dispatch(action, currentItems) {
      load();
      const next = reduce(state, action, currentItems, (now ?? (() => new Date().toISOString()))());
      if (next === state) return;
      state = next;
      save();
      listeners.forEach((listener) => listener());
    },
  };
}

/** Changes whenever the set of suggestions changes, so a saved review is never applied to different ones. */
export function reviewFingerprint(datasetId: string, items: ReviewItem[], recordedAt: string | null): string {
  let hash = 5381;
  for (const item of items) {
    for (let index = 0; index < item.id.length; index++) {
      hash = ((hash << 5) + hash + item.id.charCodeAt(index)) | 0;
    }
  }
  return `steward.review.v1.${datasetId}.${items.length}.${(hash >>> 0).toString(36)}.${recordedAt ?? "sample"}`;
}
