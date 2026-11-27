import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { workspacePack } from "@/lib/country-pack";
// PAN and IFSC checked in an India workspace only — see there.
import { ifscField, panField } from "@/lib/validation/hr";

/**
 * What a new joiner may send us before they have an account.
 *
 * Lives outside `src/actions` because a `"use server"` module may only export async functions —
 * a schema exported from one fails the build. Keeping it here also means the same rules can be
 * read by the form without dragging the server action into the client bundle.
 */

const text = (max = 120) => z.string().trim().max(max).optional().or(z.literal(""));

export const intakeSchema = z.object({
  token: z.string().max(2000, tooLong(2000)).min(10),
  personalEmail: z.string().trim().max(254, tooLong(254)).email("That isn't a valid email.").optional().or(z.literal("")),
  personalPhone: z.string().trim().min(6, "We need a number we can reach you on.").max(20),
  dateOfBirth: z.string().trim().max(100, tooLong(100)).min(1, "Date of birth is needed for your records."),
  bloodGroup: text(8),
  maritalStatus: text(20),

  addressLine1: z.string().trim().min(3, "Street address.").max(160),
  addressLine2: text(160),
  city: z.string().trim().min(2, "City.").max(80),
  /*
   * India's state sets the professional-tax slab and its PIN code is always six digits. Elsewhere
   * (owner, 30 Oct 2026) neither is a rule: Singapore has no states, most of the UAE no postcode —
   * both optional, asked of the workspace's country pack when the form is parsed.
   */
  state: z
    .string()
    .trim()
    .max(80)
    .refine((v) => !workspacePack().india || v.length >= 2, "State — it decides your professional tax."),
  pincode: z
    .string()
    .trim()
    .max(12)
    .refine((v) => (workspacePack().india ? /^\d{6}$/.test(v) : true), "A six-digit PIN code."),

  emergencyContactName: z.string().trim().min(2, "Somebody we can call.").max(80),
  emergencyContactPhone: z.string().trim().min(6, "Their number.").max(20),
  emergencyContactRelation: text(40),

  panNumber: panField,
  aadhaarLast4: z
    .string()
    .trim()
    .max(100, tooLong(100))
    .regex(/^\d{4}$/, "Only the last four digits — never the whole number.")
    .optional()
    .or(z.literal("")),
  uanNumber: text(20),

  bankName: text(80),
  bankAccountNumber: text(32),
  bankIfsc: ifscField,
});

export type IntakeInput = z.infer<typeof intakeSchema>;
