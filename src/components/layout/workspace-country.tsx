"use client";

import type { ReactNode } from "react";
import { setBrowserWorkspaceCountry } from "@/lib/country-pack";

/**
 * The signed-in workspace's country, for `workspaceCountry()` in the browser (src/lib/country-pack.ts):
 * set while this renders, so before any child formats an amount — the same answer the server rendered
 * the page with, and the hydration matches.
 */
export function WorkspaceCountry({ country, defaultTaxRate = null, children }: { country: string; defaultTaxRate?: number | null; children?: ReactNode }) {
  setBrowserWorkspaceCountry(country, defaultTaxRate);
  return children;
}
