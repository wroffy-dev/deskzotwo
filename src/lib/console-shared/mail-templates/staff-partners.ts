import type { TemplateField } from "@/lib/console-shared/mail-template-engine";
import type { MailTemplateDef } from "@/lib/console-shared/mail-templates";

const GROUP = "Deskzo staff and partners" as const;
const NAME: TemplateField = { name: "name", about: "Their name", sample: "Priya Sharma" };
const NOTE: TemplateField = { name: "note", about: "The partner manager's note, when they left one", sample: "Protected for you — good luck with it." };
const lines = (...text: string[]) => text.join("\n");

/** A setup link, as each of the three sign-ins words it: new account, reset, switched back on. */
function setupLink(key: string, label: string, when: string, link: string, subject: string, opening: string, closing: string): MailTemplateDef {
  return {
    key,
    label,
    group: GROUP,
    when,
    type: "ACCOUNT",
    fromWorkspace: false,
    fields: [NAME, { name: "link", about: "The one-time link to choose a password", sample: link }],
    required: ["link"],
    subject,
    text: lines("Hello {name},", "", opening, "", "{link}", "", closing),
  };
}

/** One of the emails to a partner's people (mailPartnerUsers, src/lib/partners/registry.ts) — "Hello {name}," and the rest. */
function partnerMail(key: string, label: string, when: string, fields: TemplateField[], required: string[], subject: string, ...body: string[]): MailTemplateDef {
  return { key, label, group: GROUP, when, type: "ACCOUNT", fromWorkspace: false, fields: [NAME, ...fields], required, subject, text: lines("Hello {name},", "", ...body) };
}

const CONSOLE_LINK = "https://admin.deskzo.com/setup?t=Zk3pQ8vR2mXc";
const CMS_LINK = "https://cms.deskzo.com/setup?t=Zk3pQ8vR2mXc";
const PARTNER_LINK = "https://partners.deskzo.com/setup?t=Zk3pQ8vR2mXc";
const IGNORE_IT = "If you did not expect this, you can ignore it.";

const STATEMENT_FIELDS: TemplateField[] = [
  { name: "number", about: "The statement's number", sample: "ACME-2026-08-INR" },
  { name: "month", about: "The month it covers", sample: "August 2026" },
];
const STATEMENT_LINK: TemplateField = { name: "link", about: "The statement in the partner portal", sample: "https://partners.deskzo.com/statements/ACME-2026-08-INR" };
const DEAL_FIELDS: TemplateField[] = [
  { name: "company", about: "The company registered", sample: "Sunrise Traders" },
  { name: "domain", about: "Its email domain", sample: "sunrisetraders.in" },
];
const REQUEST_FIELD: TemplateField = { name: "request", about: "What they asked for — e.g. “new payout details”, “proposed reseller”", sample: "change to your company profile" };

/** Deskzo's own emails in this group, with Deskzo's wording — see src/lib/console-shared/mail-templates.ts. */
export const TEMPLATES: MailTemplateDef[] = [
  // ─── Console staff ─────────────────────────────────────────────────────────────────────────────
  setupLink(
    "staff.setup",
    "Console: new staff account",
    "An owner adds somebody to the platform console's staff.",
    CONSOLE_LINK,
    "Your console account",
    "You have been given an account on the platform console. Choose your password here — the link works once, for three days:",
    "At your first sign-in you will set up two-factor authentication.",
  ),
  setupLink(
    "staff.reactivated",
    "Console: staff account switched back on",
    "An owner switches a staff member's console account back on.",
    CONSOLE_LINK,
    "Your console account",
    "Your account on the platform console has been switched back on. Choose a new password here — the link works once, for three days:",
    "Your old password no longer works. At your first sign-in you will set up two-factor authentication again.",
  ),
  setupLink(
    "staff.passwordLink",
    "Console: choose a new password",
    "A staff member asks for a link to choose a new console password.",
    CONSOLE_LINK,
    "Choose a new console password",
    "You asked for a link to choose a new password for the platform console. It works once, for three days, and replaces any link sent before:",
    "Choosing a password signs you out everywhere. If you did not ask for this, tell an owner — your password stays as it is until the link is used.",
  ),

  // ─── Website CMS ───────────────────────────────────────────────────────────────────────────────
  setupLink(
    "cms.setup",
    "Website CMS: new account",
    "Somebody is given an account on the website CMS.",
    CMS_LINK,
    "Your website CMS account",
    "You have been given an account on the website CMS. Choose your password here — the link works once, for three days:",
    IGNORE_IT,
  ),
  setupLink(
    "cms.reset",
    "Website CMS: choose a new password",
    "A CMS admin sends somebody a link to choose a new password.",
    CMS_LINK,
    "Your website CMS account",
    "Here is a link to choose a new password for the website CMS. It works once, for three days:",
    IGNORE_IT,
  ),
  setupLink(
    "cms.reactivated",
    "Website CMS: account switched back on",
    "A CMS admin switches somebody's account back on.",
    CMS_LINK,
    "Your website CMS account",
    "Your website CMS account has been switched back on. Choose a new password here — the link works once, for three days:",
    IGNORE_IT,
  ),

  // ─── Partner portal: accounts ──────────────────────────────────────────────────────────────────
  setupLink(
    "partner.setup",
    "Partner portal: new account",
    "A partner's admin, or Deskzo staff, invites somebody to the partner portal.",
    PARTNER_LINK,
    "Partner portal: your account",
    "You have been given an account on the partner portal. Choose your password here — the link works once, for three days:",
    IGNORE_IT,
  ),
  setupLink(
    "partner.reset",
    "Partner portal: choose a new password",
    "Somebody on the partner portal is sent a link to choose a new password.",
    PARTNER_LINK,
    "Partner portal: your account",
    "Here is a link to choose a new password for the partner portal. It works once, for three days:",
    IGNORE_IT,
  ),
  setupLink(
    "partner.reactivated",
    "Partner portal: account switched back on",
    "Somebody's partner portal account is switched back on.",
    PARTNER_LINK,
    "Partner portal: your account",
    "Your partner portal account has been switched back on. Choose a new password here — the link works once, for three days:",
    IGNORE_IT,
  ),

  // ─── Partner portal: the partner's status ──────────────────────────────────────────────────────
  partnerMail(
    "partner.active",
    "Partner portal: partner account active",
    "Staff make a partner active — to its admins.",
    [],
    [],
    "Partner portal: your partner account is now active",
    "Your partner account is now active. You can create invitation codes, referral links and deal registrations in the partner portal.",
  ),
  partnerMail(
    "partner.suspended",
    "Partner portal: partner account suspended",
    "Staff suspend a partner — to its admins.",
    [],
    [],
    "Partner portal: your partner account has been suspended",
    "Your partner account has been suspended. Your customers and commissions are unaffected; new codes, links and registrations are paused.",
    "",
    "Contact your partner manager.",
  ),
  partnerMail(
    "partner.terminated",
    "Partner portal: partner account terminated",
    "Staff terminate a partner — to its admins.",
    [],
    [],
    "Partner portal: your partner account has been terminated",
    "Your partner account has been terminated, and signing in to the partner portal has ended.",
    "",
    "Commission already earned is still paid on your statements. Contact your partner manager with any questions.",
  ),

  // ─── Partner portal: customers, deals and requests ─────────────────────────────────────────────
  partnerMail(
    "partner.newCustomer",
    "Partner portal: a new customer signed up",
    "A new workspace is credited to a partner — to its admin and sales users.",
    [
      { name: "workspace", about: "The new workspace's name", sample: "Sunrise Traders" },
      { name: "how", about: "How it came to them — e.g. “with one of your invitation codes”", sample: "through one of your referral links" },
      { name: "link", about: "Their customers in the partner portal", sample: "https://partners.deskzo.com/customers" },
    ],
    ["link"],
    "Partner portal: a new customer signed up",
    "{workspace} has just signed up {how}, and is now one of your customers.",
    "",
    "See it in the partner portal: {link}",
  ),
  partnerMail(
    "partner.payoutChanged",
    "Partner portal: payout details changed",
    "The bank details a partner's commission is paid to change — to its admins.",
    [
      { name: "accountHolder", about: "The account holder's name", sample: "Acme Solutions Pvt Ltd" },
      { name: "bankName", about: "The bank", sample: "HDFC Bank" },
      { name: "last4", about: "The account number's last four digits", sample: "3434" },
      { name: "currency", about: "The currency paid in", sample: "INR" },
    ],
    [],
    "Partner portal: payout details changed",
    "The bank details your company's commission is paid to have been changed.",
    "",
    "Now on file: {accountHolder}, {bankName}, account ending {last4} ({currency}).",
    "",
    "If you did not expect this, contact your partner manager straight away.",
  ),
  partnerMail(
    "partner.dealApproved",
    "Partner portal: deal registration approved",
    "Staff approve a deal registration — to the person who registered it.",
    [...DEAL_FIELDS, { name: "protectedUntil", about: "The day its protection ends", sample: "31 Jan 2027" }, NOTE],
    [],
    "Partner portal: deal registration approved",
    "Your registration of {company} ({domain}) has been approved. It is protected until {protectedUntil}: a workspace that signs up from {domain} before then is credited to you.",
    "",
    "[[Note from your partner manager: {note}]]",
  ),
  partnerMail(
    "partner.dealDeclined",
    "Partner portal: deal registration declined",
    "Staff decline a deal registration — to the person who registered it.",
    [...DEAL_FIELDS, NOTE],
    [],
    "Partner portal: deal registration declined",
    "Your registration of {company} ({domain}) has been declined.",
    "",
    "[[Note from your partner manager: {note}]]",
  ),
  partnerMail(
    "partner.requestApproved",
    "Partner portal: request approved",
    "Staff approve a partner's request — to the person who made it.",
    [
      REQUEST_FIELD,
      { name: "resellerInvited", about: "For a proposed reseller: that its contact has been invited as its admin", sample: "Its proposed contact has been invited to the partner portal as its admin." },
      NOTE,
    ],
    [],
    "Partner portal: your request was approved",
    "Your {request} has been approved.",
    "",
    "[[{resellerInvited}]]",
    "",
    "[[Note from your partner manager: {note}]]",
  ),
  partnerMail(
    "partner.requestRejected",
    "Partner portal: request rejected",
    "Staff reject a partner's request — to the person who made it.",
    [REQUEST_FIELD, NOTE],
    [],
    "Partner portal: your request was rejected",
    "Your {request} has been rejected.",
    "",
    "[[Note from your partner manager: {note}]]",
  ),

  // ─── Partner portal: statements ────────────────────────────────────────────────────────────────
  partnerMail(
    "partner.statementReady",
    "Partner portal: commission statement ready",
    "Staff approve a commission statement for payment — to the partner's admin and finance users.",
    [
      ...STATEMENT_FIELDS,
      { name: "currency", about: "The statement's currency", sample: "INR" },
      { name: "commission", about: "The commission, before tax", sample: "₹40,000.00" },
      { name: "taxLines", about: "One line for each tax added or withheld (none: left out)", sample: "GST (added): ₹7,200.00\nTDS (withheld): ₹2,000.00" },
      { name: "netPayable", about: "What is paid", sample: "₹45,200.00" },
      { name: "invoiceRequest", about: "To a partner registered for tax: the ask for their invoice number", sample: "Please add your invoice number for this statement in the partner portal." },
      STATEMENT_LINK,
    ],
    ["link"],
    "Partner portal: your statement {number} is ready",
    "Your commission statement for {month} ({currency}) has been approved for payment.",
    "",
    "Commission: {commission}",
    "[[{taxLines}]]",
    "Net payable: {netPayable}",
    "",
    "[[{invoiceRequest}]]",
    "",
    "See it in the partner portal: {link}",
  ),
  partnerMail(
    "partner.statementPaid",
    "Partner portal: commission statement paid",
    "Staff mark a commission statement paid — to the partner's admin and finance users.",
    [
      ...STATEMENT_FIELDS,
      { name: "amount", about: "What was paid", sample: "₹45,200.00" },
      { name: "paidOn", about: "The day it was paid", sample: "5 Sept 2026" },
      { name: "reference", about: "The payment reference", sample: "UTR-HDFC-0098123" },
      STATEMENT_LINK,
    ],
    ["link"],
    "Partner portal: statement {number} paid — reference {reference}",
    "Your commission statement {number} for {month} has been paid: {amount}, on {paidOn}.",
    "",
    "Payment reference: {reference}",
    "",
    "See it in the partner portal: {link}",
  ),
];
