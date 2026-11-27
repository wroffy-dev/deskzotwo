/**
 * The e-way bill choices the screens read (25 Oct 2026: split from provider.ts, whose NIC path now encrypts
 * with node:crypto and must not reach the browser). provider.ts re-exports them for the server.
 */

/** Why a vehicle is being changed. The portal takes a code, and refuses a bare update without one. */
export const VEHICLE_UPDATE_REASONS = [
  { code: "1", label: "Due to break down" },
  { code: "2", label: "Transhipment" },
  { code: "3", label: "Other" },
  { code: "4", label: "First time vehicle" },
] as const;

/** Why a bill is being cancelled, in the portal's own list. */
export const CANCEL_REASONS = [
  { code: "1", label: "Duplicate" },
  { code: "2", label: "Order cancelled" },
  { code: "3", label: "Data entry mistake" },
  { code: "4", label: "Others" },
] as const;
