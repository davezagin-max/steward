"use client";

import { createContext, useContext } from "react";
import type { ReviewAction, ReviewItem, ReviewState } from "@/lib/steward/review";
import type { Bundle, Rule, RuleResult } from "@/lib/steward/types";

/** State of a rule re-run requested from the UI: in flight, or the reason it failed. */
export type RerunState = { status: "running" } | { status: "error"; message: string };

export interface Workspace {
  bundle: Bundle;
  columns: string[];
  items: ReviewItem[];
  review: ReviewState;
  /** Latest engine result per rule id, including re-runs of edited rules. */
  results: Record<string, RuleResult>;
  act: (action: ReviewAction) => void;
  /** True when a Steward API is configured, so edited rules can be executed. */
  apiAvailable: boolean;
  rerun: (item: ReviewItem, rule: Rule) => void;
  reruns: Record<string, RerunState>;
  openColumn: (name: string) => void;
  openRelationships: () => void;
  /** The suggestion "Start reviewing" is pointing at, if any. It is highlighted on screen. */
  spotlight: string | null;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>.");
  return value;
}
