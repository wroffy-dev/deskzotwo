import type { CallResult, QuickMoment } from "@/lib/quick-messages/fields";

/**
 * The templates every workspace starts with (owner, 11 Nov 2026 — "loaded templates"). Added once, the first time the
 * list is read (src/lib/quick-messages/server.ts `ensureStarters`); after that they are the workspace's to change or
 * switch off, and one deleted stays deleted — `starterKey` is how each is known to have been given already.
 *
 * WhatsApp: the words are ready, but outside the 24 hours a customer's own message opens, Meta sends only what it has
 * approved — so each needs its Meta template name filled in (Settings › Message templates) before it goes that way.
 */
export type Starter = {
  key: string;
  name: string;
  moment: QuickMoment;
  callResult: CallResult;
  emailSubject: string;
  emailBody: string;
  whatsappBody: string;
  /** Written to go with a PDF the workspace attaches — its company profile — in Settings › Message templates. */
  wantsFile?: boolean;
};

export const STARTERS: Starter[] = [
  {
    key: "manager-changed",
    name: "Meet your new account manager",
    moment: "MANAGER_CHANGED",
    callResult: "ANY",
    emailSubject: "Your new account manager at {{ourName}}",
    emailBody:
      "Hi {{firstName|there}},\n\nI'm {{newManagerName}}, and I'll be looking after {{companyName}} at {{ourName}} from now on.\n\nNothing changes in your orders, renewals or support — I have the full history of your account. For anything you need, write to me here or call me on {{newManagerPhone|the number below}}.\n\nI'd be glad to set up a short call to introduce myself — tell me a time that suits you.\n\nRegards,\n{{newManagerName}}\n{{ourName}}\n{{newManagerEmail}}",
    whatsappBody: "Hi {{firstName|there}}, I'm {{newManagerName}} from {{ourName}}. I'll be your account manager for {{companyName}} from now on. For anything you need, message or call me on this number.",
  },
  {
    key: "call-thanks",
    name: "Thanks for speaking with us",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "Thank you for your time — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for speaking with me today. As discussed, I'll follow up with the details shortly.\n\nIf you have any questions in the meantime, reply to this email or call me on {{myPhone|my number}}.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, thank you for speaking with me today. This is {{myName}} from {{ourName}} — message me here for anything you need.",
  },
  {
    key: "call-details",
    name: "Details as discussed",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "The details we discussed — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nGood to speak with you. Here are the details we discussed:\n\n\n\nTell me if you'd like anything changed, or a quotation for it.\n\nRegards,\n{{myName}}\n{{ourName}}\n{{myPhone|}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}} here. I've emailed you the details we discussed — do have a look and tell me if you'd like anything changed.",
  },
  {
    key: "call-meeting",
    name: "Shall we fix a meeting?",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "A time to meet — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for your time on the call. I'd like to take this forward in a short meeting — would any time this week suit you? Tell me a day and time and I'll send the invitation.\n\nRegards,\n{{myName}}\n{{ourName}}\n{{myPhone|}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. Thank you for your time today. Would a short meeting this week suit you? Tell me a day and time.",
  },
  {
    key: "call-missed",
    name: "Sorry we missed you",
    moment: "AFTER_CALL",
    callResult: "NOT_CONNECTED",
    emailSubject: "I tried to reach you — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nI tried calling you today and couldn't get through. When is a good time to speak? You can also call me back on {{myPhone|my number}} or reply to this email.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, this is {{myName}} from {{ourName}}. I tried calling you today and couldn't get through. When is a good time to speak?",
  },
  {
    key: "call-intro",
    name: "Introduction",
    moment: "AFTER_CALL",
    callResult: "ANY",
    emailSubject: "Introducing {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nI'm {{myName}} from {{ourName}}. I called to introduce what we do and see whether we can help {{companyName}}.\n\nI'd be glad to share more in a short call at a time that suits you — reply here or call me on {{myPhone|my number}}.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, I'm {{myName}} from {{ourName}}. I called to introduce what we do for companies like {{companyName}}. May I share a few details here?",
  },
  // More, and one that carries the company profile (owner, 11 Nov 2026).
  {
    key: "company-profile",
    name: "Our company profile",
    moment: "AFTER_CALL",
    callResult: "ANY",
    wantsFile: true,
    emailSubject: "{{ourName}} — company profile",
    emailBody:
      "Hi {{firstName|there}},\n\nThank you for your time. As promised, I've attached our company profile — who we are, what we do and the customers we work with.\n\nI'd be glad to walk you through anything in it, or to put together a proposal for {{companyName}}. Reply here or call me on {{myPhone|my number}}.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}} here. Sharing our company profile with you, as promised. Do have a look and tell me if you have any questions.",
  },
  {
    key: "call-quote-coming",
    name: "Your quotation is on its way",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "Your quotation from {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for sharing your requirement on the call. I'm preparing the quotation for {{companyName}} and will send it to you shortly.\n\nIf anything changes in the quantity or the timeline in the meantime, tell me and I'll include it.\n\nRegards,\n{{myName}}\n{{ourName}}\n{{myPhone|}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. Thank you for sharing your requirement. I'm preparing your quotation and will send it shortly.",
  },
  {
    key: "call-callback",
    name: "Confirming our callback",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "I'll call you back — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for taking my call. As you asked, I'll call you back at the time we agreed.\n\nIf another time suits you better, reply to this email or call me on {{myPhone|my number}}.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. As you asked, I'll call you back at the time we agreed. If another time suits you better, tell me here.",
  },
  {
    key: "call-renewal",
    name: "Your renewal, as discussed",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "Your renewal with {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for speaking with me about {{companyName}}'s renewal. I'll send the renewal quotation shortly so there is no break in your service.\n\nIf you'd like to change the quantity or the plan this time, tell me and I'll include it.\n\nRegards,\n{{myName}}\n{{ourName}}\n{{myPhone|}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. Thank you for speaking with me about your renewal. I'll send the renewal quotation shortly so there is no break in your service.",
  },
  {
    key: "call-payment",
    name: "The payment we spoke about",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "Payment follow-up — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for your time on the call. As discussed, please arrange the pending payment at the earliest, and share the transaction details once it's done so we can update your account.\n\nIf you need the invoice or our bank details again, reply here and I'll send them.\n\nRegards,\n{{myName}}\n{{ourName}}\n{{myPhone|}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. As discussed on the call, please arrange the pending payment and share the transaction details once it's done. Thank you.",
  },
  {
    key: "call-keep-in-touch",
    name: "Not now? Let's stay in touch",
    moment: "AFTER_CALL",
    callResult: "CONNECTED",
    emailSubject: "Thank you for your time — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nThank you for taking my call. I understand the timing isn't right for {{companyName}} at the moment.\n\nI'll leave my details with you — whenever a need comes up, write to me here or call me on {{myPhone|my number}} and I'll be glad to help.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. Thank you for your time today. Whenever a need comes up, message me here and I'll be glad to help.",
  },
  {
    key: "call-second-try",
    name: "Tried you again",
    moment: "AFTER_CALL",
    callResult: "NOT_CONNECTED",
    emailSubject: "Trying to reach you — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nI've tried calling you a couple of times and haven't been able to get through. I don't want to keep interrupting your day — tell me a time that suits you and I'll call then.\n\nYou can also reach me on {{myPhone|my number}} or by replying to this email.\n\nRegards,\n{{myName}}\n{{ourName}}",
    whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}. I've tried calling you a couple of times. Tell me a time that suits you and I'll call then.",
  },
  {
    key: "call-right-person",
    name: "Am I speaking to the right person?",
    moment: "AFTER_CALL",
    callResult: "NOT_CONNECTED",
    emailSubject: "A quick question — {{ourName}}",
    emailBody: "Hi {{firstName|there}},\n\nI'm {{myName}} from {{ourName}}. I tried to reach you about {{companyName}}'s requirements and couldn't get through.\n\nIf somebody else looks after this, could you point me to them? A name or an email address is all I need.\n\nRegards,\n{{myName}}\n{{ourName}}\n{{myPhone|}}",
    whatsappBody: "Hi {{firstName|there}}, I'm {{myName}} from {{ourName}}. I tried to reach you about your company's requirements. If somebody else looks after this, could you point me to them?",
  },
];
