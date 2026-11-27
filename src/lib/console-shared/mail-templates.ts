import type { TemplateField } from "@/lib/console-shared/mail-template-engine";
import type { MailType } from "@/lib/console-shared/mail-catalogue";
import { TEMPLATES as SIGNING_IN } from "@/lib/console-shared/mail-templates/signing-in";
import { TEMPLATES as WORKSPACES } from "@/lib/console-shared/mail-templates/workspaces";
import { TEMPLATES as BILLING } from "@/lib/console-shared/mail-templates/billing";
import { TEMPLATES as STAFF_PARTNERS } from "@/lib/console-shared/mail-templates/staff-partners";

/**
 * Every email Deskzo itself writes, with Deskzo's wording (owner, 1 Nov 2026) — edited in the console's
 * Settings › Mail › Templates and sent through src/lib/platform/mail/templates.ts. Pure and client-safe.
 *
 * Not here, on purpose: mail that carries what a person wrote or a document — calendar invitations, a
 * workspace's quotes and invoices sent through Deskzo's mail, helpdesk replies, the Customer inbox's
 * follow-ups. Those have no wording of Deskzo's to edit.
 *
 * `fromWorkspace`: the email is about one workspace, so it goes from "<Workspace> via Deskzo".
 */

export type MailTemplateGroup = "Signing in" | "Workspaces" | "Billing" | "Deskzo staff and partners" | "Website";

export type MailTemplateDef = {
  key: MailTemplateKey;
  label: string;
  group: MailTemplateGroup;
  /** When it is sent, in a line. */
  when: string;
  type: MailType;
  fromWorkspace: boolean;
  fields: TemplateField[];
  /** Fields the email can't work without — its link, its code. */
  required: string[];
  subject: string;
  text: string;
};

/** A template's key, "group.name" — e.g. "account.setup". Checked against MAIL_TEMPLATES where it is used. */
export type MailTemplateKey = string;

export const MAIL_TEMPLATES: MailTemplateDef[] = [...SIGNING_IN, ...WORKSPACES, ...BILLING, ...STAFF_PARTNERS];

export const MAIL_TEMPLATE_GROUPS: MailTemplateGroup[] = ["Signing in", "Workspaces", "Billing", "Deskzo staff and partners", "Website"];
