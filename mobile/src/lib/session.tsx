import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, onSignedOut, type Me } from "@/lib/api";
import { calls } from "@/lib/native";
import { purgeOldCopies, wipeCopies } from "@/lib/offline";
import { wipeOutbox } from "@/lib/outbox";

/**
 * Who this phone is signed in as. The token lives in the native module's private storage (so the
 * background sync can use it with the app closed); this holds what the screens need on top.
 */

type SessionState = {
  ready: boolean;
  paired: boolean;
  me: Me | null;
  /** Deskzo signed this phone out — revoked in Security › Devices, or signed out from Settings. */
  signedOut: boolean;
  refreshMe: () => Promise<Me | null>;
  paired_: (baseUrl: string, token: string, host: string | null) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const forget = useCallback(() => {
    // Nothing of theirs stays on the phone (src/lib/offline.ts).
    wipeCopies();
    wipeOutbox();
    calls.clearSession();
    setPaired(false);
    setMe(null);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const next = await api<Me>("GET", "/api/app/me");
      setMe(next);
      // The workspace switched recordings off: the phone stops sending at once (it starts again only when asked).
      if (!next.recordings && calls.getRecordings()) calls.setRecordings(false);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const session = calls.getSession();
    if (calls.signedOut()) {
      setSignedOut(true);
      // Security audit, 13 Nov 2026 (round two, phone lows): the background sync can learn the phone was signed out
      // while the app is closed, and only removes the token. The kept copies and anything waiting to send go now.
      wipeCopies();
      wipeOutbox();
    }
    setPaired(!!session);
    setReady(true);
    purgeOldCopies();
    if (session) void refreshMe();
    return onSignedOut(() => {
      setSignedOut(true);
      forget();
    });
  }, [forget, refreshMe]);

  const value = useMemo<SessionState>(
    () => ({
      ready,
      paired,
      me,
      signedOut,
      refreshMe,
      paired_: async (baseUrl, token, host) => {
        calls.setSession(baseUrl, token, host);
        setSignedOut(false);
        setPaired(true);
        await refreshMe();
      },
      signOut: async () => {
        try {
          await api("DELETE", "/api/app/device");
        } catch {
          // Signed out here whatever Deskzo says; an administrator can revoke it there too.
        }
        forget();
      },
    }),
    [ready, paired, me, signedOut, refreshMe, forget],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
