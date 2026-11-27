import { AsyncLocalStorage } from "node:async_hooks";
import type { StaffRole } from "@deskzo/control-client";

/**
 * Who an internal API call acts as: the staff member signed in to the separate admin app
 * (owner, 27 Nov 2026: the console runs as its own app, on its own VM, domain and database, and
 * controls the CRM over this API only).
 *
 * The admin app keeps its own staff, sessions and authenticators. It signs every call
 * (src/lib/internal-api/signing.ts) and says in the signed headers which staff member is acting,
 * in which role, and when that person last gave a fresh authenticator code. Inside a call the CRM
 * has verified, `requireStaff` and `currentStaffSession` (src/lib/platform/staff-session.ts) answer
 * with that person, and `confirmStaffCode` / `recentStepUp` (src/lib/platform/step-up.ts) with that
 * step-up, so every console action runs through the same role checks, refusals and audit entries
 * as it did when the console was served from here.
 *
 * Only the internal API route (src/app/api/internal/v1/rpc/route.ts) enters it, after the
 * signature is checked. A browser never reaches it: it lives in this call's async context only.
 */
export type InternalActor = {
  /** The admin app's id for the staff member. Written to the audit log as `staff:<id>`. */
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  /** The admin app's session, for the audit trail; opaque here. */
  sessionRef: string;
  /** When the admin app last checked a fresh authenticator code from this person, or null. */
  stepUpAt: Date | null;
};

const STORE = Symbol.for("deskzo.internal-actor");
type Holder = { [STORE]?: AsyncLocalStorage<InternalActor> };
const holder = globalThis as Holder;
const store: AsyncLocalStorage<InternalActor> = (holder[STORE] ??= new AsyncLocalStorage<InternalActor>());

/** The admin app's staff member, inside a verified internal API call; null everywhere else. */
export function internalActor(): InternalActor | null {
  return store.getStore() ?? null;
}

/** Runs `work` as the admin app's staff member. Only for the internal API route, once the call is verified. */
export function runAsInternalActor<T>(actor: InternalActor, work: () => Promise<T>): Promise<T> {
  return store.run(actor, work);
}

/** The session id `currentStaffSession` reports inside an internal call, so step-up checks can tell it apart. */
export const INTERNAL_SESSION_PREFIX = "internal:";
