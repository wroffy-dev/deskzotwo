import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { HEX_PATTERN } from "@/lib/branding";

export const brandingSettingsSchema = z.object({
  appName: z.string().trim().max(200, tooLong(200)).min(1, "The app needs a name"),
  shortName: z.string().trim().max(4, "Keep it to 4 characters or fewer").optional().or(z.literal("")),
  tagline: z.string().trim().max(500, tooLong(500)).optional().or(z.literal("")),
  primaryColor: z.string().max(100, tooLong(100)).regex(HEX_PATTERN, "Use a hex colour like #4f46e5"),
  defaultTheme: z.enum(["light", "dark", "system"]),
});

export type BrandingSettingsInput = z.infer<typeof brandingSettingsSchema>;
