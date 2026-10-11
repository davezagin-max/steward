"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { KeyModal } from "./KeyModal";
import { getKey, getServerKey, setKey, subscribe } from "./key-store";

interface KeyContextValue {
  /** The visitor's key, or null in demo mode. */
  apiKey: string | null;
  isLive: boolean;
  openKeyModal: () => void;
  clearKey: () => void;
}

const KeyContext = createContext<KeyContextValue | null>(null);

export function KeyProvider({ children }: { children: ReactNode }) {
  const apiKey = useSyncExternalStore(subscribe, getKey, getServerKey);
  const [open, setOpen] = useState(false);

  const openKeyModal = useCallback(() => setOpen(true), []);
  const clearKey = useCallback(() => setKey(null, false), []);

  const value = useMemo(
    () => ({ apiKey, isLive: apiKey !== null, openKeyModal, clearKey }),
    [apiKey, openKeyModal, clearKey],
  );

  return (
    <KeyContext.Provider value={value}>
      {children}
      <KeyModal open={open} hasKey={apiKey !== null} onClose={() => setOpen(false)} />
    </KeyContext.Provider>
  );
}

export function useKey(): KeyContextValue {
  const value = useContext(KeyContext);
  if (!value) throw new Error("useKey must be used inside <KeyProvider>.");
  return value;
}
