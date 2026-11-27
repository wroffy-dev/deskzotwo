/**
 * A greeting, a thank-you or a goodbye, answered straight away — no model, no lookup, no credits.
 *
 * Owner, 23 Nov 2026, with a screenshot: on Deskzo's own Ollama (qwen2.5 7B) "Hello" and "Hi" each got "Looked for
 * COM-000123 — not found" and an answer about a company nobody had asked after, and "How are you?" sat on Thinking.
 * A small model with tools reaches for one even when there is nothing to look up. Only a message that is nothing but
 * small talk is answered here; "hi, show me this month's leads" goes to Deskzo AI as usual.
 */

const OFFER = "I can look up your customers, leads, orders and renewals, run a report, or draft a task, a note, a new lead or a change to a lead for you.";

const KINDS: { re: RegExp; reply: (first: string) => string }[] = [
  {
    re: /^(how are (you|u)|how r u|how('?s| is) it going|how are things|what'?s up|sup)$/,
    reply: (first) => `I'm good, thanks${first ? `, ${first}` : ""}! What can I help you with? ${OFFER}`,
  },
  {
    re: /^((hi|hello|hey|hii+|helo|hlo|namaste|namaskar|good (morning|afternoon|evening|day))( there| deskzo( ai)?)?)$/,
    reply: (first) => `Hi${first ? ` ${first}` : ""}! What can I help you with? ${OFFER}`,
  },
  {
    re: /^((thanks|thank you|thank u|thx|ty|thanks a lot|thank you so much|great,? thanks|ok,? thanks|okay,? thanks)( deskzo( ai)?)?)$/,
    reply: () => "You're welcome! Anything else?",
  },
  { re: /^(bye|goodbye|good night|see you|see ya|that'?s all)$/, reply: () => "Bye! I'm here whenever you need me." },
  { re: /^(ok|okay|k|cool|great|nice|fine|got it|alright|sure)$/, reply: () => "Great. Anything else I can help with?" },
];

/** The reply to `text` when it is only small talk, or null when it should go to Deskzo AI. */
export function smallTalkReply(text: string, userName: string): string | null {
  const said = text
    .toLowerCase()
    .replace(/[\s!.?,;:)(🙂😊👋🙏]+$/u, "")
    .replace(/^[\s!.?,;:]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!said || said.length > 40) return null;
  const kind = KINDS.find((k) => k.re.test(said));
  if (!kind) return null;
  const first = userName.trim().split(/\s+/)[0] ?? "";
  return kind.reply(first);
}
