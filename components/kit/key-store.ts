/**
 * Holds the visitor's Anthropic key in memory for the life of the tab.
 * Optionally mirrors it to sessionStorage (cleared when the tab closes).
 * It is never written to localStorage, cookies, or the server.
 */
const STORAGE_KEY = "anthropic-key";

let current: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    current = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; memory-only still works.
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getKey(): string | null {
  load();
  return current;
}

export function getServerKey(): string | null {
  return null;
}

export function isRemembered(): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function setKey(key: string | null, remember: boolean): void {
  loaded = true;
  current = key && key.trim() ? key.trim() : null;
  try {
    if (current && remember) window.sessionStorage.setItem(STORAGE_KEY, current);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; the in-memory copy is the source of truth.
  }
  listeners.forEach((listener) => listener());
}
