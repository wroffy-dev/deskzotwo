import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Internal help desk — written from src/app/(dashboard)/help-desk, src/app/(dashboard)/desks, src/components/desks,
 * src/lib/desks (who sees a request, the clock, how new ones are given out) and src/actions/desks.ts.
 */
export const guide: SeedGuide = {
  slug: "help/internal-help-desk",
  title: "Internal help desk",
  seo: {
    title: "Internal help desk: ask IT, admin or accounts and follow it",
    description: "How to ask a team inside your company for help in {siteName}, how a desk's people pick up and answer requests, and how to set desks up.",
    keywords: ["internal help desk", "IT requests", "employee requests"],
  },
  guide: {
    module: "desks",
    heading: "Internal help desk",
    summary: "Employees ask a team inside the company, such as IT, admin or accounts, and follow the request until it's put right. It's kept apart from customers' tickets.",
    purpose: [
      p("A laptop that keeps shutting down, a lost access card, a copy of an invoice: things you need from a colleague's team rather than from a customer or a vendor. You ask a desk, its people pick the request up, and everything said about it stays in one place."),
      p("Each desk belongs to one of your departments and has its own list, its own kinds of request and its own times to answer in."),
      note(runs("Customers' problems are tickets, with their own page: see ", ["Helpdesk and tickets", "/help/helpdesk"], ". Questions about leave or payslips go to the HR desk on My HR, where your company has it switched on.")),
    ],
    access: [
      p("Everybody who works in the company can ask a desk. A request is seen by:"),
      ul("whoever asked,", "the people in that desk's department, and", "the workspace's super admin."),
      p("Some requests need approval. Whoever approves one sees what was asked and its files, and none of the conversation or the desk's notes. A kind your company approves first isn't seen by the desk until it's approved."),
      p("Nobody else sees it: not your manager (unless they approve it), not other admins, and not somebody viewing as you. When a request moves to another desk, the new desk's people see it and the old desk's don't."),
      p("If you ask the desk you work at yourself, you're only the one who asked: you don't see its notes or work on it."),
    ],
    permissions: [
      perm("section.desks", "Shows Help desk in the menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("settings.manage", "Lets somebody set desks up. It doesn't show them any request."),
    ],
    setup: [
      p("Until a desk is set up, Help desk isn't in anybody's menu."),
      ol(
        runs("Make sure the people who will answer are in one department (", { b: "Settings › Departments" }, " and ", { b: "Settings › Users" }, ")."),
        runs("Open ", { b: "Settings › Help desk" }, " and select ", { b: "Add a desk" }, "."),
        "Give it a name and the department that answers.",
        "List what people can ask for, and change the times if you need to.",
        runs("Select ", { b: "Add desk" }, "."),
      ),
      p("The desk's people then have its list under Support, and everybody else has Help desk under My work."),
    ],
    tasks: [
      task(
        "Ask a desk",
        ol(
          runs("Open ", { b: "My work › Help desk" }, " and choose a desk."),
          "Choose what it's about, say it in one line, and describe what happens.",
          runs("Under ", { b: "How much is it holding you up?" }, ", choose one. It decides how soon you hear back."),
          "Add a photo or file if it helps, and send it.",
        ),
        p("You're told in the bell, and by email unless an admin has switched that off, each time the desk replies or the request changes."),
      ),
      task(
        "Follow or close your request",
        p(runs("Open it from ", { b: "My requests" }, " and reply there. If it's sorted, select ", { b: "It's sorted, close it" }, ". A reply within 14 days of it being resolved opens it again; after that, make a new one.")),
      ),
      task(
        "Work on your desk's requests",
        ol(
          "Open your desk's list under Support.",
          runs("Select ", { b: "Pick up" }, " on one nobody has."),
          runs("Reply to the person, or use ", { b: "Note for the desk" }, " for something only the desk sees."),
          runs("Change ", { b: "Status" }, " as it moves: waiting for them, on hold, resolved. The clock stops while it's waiting or on hold."),
          runs("Give it to a colleague with ", { b: "With" }, ", or move it with ", { b: "Desk" }, "."),
        ),
      ),
      task(
        "Approve a request",
        p(runs("What waits for you is under ", { b: "Help desk" }, ", ", { b: "Approvals" }, " and on Today. Open it, and choose ", { b: "Approve" }, " or ", { b: "Don't approve" }, ". Your manager approves the kinds marked so in settings; with no manager, the super admin does. A desk can also ask anybody to approve something, saying why.")),
      ),
      task(
        "Use steps, approval and the asset on a request",
        ul(
          runs({ b: "Steps" }, " are the desk's own list of what to do, seen by the desk and the super admin. Give one to a colleague on the desk and it shows on their Today."),
          runs({ b: "Ask for approval" }, " sends your reason to a colleague. The clock stops until they answer."),
          runs({ b: "Send for repair" }, " moves the asset in the asset register, for whoever may move assets. What your desk was asked about it before is listed beside it."),
        ),
      ),
      task("Raise a request for a colleague", p(runs("On your desk's list, select ", { b: "Raise for a colleague" }, " and choose who it's for. It's their request: they see it and are told about it."))),
    ],
    settings: [
      setting("Department that answers", "Settings › Help desk", p("Its people see the desk's requests. Somebody who joins or leaves the department gains or loses them at once.")),
      setting("New requests go to", "Settings › Help desk", p("The whole desk (the first to pick one up has it), one person, or each person in turn.")),
      setting("What people can ask for", "Settings › Help desk", p("The kinds of request. One can ask which of the person's company assets it's about. A kind that has been used can be switched off, and stays on the requests that used it.")),
      setting("Approval", "Settings › Help desk", p("For each kind: no approval, or their manager approves it before the desk sees it.")),
      setting("Times", "Settings › Help desk", p("The first reply and the fix, for each answer to how much it holds somebody up. They count your office hours, Monday to Saturday, with holidays off; or the clock's own hours while no office hours are set in Attendance.")),
      setting("Also told when one is overdue", "Settings › Help desk", p("One of the desk's people, told as well as whoever has the request.")),
      setting("Taking new requests", "Settings › Help desk", p("Untick to stop new requests. The ones already there can still be read and finished.")),
    ],
    faq: [
      qa("Can my manager see what I asked?", p("Only if they're asked to approve it, and then what you asked, not the conversation. Otherwise only you, the desk's people and the super admin can.")),
      qa("Can the person I asked leave notes I can't see?", p("Yes. A note for the desk, and any file on it, is seen by the desk's people and the super admin.")),
      qa("Who gets a request when somebody leaves?", p("It goes back to the desk, whose people are told, and one of them picks it up.")),
      qa("Why can't I find a desk?", p("A desk shows only while it's taking requests and somebody is in its department.")),
      qa("Why can't I delete a desk?", p("Somebody has asked it for something. Untick Taking new requests instead.")),
    ],
    related: ["helpdesk", "hr"],
  },
};
