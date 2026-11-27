import { z } from "zod";
import { ZOHO_REGION_KEYS } from "@/lib/workplace/providers";

/** Settings → Security → Sign-in: the policy every way of signing in shares. */
export const signInPolicySchema = z.object({
  enforceTwoFactor: z.boolean(),
  enforceSso: z.boolean(),
});

/** Settings → Security → Microsoft 365: the app in Entra ID, and what it is used for. */
export const microsoftAppSchema = z.object({
  // A directory (tenant) ID — a GUID (security audit SEC-02): "common" or "organizations" would let any directory in.
  microsoftTenantId: z
    .string()
    .trim()
    .max(100)
    .optional()
    .default("")
    .refine((v) => v === "" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), "Enter the Directory (tenant) ID — a GUID like 72f988bf-86f1-41af-91ab-2d7cd011db47."),
  microsoftClientId: z.string().trim().max(100).optional().default(""),
  /** Blank means "keep the existing secret". */
  microsoftClientSecret: z.string().trim().max(500).optional().or(z.literal("")),
  sso: z.boolean(),
  mail: z.boolean(),
});

/** Settings → Security → Google Workspace: the company's own OAuth client. */
export const googleAppSchema = z.object({
  clientId: z.string().trim().max(200).optional().default(""),
  /** Blank means "keep the existing secret". */
  clientSecret: z.string().trim().max(500).optional().or(z.literal("")),
  domain: z.string().trim().max(253).optional().default(""),
  sso: z.boolean(),
  mail: z.boolean(),
});

/** Settings → Security → Zoho: the company's own API-console client. */
export const zohoAppSchema = z.object({
  region: z.enum(ZOHO_REGION_KEYS as [string, ...string[]]),
  clientId: z.string().trim().max(200).optional().default(""),
  /** Blank means "keep the existing secret". */
  clientSecret: z.string().trim().max(500).optional().or(z.literal("")),
  sso: z.boolean(),
  mail: z.boolean(),
});
