"use client";

import { createContext } from "react";
import type { LinkLabel } from "@/lib/smart-lists/links";

/**
 * The names and addresses of the records and files the cells on screen link to (Smart Lists phase 2), worked out on the
 * server as the person may see them (src/lib/smart-lists/links.ts `linkLabels`); a picker adds the ones it chose until
 * the page reloads.
 */
export const LinkLabels = createContext<{ labels: Record<string, LinkLabel>; learn: (more: Record<string, LinkLabel>) => void }>({ labels: {}, learn: () => {} });
