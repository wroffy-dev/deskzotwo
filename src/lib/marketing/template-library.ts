import type { MarketingTopic } from "@prisma/client";
import { newBlockId, renderDesign, replyLink, safeColor, type Block, type BuilderBrand, type Design } from "@/lib/marketing/email-design";

/**
 * Ready-made email templates (owner, 1 Nov 2026: "some ready made templates for marketing… also a subscription renewal
 * notice"). Marketing › Templates › Template library shows them; "Use this template" saves one in the workspace's own
 * look — its logo, brand colour, email and phone — as an ordinary template, which opens in the email builder to edit
 * (src/actions/email-builder.ts).
 *
 * Each is a builder design (src/lib/marketing/email-design.ts), so the library, the builder and what is sent draw it
 * the same way. Every `{{field}}` is a merge field (src/lib/marketing/merge.ts), and any a recipient may lack has a
 * fallback, so none of these ever stops a send for a missing value. Words in [square brackets] are the sender's to
 * replace before sending.
 */

export type LibraryBrand = BuilderBrand;
export { safeColor };

export type LibraryCategory = "Renewals" | "Payments" | "Customers" | "Offers" | "Product news" | "Events" | "Newsletters";

export type LibraryTemplate = {
  key: string;
  name: string;
  category: LibraryCategory;
  topic: MarketingTopic;
  description: string;
  subject: string;
  preheader: string;
  /** The template as a builder design, in the workspace's look. */
  design: (brand: LibraryBrand) => Design;
  /** The whole HTML document it sends. */
  html: (brand: LibraryBrand) => string;
};

// Small makers, so each template below reads as its blocks.
const logo = (): Block => ({ id: newBlockId(), type: "logo", align: "left", bar: true });
const heading = (text: string, level: 1 | 2 = 1): Block => ({ id: newBlockId(), type: "heading", text, level, align: "left" });
const text = (...paragraphs: string[]): Block => ({ id: newBlockId(), type: "text", html: paragraphs.map((x) => `<p>${x}</p>`).join(""), align: "left", size: 15 });
const small = (paragraph: string): Block => ({ id: newBlockId(), type: "text", html: `<p>${paragraph}</p>`, align: "left", size: 13, color: "#6b7280" });
const button = (label: string, link: string): Block => ({ id: newBlockId(), type: "button", label, link, align: "left", full: false });
const details = (title: string, rows: [string, string][]): Block => ({ id: newBlockId(), type: "details", title, rows: rows.map(([label, value]) => ({ label, value })) });
const checklist = (title: string, items: string[]): Block => ({ id: newBlockId(), type: "checklist", title, items });
const columns = (...cols: [string, string][]): Block => ({ id: newBlockId(), type: "columns", columns: cols.map(([title, t]) => ({ title, text: t })) });
const banner = (eyebrow: string, title: string, subtitle = ""): Block => ({ id: newBlockId(), type: "banner", eyebrow, title, subtitle, align: "center" });
const divider = (): Block => ({ id: newBlockId(), type: "divider", thickness: 1 });
const signature = (): Block => ({ id: newBlockId(), type: "signature", closing: "Warm regards,", contacts: true });
const design = (...blocks: Block[]): Design => ({ version: 1, settings: { font: "arial" }, blocks });

const renewalRows: [string, string][] = [
  ["Product", "{{productName|Your subscription}}"],
  ["Quantity", "{{quantity|As on your current subscription}}"],
  ["Renews on", "{{expiryDate|We'll confirm}} {{daysLeftPhrase|}}"],
  ["Renewal value", "{{renewalValue|We'll confirm}}"],
  ["Reference", "{{orderId|—}}"],
];

/** What's owed on an order, as a payment reminder fills it in (src/lib/marketing/customer-notices.ts PAYMENT_NOTICE). */
const paymentRows: [string, string][] = [
  ["Order", "{{orderId|Your order}}"],
  ["Product", "{{productName|As on your order}}"],
  ["Quantity", "{{quantity|As on your order}}"],
  ["Order total", "{{orderTotal|As on your invoice}}"],
  ["Paid so far", "{{amountPaid|As per our records}}"],
  ["Balance due", "{{balanceDue|As on your invoice}}"],
];

type Entry = Omit<LibraryTemplate, "html">;

const ENTRIES: Entry[] = [
  // ─── Renewals ────────────────────────────────────────────────────────────────────────────────
  {
    key: "renewal-notice",
    name: "Subscription renewal notice",
    category: "Renewals",
    topic: "RENEWALS",
    description: "The subscription, its quantity, renewal date and value, and a button to confirm. For the 60/30/15-day reminders.",
    subject: "Your {{productName|subscription}} renews on {{expiryDate|its renewal date}}",
    preheader: "Here are the details — nothing to do if you'd like it to carry on.",
    design: (b) =>
      design(
        logo(),
        heading("Your subscription is coming up for renewal"),
        text("Hi {{firstName|there}},", "{{companyName|Your company}}'s subscription is due for renewal soon. Here are the details, so there are no surprises:"),
        details("Renewal details", renewalRows),
        text("If you'd like to carry on as you are, just reply to confirm and we'll take care of the rest. If you need to add or remove licences, change the plan, or have any questions, we're happy to help."),
        button("Confirm my renewal", replyLink(b, "Renewal confirmation — {{productName|subscription}}")),
        signature(),
      ),
  },
  {
    key: "renewal-final",
    name: "Renewal — final reminder",
    category: "Renewals",
    topic: "RENEWALS",
    description: "A short, firmer reminder for the last few days, so users don't lose access.",
    subject: "Final reminder: {{productName|your subscription}} ends {{expiryDate|soon}}",
    preheader: "Renew now so your team doesn't lose access.",
    design: (b) =>
      design(
        logo(),
        heading("Final reminder: please renew to avoid interruption"),
        text("Hi {{firstName|there}},", "{{companyName|Your company}}'s {{productName|subscription}} ends on <strong>{{expiryDate|its renewal date}}</strong>. {{daysLeftPhrase|}}"),
        checklist("Renew in time to keep", ["Your users signed in and working", "Your data, settings and licences as they are", "Your current pricing"]),
        text("It only takes a reply to confirm. If you've decided not to renew, let us know and we'll help you plan the change."),
        button("Renew now", replyLink(b, "Renew {{productName|subscription}}")),
        signature(),
      ),
  },
  {
    key: "renewal-lapsed",
    name: "Renewal — subscription lapsed",
    category: "Renewals",
    topic: "RENEWALS",
    description: "For a subscription whose end date has passed: what it means and how to bring it back.",
    subject: "Your {{productName|subscription}} has expired — we can restore it",
    preheader: "Reply and we'll get your team back up and running.",
    design: (b) =>
      design(
        logo(),
        heading("Your subscription has expired"),
        text(
          "Hi {{firstName|there}},",
          "{{companyName|Your company}}'s {{productName|subscription}} ended on {{expiryDate|its renewal date}}. {{daysLeftPhrase|}}",
          "Depending on the product, your users may already have lost access, and some data is kept only for a limited time after expiry. The sooner it's renewed, the simpler it is to restore.",
        ),
        button("Restore my subscription", replyLink(b, "Restore {{productName|subscription}}")),
        small("If you've moved to something else, just let us know — we'd value hearing why."),
        signature(),
      ),
  },
  {
    key: "renewal-thanks",
    name: "Thank you for renewing",
    category: "Renewals",
    topic: "SERVICE",
    description: "Confirms the renewal, with the new term, and thanks the customer.",
    subject: "Thank you — your {{productName|subscription}} is renewed",
    preheader: "Your renewal is confirmed. Here's your new term.",
    design: () =>
      design(
        logo(),
        heading("Thank you for renewing with us"),
        text("Hi {{firstName|there}},", "{{companyName|Your company}}'s subscription has been renewed. Thank you for continuing to trust us — here's what's in place:"),
        details("Your new term", [
          ["Product", "{{productName|Your subscription}}"],
          ["Quantity", "{{quantity|As before}}"],
          ["Term starts", "{{startDate|Now}}"],
          ["Runs until", "{{expiryDate|We'll confirm}}"],
          ["Reference", "{{orderId|—}}"],
        ]),
        text("There's nothing more you need to do. If anything changes in your team, reach out and we'll adjust your licences."),
        signature(),
      ),
  },

  // ─── Payments ────────────────────────────────────────────────────────────────────────────────
  // Service notices (owner, 4 Nov 2026): once added, offered under Wording when sending a payment reminder from
  // Payments, which fills in the order and what's owed on it.
  {
    key: "payment-friendly",
    name: "Payment reminder — friendly",
    category: "Payments",
    topic: "SERVICE",
    description: "A gentle first nudge: the order, what's been paid and what's still due. For a customer who has probably just overlooked it.",
    subject: "A quick reminder: {{balanceDue|a payment}} due on {{orderId|your order}}",
    preheader: "The details are below, in case it slipped through.",
    design: (b) =>
      design(
        logo(),
        heading("A quick reminder about your payment"),
        text("Hi {{firstName|there}},", "Hope you're doing well. A payment is still open on {{companyName|your company}}'s order, so here are the details in case it slipped through:"),
        details("Payment details", paymentRows),
        text("If it's already on its way, thank you — just reply with the payment reference so we can match it on our side."),
        button("Reply with the details", replyLink(b, "Payment for {{orderId|my order}}")),
        signature(),
      ),
  },
  {
    key: "payment-second",
    name: "Payment reminder — second notice",
    category: "Payments",
    topic: "SERVICE",
    description: "Firmer, and asks for a date: when the first reminder had no reply.",
    subject: "Second reminder: {{balanceDue|payment}} outstanding on {{orderId|your order}}",
    preheader: "Please let us know when we can expect it.",
    design: (b) =>
      design(
        logo(),
        heading("Your payment is still outstanding"),
        text("Hi {{firstName|there}},", "We wrote to you earlier about this payment and our records still show it open. Could you please let us know when we can expect it?"),
        details("Payment details", paymentRows),
        checklist("It helps us if you can tell us", ["The date the payment will be made", "The payment reference, if it has already gone", "Anything holding it up, such as a missing document"]),
        button("Share a payment date", replyLink(b, "Payment date for {{orderId|my order}}")),
        signature(),
      ),
  },
  {
    key: "payment-balance",
    name: "Part payment received — balance due",
    category: "Payments",
    topic: "SERVICE",
    description: "Thanks them for what's come in, and says what's left.",
    subject: "Thank you for your payment — {{balanceDue|a balance}} remains on {{orderId|your order}}",
    preheader: "We've received part of it; here's what is left.",
    design: (b) =>
      design(
        logo(),
        heading("Thank you — we've received part of your payment"),
        text("Hi {{firstName|there}},", "Thank you for the payment against {{companyName|your company}}'s order. A balance is still open, and the figures are below:"),
        details("Where it stands", paymentRows),
        text("If the balance is held back for a reason, such as TDS or a short delivery, reply and let us know so we can record it correctly."),
        button("Reply about the balance", replyLink(b, "Balance on {{orderId|my order}}")),
        signature(),
      ),
  },
  {
    key: "payment-paid-check",
    name: "Already paid? Help us match it",
    category: "Payments",
    topic: "SERVICE",
    description: "For when they may have paid and it hasn't been matched: asks for the transaction details, without chasing.",
    subject: "Have you already paid for {{orderId|your order}}?",
    preheader: "If so, the payment reference is all we need.",
    design: (b) =>
      design(
        logo(),
        heading("Have you already paid this?"),
        text("Hi {{firstName|there}},", "We can't yet match a payment to the order below. If you've already paid, thank you, and we're sorry to trouble you. Sending us these details will let us close it:"),
        details("What we have open", paymentRows),
        checklist("What we need", ["The payment date and amount", "The UTR or transaction reference", "The bank account it was paid from"]),
        button("Send the payment details", replyLink(b, "Payment details for {{orderId|my order}}")),
        signature(),
      ),
  },
  {
    key: "payment-final",
    name: "Payment — final notice",
    category: "Payments",
    topic: "SERVICE",
    description: "The last reminder before you act, in plain words. Edit the second paragraph to say what happens next at your company.",
    subject: "Final notice: {{balanceDue|payment}} overdue on {{orderId|your order}}",
    preheader: "Please pay or get in touch to avoid any disruption.",
    design: (b) =>
      design(
        logo(),
        heading("Final notice: payment overdue"),
        text(
          "Dear {{firstName|Sir/Madam}},",
          "Despite our earlier reminders, the payment below is still open. Please make the payment, or get in touch with {{ownerName|your account manager}} right away, so that we can avoid any disruption to your services.",
        ),
        details("Payment overdue", paymentRows),
        text("If there is a dispute or a difficulty with this payment, tell us now and we'll work through it with you."),
        button("Contact us about this", replyLink(b, "Final notice — {{orderId|my order}}")),
        signature(),
      ),
  },
  // ─── Customers ───────────────────────────────────────────────────────────────────────────────
  {
    key: "welcome",
    name: "Welcome a new customer",
    category: "Customers",
    topic: "SERVICE",
    description: "Thanks a new customer and introduces their account manager and how to get help.",
    subject: "Welcome to {{ourName}}, {{companyName|and thank you}}",
    preheader: "Here's who to call and what happens next.",
    design: (b) =>
      design(
        logo(),
        heading("Welcome aboard!"),
        text("Hi {{firstName|there}},", "Thank you for choosing {{ourName}}. We're glad to be working with {{companyName|you}}, and we want this to be easy from day one."),
        columns(
          ["Your account manager", "{{ownerName|Our team}} looks after your account — one person who knows your setup."],
          ["Getting help", "Reply to any email from us, or write to us and we'll come back to you quickly."],
          ["What's next", "We'll be in touch to make sure everything is set up the way you need it."],
        ),
        button("Say hello", replyLink(b, "Hello from {{companyName|a new customer}}")),
        signature(),
      ),
  },
  {
    key: "service-update",
    name: "Service update / announcement",
    category: "Customers",
    topic: "SERVICE",
    description: "Tells customers about a change — a new partnership, process, address or team — and what it means for them.",
    subject: "An update from {{ourName}}",
    preheader: "Nothing changes for your services — here's what's new.",
    design: (b) =>
      design(
        logo(),
        heading("An update on how we work with you"),
        text("Hi {{firstName|there}},", "We'd like to let you know about a change at {{ourName}}: <strong>[describe the change in one or two sentences]</strong>."),
        checklist("What this means for you", ["Your current services carry on without interruption", "Your contacts and account manager stay the same", "You don't need to do anything"]),
        text("We're making this change to [the reason — better pricing, faster support, a wider range]. As always, we're here if you have any questions."),
        button("Ask us a question", replyLink(b, "Question about the update")),
        signature(),
      ),
  },
  {
    key: "feedback-request",
    name: "Feedback request",
    category: "Customers",
    topic: "SERVICE",
    description: "Asks how you're doing, with a one-click rating by reply.",
    subject: "How are we doing, {{firstName|there}}?",
    preheader: "Two minutes of your time would help us a lot.",
    design: (b) => {
      const rate = (label: string) => ({ label, url: `mailto:${b.email ?? "hello@example.com"}?subject=Feedback:%20${label.replace(/ /g, "%20")}` });
      return design(
        logo(),
        heading("How are we doing?"),
        text("Hi {{firstName|there}},", "We'd love to know how working with {{ourName}} has been for {{companyName|you}}. How likely are you to recommend us to a colleague?"),
        { id: newBlockId(), type: "social", align: "left", links: [rate("Not likely"), rate("Maybe"), rate("Likely"), rate("Very likely")] },
        text("Just click one — or reply with anything we could do better. Every answer is read by a real person."),
        signature(),
      );
    },
  },

  // ─── Offers ──────────────────────────────────────────────────────────────────────────────────
  {
    key: "special-offer",
    name: "Special offer",
    category: "Offers",
    topic: "OFFERS",
    description: "A limited-time offer with a big headline, three reasons and a button.",
    subject: "{{firstName|Hello}}, a special offer for {{companyName|you}}",
    preheader: "[Offer] — for a limited time only.",
    design: (b) =>
      design(
        logo(),
        banner("Limited-time offer", "[20% off]", "[on what — a product, a plan, a service]"),
        text("Hi {{firstName|there}},", "For a short time, {{companyName|you}} can get <strong>[the offer]</strong>. Here's why it's worth a look:"),
        columns(["[Benefit one]", "[A line on what it saves or makes easier.]"], ["[Benefit two]", "[A line on what it adds.]"], ["[Benefit three]", "[A line on why now.]"]),
        button("Claim the offer", replyLink(b, "Offer enquiry")),
        small("Offer valid until [date]. [Any terms in one line.]"),
        signature(),
      ),
  },
  {
    key: "festive-greetings",
    name: "Festive greetings",
    category: "Offers",
    topic: "OFFERS",
    description: "Warm wishes for Diwali, the New Year or any festival — edit the occasion and the message.",
    subject: "Warm wishes from all of us at {{ourName}}",
    preheader: "Thank you for being with us this year.",
    design: (b) =>
      design(
        logo(),
        { id: newBlockId(), type: "banner", eyebrow: "✨ 🎉 ✨", title: "Happy [Diwali]!", subtitle: "", align: "center", background: tintFor(b) },
        text(
          "Dear {{firstName|friend}},",
          "As we celebrate [the festival], all of us at {{ourName}} want to thank {{companyName|you}} for your trust and partnership. It means a great deal to us.",
          "May this season bring you and your family joy, good health and prosperity.",
        ),
        signature(),
      ),
  },

  // ─── Product news ────────────────────────────────────────────────────────────────────────────
  {
    key: "product-launch",
    name: "New product or service",
    category: "Product news",
    topic: "PRODUCT_NEWS",
    description: "Announces something new: a headline, three features and a call to find out more.",
    subject: "New from {{ourName}}: [product name]",
    preheader: "[One line on what it does for them.]",
    design: (b) =>
      design(
        logo(),
        heading("Introducing [product name]"),
        text("Hi {{firstName|there}},", "We're excited to share something new with {{companyName|you}}: <strong>[product name]</strong> — [one sentence on the problem it solves]."),
        columns(["[Feature one]", "[What it does, in a line.]"], ["[Feature two]", "[What it does, in a line.]"], ["[Feature three]", "[What it does, in a line.]"]),
        button("Book a demo", replyLink(b, "Demo of [product name]")),
        signature(),
      ),
  },

  // ─── Events ──────────────────────────────────────────────────────────────────────────────────
  {
    key: "webinar-invite",
    name: "Event or webinar invitation",
    category: "Events",
    topic: "EVENTS",
    description: "An invitation with the date, time, place and what they'll learn.",
    subject: "You're invited: [event name]",
    preheader: "[Date] · [Online / venue] — save your seat.",
    design: () =>
      design(
        logo(),
        heading("You're invited: [event name]"),
        text("Hi {{firstName|there}},", "We'd love {{companyName|you}} to join us for <strong>[event name]</strong>, where [one sentence on what it's about]."),
        details("Event details", [
          ["Date", "[Thursday, 20 November]"],
          ["Time", "[4:00 – 5:00 pm IST]"],
          ["Where", "[Online — link sent on registration / venue address]"],
          ["Speakers", "[Names and roles]"],
        ]),
        checklist("You'll learn", ["[Takeaway one]", "[Takeaway two]", "[Takeaway three]"]),
        button("Save my seat", "https://[registration link]"),
        signature(),
      ),
  },

  // ─── Newsletters ─────────────────────────────────────────────────────────────────────────────
  {
    key: "monthly-newsletter",
    name: "Monthly newsletter",
    category: "Newsletters",
    topic: "NEWSLETTER",
    description: "A month's news in three short stories, each with a link.",
    subject: "{{ourName}} — what's new this month",
    preheader: "[The month's headline in a line.]",
    design: () =>
      design(
        logo(),
        heading("What's new this month"),
        text("Hi {{firstName|there}}, here's a quick round-up of what's been happening."),
        heading("[Story one headline]", 2),
        text("[Two or three lines on the news — a new product, a customer story, a tip.] <a href=\"https://[link]\">Read more →</a>"),
        divider(),
        heading("[Story two headline]", 2),
        text("[Two or three lines.] <a href=\"https://[link]\">Read more →</a>"),
        divider(),
        heading("[Story three headline]", 2),
        text("[Two or three lines.] <a href=\"https://[link]\">Read more →</a>"),
        text("Have something you'd like us to cover? Just reply — we read every one."),
        signature(),
      ),
  },
  {
    key: "tips-and-updates",
    name: "Tips for getting more from a product",
    category: "Newsletters",
    topic: "PRODUCT_NEWS",
    description: "Practical tips for a product the customer already has — keeps them engaged between renewals.",
    subject: "3 ways to get more from {{productName|your subscription}}",
    preheader: "Small changes your team can make this week.",
    design: (b) =>
      design(
        logo(),
        heading("Get more from {{productName|your subscription}}"),
        text("Hi {{firstName|there}},", "Many teams use only a part of what they already pay for. Here are three quick wins for {{companyName|you}}:"),
        heading("1. [First tip]", 2),
        text("[What to do and why it helps, in two lines.]"),
        heading("2. [Second tip]", 2),
        text("[What to do and why it helps.]"),
        heading("3. [Third tip]", 2),
        text("[What to do and why it helps.]"),
        button("Get a free review of your setup", replyLink(b, "Setup review")),
        signature(),
      ),
  },
];

/** A soft version of the brand colour, for the festive banner. */
function tintFor(b: LibraryBrand): string {
  const n = parseInt(safeColor(b.color).slice(1), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * 0.88);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => mix(v).toString(16).padStart(2, "0")).join("")}`;
}

export const TEMPLATE_LIBRARY: LibraryTemplate[] = ENTRIES.map((e) => ({ ...e, html: (b: LibraryBrand) => renderDesign(e.design(b), b, e.name) }));

export const LIBRARY_CATEGORIES: LibraryCategory[] = ["Renewals", "Payments", "Customers", "Offers", "Product news", "Events", "Newsletters"];

export const libraryTemplate = (key: string) => TEMPLATE_LIBRARY.find((t) => t.key === key) ?? null;
