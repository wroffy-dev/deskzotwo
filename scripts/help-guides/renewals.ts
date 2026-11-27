import { note, ol, p, perm, qa, runs, setting, table, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Renewals — written from src/app/(dashboard)/renewals (the list, its split view, Report and Billing check),
 * src/components/renewals (the table, the stage cell, the renew and proposal buttons), src/actions/renewal.ts (what
 * the list holds, renewal tasks, renewal managers), renewal-stage.ts, renewal-order.ts and renewal-proposal.ts (who
 * may pin a stage, punch the renewal and draft its proposal), src/lib/renewals.ts (statuses and stages),
 * src/actions/addon.ts (added seats), src/actions/recurring-billing.ts, src/lib/recurring-billing (billing itself,
 * the Next bill column, Billing check, Monday's drafts reminder), src/lib/renewal-watch*.ts (the reminder ladder,
 * escalation, the automatic task, the Monday list), src/lib/renewal-lapse.ts (lapsed, marked Lost by itself),
 * src/components/settings/renewal-settings.tsx (Settings › Renewals) and the departments that may hold renewals.
 */
export const guide: SeedGuide = {
  slug: "help/renewals",
  title: "Renewals",
  seo: {
    title: "Renewals: track subscription expiries, renew on time and bill every term",
    description:
      "How to see every subscription coming up for renewal in {siteName}, give each one a renewal manager, get reminded before it ends, quote and punch the renewal, and make sure monthly, quarterly and yearly billing is never missed.",
    keywords: ["subscription renewals", "recurring billing", "renewal reminders"],
  },
  guide: {
    module: "renewals",
    heading: "Renewals",
    summary:
      "Every subscription you've sold with an expiry date, soonest first — who looks after each renewal, how far it has got, when it bills next — with reminders before it ends and quick ways to raise a task, quote the next term and punch the renewal order.",
    purpose: [
      p(
        "Renewals lists the subscriptions your customers hold — orders for items managed as a subscription that have an expiry date — with the soonest expiry first. Each row shows the customer, the subscription and its seats, the PO / invoice number, the start and expiry dates, when it bills next, its renewal manager, a status and a stage.",
      ),
      p(runs("The ", { b: "Status" }, " is how long is left: ", { b: "Active" }, ", ", { b: "Expires in" }, " so many days (within 30 days), or ", { b: "Expired" }, ". The ", { b: "Stage" }, " is how far the renewal has got, worked out from what has happened:")),
      ul(
        runs({ b: "Not started" }, " — nothing yet."),
        runs({ b: "Task raised" }, " — an open renewal task names it."),
        runs({ b: "Contacted" }, " — a call has been logged against it."),
        runs({ b: "Quoted" }, " — a proposal, proforma or invoice quotes its next term."),
        runs({ b: "Renewed" }, " — the renewal order has been punched."),
      ),
      p(runs("Three stages leave no trace in the data, so they're set by hand: ", { b: "Negotiating" }, ", ", { b: "On hold" }, " and ", { b: "Lost" }, ".")),
      p(
        runs(
          "Every renewal belongs to somebody: the customer's ",
          { b: "renewal manager" },
          " if it has one, otherwise its account manager. That person is reminded as the end comes near, and their manager — then the admins — hear about it if nobody has started it in time.",
        ),
      ),
      p("A renewal isn't a separate record: it's the order the subscription was punched on, so opening one shows that order. Seats added mid-term end with their subscription and are counted in its row rather than listed on their own."),
      note(runs("Only items managed as a subscription come up here — see ", ["Items & Inventory", "/help/items-and-inventory"], ". Goods and one-time services never renew.")),
    ],
    access: [
      p("Renewals uses the same permission as Orders: anybody who can view orders can open it, and sees the subscriptions on the customers they can see — every customer's with See every account, not just your own; otherwise their own accounts and their reports'."),
      p("Anybody who can open Renewals can raise renewal tasks, and open Report and Billing check. The rest of the row's actions have their own rules:"),
      ul(
        "Pinning a stage and punching the renewal order — people allowed to edit products & subscriptions, or to process orders.",
        "Drafting a renewal proposal — people allowed to raise and issue sales documents.",
        "Writing to the customer — people allowed to edit products & subscriptions, process orders, or send campaigns.",
        "Adding seats to a subscription — people allowed to process orders.",
        "Choosing a customer's renewal manager — people who may change its account manager: anyone holding Reassign accounts and leads, or its account manager when allowed to hand on their own accounts.",
        "Switching recurring billing on or off — people allowed to raise and issue sales documents.",
      ),
      p("Drafts waiting on Billing check are shown only to people who can see sales documents."),
    ],
    permissions: [
      perm("orders.view", "Opens Renewals (and Orders), its Report and Billing check, and a customer's Products & Subscriptions and Renewals tabs. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.renewals", "Shows Renewals in its own menu group and lets people open it. Every role has it until an admin unticks it for one."),
      perm("products.edit", "Pin a renewal's stage, punch the renewal order and send the customer a renewal reminder — and change a subscription's quantity, dates and notes on the customer's Products & Subscriptions tab. Management and Sales have it by default."),
      perm("orders.process", "Does the same as editing products & subscriptions here, and also adds seats to a subscription mid-term. Purchase and Management have it by default."),
      perm("docs.createProposal", "Draft a renewal proposal for the next term. Sales, Accounts and Management have it by default."),
      perm("docs.createInvoice", "Set up a subscription's recurring billing, which raises draft tax invoices. Whoever may issue tax invoices is told when it raises drafts, and reminded on Mondays of drafts still waiting. Sales, Accounts and Management have it by default."),
      perm("documents.view", "See the drafts recurring billing raised on Billing check. Sales, Accounts and Management have it by default."),
      perm("accounts.reassign", "Choose any customer's renewal manager, one at a time or for a selection of renewals, as well as its account manager. Management has it by default."),
      perm("settings.manage", "Change Settings › Renewals: the reminders, who hears when nobody started a renewal, the automatic task, the customer's own reminder and when an unrenewed subscription is marked Lost."),
    ],
    setup: [
      p(runs("For a subscription to appear, its item must be ticked ", { b: "Manage as a subscription" }, " and its order must have an expiry date — set by the ", { b: "Term" }, " or ", { b: "Expiry date" }, " when the order is punched.")),
      p(runs("A yearly service such as an AMC or a support contract is watched the same way once its item is ticked. ", { b: "Services not watched" }, " on Renewals lists the services that look as if they renew and are not ticked; choose ", { b: "Watch for renewal" }, " or ", { b: "It doesn’t renew" }, " for each.")),
      p("Make sure every customer has an account manager, or a renewal manager if somebody else looks after its renewals. A customer with neither (or whose people have left) is reminded to the people chosen in Settings › Renewals — every admin until you choose."),
      p(runs("To limit who can be made a renewal manager, open ", { b: "Settings › Departments" }, " and tick ", { b: "Renewal manager" }, " on the departments whose members may hold renewals. While no department is ticked, anyone can be; whoever holds a customer already keeps it.")),
      p(runs("Then decide how each subscription is billed — see ", { b: "Bill every term without missing one" }, " below — and check the reminders in Settings › Renewals.")),
    ],
    tasks: [
      task(
        "See what's coming up",
        ol(
          runs("Open ", { b: "Renewals" }, "."),
          runs(
            "Choose a ",
            { b: "Window" },
            ": ",
            { b: "Expired" },
            "; ",
            { b: "Lapsed — not renewed" },
            " (ended, not renewed and nobody has marked it); ",
            { b: "At risk — not started" },
            " (ending within 30 days with no call, no quote and nothing marked); or expiring in 30, 60 or 90 days.",
          ),
          runs("Choose a ", { b: "Renewal manager" }, " to see one person's renewals, or ", { b: "Nobody" }, " for those nobody looks after. Search by company name."),
          runs("Use ", { b: "Columns" }, " to choose what the table shows, or switch to the split view to read each subscription's order beside the list."),
        ),
      ),
      task(
        "Give a customer's renewals to somebody",
        p(runs("A customer's renewals go to its account manager until you choose otherwise. On the customer's page, select the ", { b: "Renewals: account manager" }, " chip at the top, pick the person and save — the chip then reads ", { b: "Renewal manager: " }, "and their name.")),
        p(runs("For many at once, tick renewals on the list and choose ", { b: "Set renewal manager…" }, " in the bar. ", { b: "Back to the account manager" }, " hands them back. Every change is in the activity log, and the person given them is notified.")),
      ),
      task(
        "Raise renewal tasks",
        ol(
          "Tick the subscriptions to chase.",
          runs("In the bar, choose who to ", { b: "Assign to" }, " (or nobody) and, if you like, a due date — left blank, each task is due on its subscription's expiry date."),
          runs("Select ", { b: "Create renewal tasks" }, "."),
        ),
        p("Each task is called “Renew <product> — <customer>”. A subscription that already has an open renewal task is skipped, so running it again doesn't make duplicates. The stage moves to Task raised. With the automatic task on (Settings › Renewals), the renewal manager is given one by itself, 45 days before the end."),
      ),
      task(
        "Quote the next term",
        p(runs("Select the proposal icon on the row (", { b: "Draft a renewal proposal for" }, " the customer). A draft proposal for the next term is made from the subscription, its added seats and its full-term price; select ", { b: "Open it" }, " to check and send it. The stage moves to Quoted.")),
      ),
      task(
        "Punch the renewal order",
        ol(
          runs("Select the renew icon on the row (", { b: "Punch the renewal order" }, ")."),
          runs("In ", { b: "Renew this subscription" }, ", check the ", { b: "Quantity" }, " (seats added mid-term included), the ", { b: "Price each, full term" }, ", and when the ", { b: "New term starts" }, " and ends. Add ", { b: "Their PO" }, " and ", { b: "Notes" }, " if you have them."),
          runs("Select ", { b: "Punch renewal" }, "."),
        ),
        p(runs("It's raised as a normal order, pending approval, and goes through accounts and purchase like any other — see ", ["Orders", "/help/orders"], ". The old subscription stays as it was, and the row shows Renewed with the new order's number.")),
      ),
      task(
        "Bill every term without missing one",
        p(runs("A subscription bills itself only if its order says how. Open the order and, under ", { b: "Recurring billing" }, ", choose what matches how the customer pays:")),
        table(
          ["The customer pays", "Set the order up as"],
          [
            [runs("Monthly, on a monthly order"), runs("A one-month term, ", { b: "Renew itself at the end of the term" }, ". On the first day of the next month the renewal order is punched for approval and its invoice drafted.")],
            [runs("Monthly, on a yearly commitment"), runs("One order for the year at the year's price, ", { b: "Invoice the term in parts" }, " — ", { b: "Monthly" }, ". A twelfth is drafted on the first day of each month, to the paisa.")],
            [runs("Quarterly, on a yearly subscription"), runs("One order for the year, ", { b: "Invoice the term in parts" }, " — ", { b: "Quarterly" }, ". A quarter is drafted on the first day of each quarter.")],
            [runs("Yearly, in advance"), runs("Invoice the order as usual. To have next year's raised by itself, choose ", { b: "Renew itself at the end of the term" }, ".")],
          ],
        ),
        p("Nothing is issued by itself: each draft waits for somebody to check and issue it. Whoever issues sales documents is told the day drafts are raised, and reminded every Monday of any still waiting three days or more. Deleting a draft skips that part for good."),
        p(runs("The ", { b: "Next bill" }, " column shows when each subscription invoices itself next — the next part, or the day it renews — or why it won't: ", { b: "Not set" }, ", ", { b: "Held up" }, ", ", { b: "Renewed" }, ", ", { b: "Lost" }, ", ", { b: "On hold" }, " or ", { b: "All parts raised" }, ".")),
        note(runs("A renewal punched by Renew itself starts with the switch off, so each new term renews itself only if somebody chooses it again. Marking a renewal Lost switches it off; On hold pauses it.")),
      ),
      task(
        "Check nothing is left unbilled",
        p(runs("Select ", { b: "Billing check" }, " at the top of Renewals. It lists:")),
        ul(
          runs({ b: "Nothing set to bill" }, " — running subscriptions with recurring billing off that aren't invoiced in full, or a month's term ending soon that is renewed by hand."),
          runs({ b: "Held up" }, " — switched on, but it can't bill when it falls due, and why: no price, no term dates, no site to renew to, or a reseller not yet through onboarding."),
          runs({ b: "Drafts waiting to be issued" }, " — drafts recurring billing raised that nobody has issued, oldest first."),
        ),
        p("Open each order from the list to switch its billing on or fill the gap, and issue the drafts from the invoice list."),
      ),
      task(
        "See what was renewed and lost",
        p(runs("Select ", { b: "Report" }, " at the top of Renewals. For a run of months — the last 12, this financial year or last — it shows how many subscriptions came up, were renewed, lost or are still open, what they were worth, the renewal rate, why the lost ones went, and the same by month, by product and by salesperson.")),
      ),
      task(
        "Set a stage by hand",
        ol(
          "Select the stage on the row.",
          "If you like, type why in the box — for example “lost on price”.",
          runs("Under ", { b: "Set the stage by hand" }, ", choose ", { b: "Negotiating" }, ", ", { b: "On hold" }, " or ", { b: "Lost" }, ". It's saved at once, with your note."),
        ),
        p(runs("A stage set by hand wins over the worked-out one, with one exception: once the renewal order is punched, the row shows Renewed. To hand it back, choose ", { b: "Clear — go back to what the record says" }, ".")),
      ),
      task(
        "Remind the customer",
        p(runs("Select the mail icon on the row (", { b: "Send a renewal reminder" }, "; once renewed, ", { b: "Confirm the renewal" }, "). Choose which contacts to write to, the ", { b: "Wording" }, ", and ", { b: "Add a line of your own" }, " if you like, then send it. Contacts who can't be written to are listed with the reason.")),
        p("To have the reminder sent by itself, switch it on in Settings › Renewals."),
      ),
      task(
        "Add seats mid-term",
        p(runs("On the customer's ", { b: "Products & Subscriptions" }, " tab, select ", { b: "Add seats" }, " on the subscription. Enter ", { b: "How many extra" }, ", ", { b: "From" }, " when, the ", { b: "Full-year price a seat" }, " and ", { b: "What we pay for it" }, ", then add them. The seats are raised as their own order through the usual approval, end with the subscription, and come back with it at renewal.")),
      ),
    ],
    settings: [
      setting(
        "Before a subscription ends",
        "Settings › Renewals",
        p(runs({ b: "Remind the renewal manager, days before it ends" }, " — days separated by commas; 60, 30, 15, 7, 1 to begin with. Empty reminds nobody.")),
        p(runs({ b: "Tell their manager when it isn't started" }, " and ", { b: "Tell the admins when it still isn't started" }, " — so many days before the end, if there has been no call, no proposal, proforma or invoice, and nobody marked it Negotiating or On hold.")),
        p(runs({ b: "Raise a renewal task for the renewal manager" }, " — so many days before the end, once a term, due a week before it ends.")),
        p(runs({ b: "Who hears about renewals nobody looks after" }, " — for customers with no renewal manager or account manager still here. Nobody chosen means every admin.")),
        p("Every Monday, each renewal manager gets their list — due within 30 days, not started, lapsed — and each manager their team's."),
      ),
      setting(
        "Reminding the customer",
        "Settings › Renewals",
        p(
          runs(
            { b: "Email the customer the renewal reminder by itself" },
            ", so many days before it ends: to the company's primary contact and its billing contacts, and the reseller's on a reseller's order. Not when one went since, not for a renewal renewed, Lost or On hold, and never to a contact who unticked renewal reminders.",
          ),
        ),
      ),
      setting(
        "When a subscription isn't renewed",
        "Settings › Renewals",
        p("The day after it ends, the account's owner is told it lapsed, and it appears under Lapsed — not renewed."),
        p(runs({ b: "Mark it Lost by itself if still nobody has renewed or marked it" }, " after so many days. A renewal somebody marked Negotiating or On hold is theirs to decide and never marked Lost by this.")),
      ),
      setting(
        "Recurring billing",
        "On a subscription's order",
        p(runs({ b: "Off" }, " (by hand), ", { b: "Renew itself at the end of the term" }, ", or ", { b: "Invoice the term in parts" }, " — ", { b: "Monthly" }, ", ", { b: "Quarterly" }, " or ", { b: "Yearly" }, ", from a day you choose. Parts before that day are left as they were invoiced.")),
      ),
      setting("Renewal manager", "Settings › Departments", p("Which departments' people may be made a customer's renewal manager. None ticked means anyone.")),
      setting("Wording", "Settings › Wording", p("Your own word for a renewal, used in the menu, headings and buttons.")),
      setting(
        "A renewal is coming up",
        "Settings › Notification preferences",
        p("The reminders and escalations about renewals. Each person can switch them off for themselves; Settings › Email notifications decides whether they are emailed too."),
      ),
      setting("Recurring billing raised drafts", "Settings › Notification preferences", p("The day's notice of drafts recurring billing raised, and Monday's reminder of drafts still waiting.")),
    ],
    faq: [
      qa(
        "A subscription I sold isn't in Renewals.",
        p("Check that its item is managed as a subscription and that the order has an expiry date. Seats added mid-term appear in their subscription's row, not on their own. And you only see the subscriptions on customers you can see."),
      ),
      qa("A customer pays monthly but signed for a year. How do I set that up?", p("One order for the year at the year's price, with recurring billing set to Invoice the term in parts, Monthly. Each month's twelfth is drafted on its first day. For quarterly payments choose Quarterly.")),
      qa("The Next bill column says Not set.", p("Recurring billing is off on that order, so it is billed only by hand. Open the order and switch it on, or check Billing check for the ones not invoiced in full.")),
      qa("It says Held up.", p("Recurring billing is on, but something it needs is missing — Billing check says what: a price, the term's dates, a site to renew to, or the reseller's onboarding.")),
      qa("I deleted a draft by mistake.", p("A deleted draft skips that part for good — recurring billing won't raise it again. Raise that part's invoice by hand from the order.")),
      qa("Why can't I set the stage to Quoted or Contacted?", p("Those stages are worked out from what has happened, so they can't be set by hand. Only Negotiating, On hold and Lost can.")),
      qa("I set the stage to Lost, but it shows Renewed.", p("Once the renewal order is punched, the row shows Renewed whatever was set by hand, and says the stage you set was overtaken.")),
      qa("It says the subscription is already renewed.", p("A renewal order has already been punched for it. If that one was wrong, cancel it first and punch the renewal again.")),
      qa("Who gets the reminders when the account manager has left?", p("The customer's renewal manager if it has one; otherwise the people chosen under Who hears about renewals nobody looks after, in Settings › Renewals — every admin until somebody is chosen.")),
      qa(
        "I don't see Renewals in the menu.",
        p("Either the module is switched off for your company, your role has had the section hidden, or you don't hold View orders. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions."),
      ),
    ],
    related: ["orders", "items", "sales_documents", "tasks"],
  },
};
