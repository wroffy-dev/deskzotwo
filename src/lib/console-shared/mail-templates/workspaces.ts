import type { MailTemplateDef } from "@/lib/console-shared/mail-templates";

/** Deskzo's own emails in this group, with Deskzo's wording — see src/lib/console-shared/mail-templates.ts. */
export const TEMPLATES: MailTemplateDef[] = [
  {
    key: "workspaces.signup-code",
    label: "Signup code",
    group: "Workspaces",
    when: "Someone signs up for a new workspace — the code that confirms their email address.",
    type: "ACCOUNT",
    fromWorkspace: false,
    fields: [
      { name: "name", about: "The name of the person signing up", sample: "Asha Verma" },
      { name: "workspace", about: "The company the workspace is for", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "address", about: "The workspace's address", sample: "wroffy.deskzo.com" },
      { name: "code", about: "The six-digit code", sample: "482913" },
      { name: "lasts", about: "How long the code works", sample: "15 minutes" },
    ],
    required: ["code"],
    subject: "Your code for {address}: {code}",
    text: "Hello {name},\n\nYour code to finish setting up {workspace} is {code}.\n\nIt works for {lasts}. If you didn't ask for this, ignore it.",
  },
  {
    key: "workspaces.signup-code-resent",
    label: "Signup code sent again by support",
    group: "Workspaces",
    when: "Deskzo staff press \"Send a new code\" for a signup whose first code never arrived.",
    type: "ACCOUNT",
    fromWorkspace: false,
    fields: [
      { name: "name", about: "The name of the person signing up", sample: "Asha Verma" },
      { name: "workspace", about: "The company the workspace is for", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "address", about: "The workspace's address", sample: "wroffy.deskzo.com" },
      { name: "code", about: "The new six-digit code", sample: "482913" },
      { name: "lasts", about: "How long the code works", sample: "1 hour" },
    ],
    required: ["code"],
    subject: "Your code for {address}: {code}",
    text:
      "Hello {name},\n\nDeskzo support sent you a new code to finish setting up {workspace}: {code}\n\n" +
      "Enter it on the signup page, in the browser where you started. It works for {lasts}; any code we sent before no longer does.\n\n" +
      "If you didn't ask for this, ignore it.",
  },
  {
    key: "workspaces.ready",
    label: "Workspace is ready",
    group: "Workspaces",
    when: "A new workspace has finished setting up — to its owner.",
    type: "ACCOUNT",
    fromWorkspace: true,
    fields: [
      { name: "name", about: "The owner's name", sample: "Asha Verma" },
      { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "link", about: "The workspace's address, to sign in at", sample: "https://wroffy.deskzo.com" },
      { name: "email", about: "The owner's email address, to sign in with", sample: "asha@wroffy.com" },
      { name: "platform", about: "Deskzo's own domain", sample: "deskzo.com" },
    ],
    required: ["link"],
    subject: "{workspace} is ready",
    text:
      "Hello {name},\n\nYour workspace is ready at {link} — sign in there with {email} and the password you chose.\n\n" +
      "Every workspace on {platform} has its own address; keep this one.",
  },
  {
    key: "workspaces.support-access-request",
    label: "Support asks to look inside",
    group: "Workspaces",
    when: "Deskzo staff ask a workspace's super admin to let support in, from the console.",
    type: "ACCOUNT",
    fromWorkspace: true,
    fields: [
      { name: "staffName", about: "The staff member's display name — never their address", sample: "Rahul Mehta" },
      { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "address", about: "The workspace's address", sample: "wroffy.deskzo.com" },
      { name: "reason", about: "Why support needs to look, as the staff member wrote it", sample: "Your invoices since Monday print without the GST summary; we'd like to see one to find out why." },
      { name: "securityLink", about: "The link to the workspace's Security settings", sample: "https://wroffy.deskzo.com/settings/security" },
      { name: "maxHours", about: "The most hours access can be granted for", sample: "72" },
    ],
    required: ["securityLink"],
    subject: "Deskzo support asks to look at {workspace}",
    text:
      "Hello,\n\n{staffName}, from Deskzo support, asks to look inside {workspace} ({address}).\n\n" +
      "What it is for:\n{reason}\n\n" +
      "Nobody from Deskzo can see inside your workspace unless you let them. If you want to, as its super admin:\n\n" +
      "  1. Sign in, and open Settings › Security:\n" +
      "     {securityLink}\n" +
      "  2. Under \"Platform support access\", choose what they can do — look only, or an administrator's access — and for how many hours (up to {maxHours}).\n" +
      "  3. Let support in. You can end the access there at any time; it also ends by itself when the hours run out.\n\n" +
      "If you did not expect this, ignore this email — nothing changes unless you grant access.\n\n" +
      "Deskzo",
  },
  {
    key: "workspaces.domain-failing",
    label: "Custom domain failing",
    group: "Workspaces",
    when: "The daily check finds a live custom domain's DNS records no longer check out — to the workspace's owner, once.",
    type: "ALERTS",
    fromWorkspace: true,
    fields: [
      { name: "domain", about: "The custom domain", sample: "crm.wroffy.com" },
      { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "problems", about: "What the check found wrong, one line each", sample: "  · No TXT record found at _domain-verify.crm.wroffy.com." },
      { name: "stopsOn", about: "The day it stops unless fixed", sample: "4 November 2026" },
      { name: "ownAddress", about: "The workspace's own address, which links fall back to", sample: "wroffy.deskzo.com" },
      { name: "settingsLink", about: "The link to Settings › Domain", sample: "https://wroffy.deskzo.com/settings/domain" },
      { name: "brand", about: "The platform's name", sample: "Deskzo" },
    ],
    required: ["settingsLink"],
    subject: "{domain}: its DNS records are not checking out",
    text:
      "Hello,\n\nThe daily check of {domain}, an address of {workspace}, did not find the DNS records it needs:\n\n{problems}\n\n" +
      "It keeps working for now. Unless the records check out again by {stopsOn}, {domain} stops reaching the workspace, and links fall back to {ownAddress}.\n\n" +
      "The records are listed under Settings › Domain: {settingsLink}\n\n— {brand}",
  },
  {
    key: "workspaces.domain-staff-change",
    label: "Custom domain changed by Deskzo staff",
    group: "Workspaces",
    when: "Deskzo staff add, verify or make primary a custom domain for a workspace from the console — to the workspace's owner, every time.",
    type: "ALERTS",
    fromWorkspace: true,
    fields: [
      { name: "domain", about: "The custom domain", sample: "crm.wroffy.com" },
      { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "change", about: "What was done", sample: "added" },
      { name: "staff", about: "The staff member who did it", sample: "ops@deskzo.com" },
      { name: "settingsLink", about: "The link to Settings › Domain", sample: "https://wroffy.deskzo.com/settings/domain" },
      { name: "brand", about: "The platform's name", sample: "Deskzo" },
    ],
    required: ["settingsLink"],
    subject: "{domain} was {change} for {workspace} by {brand} staff",
    text:
      "Hello,\n\n{brand} staff ({staff}) {change} {domain} as an address of {workspace}.\n\n" +
      "If you did not ask for this, tell us straight away and remove it under Settings › Domain: {settingsLink}\n\n— {brand}",
  },
  {
    key: "workspaces.domain-stopped",
    label: "Custom domain stopped",
    group: "Workspaces",
    when: "A custom domain has failed its checks for 72 hours and stops reaching the workspace — to its owner, once.",
    type: "ALERTS",
    fromWorkspace: true,
    fields: [
      { name: "domain", about: "The custom domain", sample: "crm.wroffy.com" },
      { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "failingSince", about: "The day its records stopped checking out", sample: "1 November 2026" },
      { name: "problems", about: "What the check found wrong, one line each", sample: "  · No TXT record found at _domain-verify.crm.wroffy.com." },
      { name: "ownAddress", about: "The workspace's own address, used meanwhile", sample: "wroffy.deskzo.com" },
      { name: "settingsLink", about: "The link to Settings › Domain", sample: "https://wroffy.deskzo.com/settings/domain" },
      { name: "brand", about: "The platform's name", sample: "Deskzo" },
    ],
    required: ["settingsLink"],
    subject: "{domain} has stopped reaching {workspace}",
    text:
      "Hello,\n\n{domain} no longer reaches {workspace}: its DNS records have not checked out since {failingSince}.\n\n{problems}\n\n" +
      "Links in emails and documents use {ownAddress} meanwhile, and everybody can sign in there. Once the records are back, press Check now under Settings › Domain ({settingsLink}) — the address works again as soon as they check out.\n\n" +
      "— {brand}",
  },
  {
    // Security audit round two, 13 Nov 2026 (B7): a stopped address no longer stays reserved for ever.
    key: "workspaces.domain-taken-over",
    label: "Custom domain taken over",
    group: "Workspaces",
    when: "A custom domain stopped for 14 days or more is proved by another workspace and moves to it — to the old workspace's owner, once.",
    type: "ALERTS",
    fromWorkspace: true,
    fields: [
      { name: "domain", about: "The custom domain", sample: "crm.wroffy.com" },
      { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "failingSince", about: "The day its records stopped checking out", sample: "1 November 2026" },
      { name: "ownAddress", about: "The workspace's own address", sample: "wroffy.deskzo.com" },
      { name: "settingsLink", about: "The link to Settings › Domain", sample: "https://wroffy.deskzo.com/settings/domain" },
      { name: "brand", about: "The platform's name", sample: "Deskzo" },
    ],
    required: ["settingsLink"],
    subject: "{domain} has been removed from {workspace}",
    text:
      "Hello,\n\n{domain} had not reached {workspace} since {failingSince}: its DNS records stopped checking out. Another workspace has now proved it controls {domain}, so it has moved there and is no longer an address of {workspace}.\n\n" +
      "Your workspace is still at {ownAddress}. If {domain} is yours, set its records again and add it under Settings › Domain ({settingsLink}) — and tell us if you didn't expect this.\n\n" +
      "— {brand}",
  },
  {
    key: "workspaces.support-received",
    label: "Support request received",
    group: "Workspaces",
    when: "Someone in a workspace contacts Deskzo Support — the acknowledgement to them.",
    type: "SUPPORT",
    fromWorkspace: false,
    fields: [
      { name: "name", about: "The name of the person who asked", sample: "Asha Verma" },
      { name: "brand", about: "The platform's name", sample: "Deskzo" },
      { name: "ref", about: "The request's reference", sample: "SR-1042" },
      { name: "subject", about: "The subject they gave", sample: "Invoices won't print" },
      { name: "critical", about: "How critical they said it was", sample: "It's blocking my work (High)" },
      { name: "attachments", about: "What they attached", sample: "2 files and a screen recording" },
      { name: "message", about: "What they wrote", sample: "Since this morning every invoice opens a blank page when I press Print." },
      { name: "helpline", about: "The support helpline, with its hours — empty when there is none", sample: "1800 123 4567 (Mon–Sat, 10 am – 7 pm)" },
    ],
    required: ["ref"],
    subject: "We've received your request {ref}: {subject}",
    text:
      "Hello {name},\n\nThank you for contacting {brand} support. We've received your request and will reply to this address.\n\n" +
      "Reference: {ref}\nSubject: {subject}\nHow critical: {critical}\nAttachments: {attachments}\n\n" +
      "What you told us:\n{message}\n\n" +
      "[[If it can't wait, call {helpline} and quote {ref}.]]\n\n" +
      "To add anything, reply to this email and keep {ref} in the subject.\n\n{brand} support",
  },
  {
    key: "workspaces.invitation",
    label: "Invitation to set up a workspace",
    group: "Workspaces",
    when: "Deskzo staff email an invitation from the console's Invitations — when it's made, or sent again with a new code.",
    type: "ACCOUNT",
    fromWorkspace: false,
    fields: [
      { name: "name", about: "Who it's for, as the invitation names them — empty if it doesn't", sample: "Acme Pvt Ltd — Priya" },
      { name: "link", about: "The signup link — it carries the code when an address is held", sample: "https://www.deskzo.com/signup?invite=Zk3pQ8vR2mXc" },
      { name: "code", about: "The invitation code", sample: "Zk3pQ8vR2mXc" },
      { name: "address", about: "The address held for them — empty when they choose their own", sample: "acme.deskzo.com" },
      { name: "plan", about: "The plan the workspace starts its trial on — empty for the default", sample: "Deskzo One" },
      { name: "until", about: "The day the code stops working", sample: "27 November 2026" },
    ],
    required: ["link", "code"],
    subject: "Your invitation to set up a Deskzo workspace",
    text:
      "Hello[[ {name}]],\n\nYou're invited to set up your company's workspace on Deskzo[[ on the {plan} plan]].\n" +
      "[[Your address is kept for you: {address}]]\n\n" +
      "Sign up here: {link}\nYour invitation code: {code}\n\n" +
      "The code works until {until}. If you weren't expecting this, you can ignore it.",
  },
  {
    key: "website.privacy-request-received",
    label: "Privacy request received",
    group: "Website",
    when: "Someone sends a privacy request from the website — the acknowledgement to them.",
    type: "ACCOUNT",
    fromWorkspace: false,
    fields: [
      { name: "name", about: "The name they gave", sample: "Asha Verma" },
      { name: "request", about: "What they asked for", sample: "A copy of my data" },
      { name: "ref", about: "The request's reference — empty if it couldn't be kept", sample: "PR-0042" },
      { name: "replyBy", about: "When they'll hear back: \"by <date> at the latest\", or \"within 30 days\"", sample: "by 1 December 2026 at the latest" },
      { name: "keptBy", about: "When they're a workspace's user or customer: the company they named (or \"a company\"); otherwise empty", sample: "Wroffy Technologies Pvt Ltd" },
      { name: "contact", about: "The privacy contact's address — empty when none is set", sample: "privacy@deskzo.com" },
      { name: "site", about: "The website's name", sample: "Deskzo" },
    ],
    required: [],
    subject: "We've received your privacy request[[ {ref}]]",
    text:
      "Dear {name},\n\nWe've received your request: {request}.[[ Its reference is {ref} — please quote it if you write to us about it.]]\n" +
      "We will reply {replyBy}.\n" +
      "[[If the data is kept by {keptBy} in its own Deskzo workspace, that company decides what happens to it; we'll tell you how to reach them, or pass your request on.]]\n\n" +
      "We may need to confirm it's you before we act on a request about your data.\n" +
      "[[Questions: {contact}]]\n\n— {site}",
  },
];
