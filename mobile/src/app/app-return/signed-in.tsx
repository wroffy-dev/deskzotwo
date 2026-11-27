import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * https://deskzo.com/app-return/signed-in?code=… — the browser sign-in's way back for a build with verified App Links
 * (security audit round two, 13 Nov 2026, R2-12; src/lib/config.ts APP_LINKS). The same as deskzo://signed-in: on to
 * the signed-in screen, which spends the code once.
 */
export default function AppReturnSignedIn() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const code = typeof params.code === "string" && /^[A-Za-z0-9]+$/.test(params.code) ? params.code : undefined;
  const error = typeof params.error === "string" && /^[a-z_]+$/.test(params.error) ? params.error : undefined;
  return <Redirect href={{ pathname: "/signed-in", params: { ...(code ? { code } : {}), ...(error ? { error } : {}) } }} />;
}
