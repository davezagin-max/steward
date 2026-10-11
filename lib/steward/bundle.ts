import demo from "@/fixtures/demo.json";
import type { Bundle } from "./types";

/**
 * The bundled sample: profile, suggestions, and rule results precomputed by
 * `server/scripts/export_demo.py`. Shipping it with the app is what lets the
 * deployed site work when the Python API is cold or down.
 */
export const DEMO_BUNDLE = demo as unknown as Bundle;
