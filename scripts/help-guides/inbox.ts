import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Customer inbox — written from src/app/(dashboard)/inbox (the inbox and Inbox reports), the inbox
 * screen and its settings form (src/components/inbox/inbox-app.tsx, inbox-settings.tsx), src/actions/inbox.ts
 * and inbox-admin.ts (who may do what, refused while viewing as somebody), src/lib/inbox (server.ts: who
 * sees which conversation, round-robin, leads; bot.ts: set answers and hand-over; ai.ts; settings.ts:
 * defaults and limits; team-rules.ts and team.ts: notes, tags, saved replies, blocks, availability, ratings;
 * report.ts: response times), the Settings › Customer inbox page, and src/lib/notifications/catalogue.ts.
 */
export const guide: SeedGuide = {
  slug: "help/inbox",
  title: "Customer inbox",
  seo: {
    title: "Customer inbox: website chat and WhatsApp in one place",
    description: "How to answer website chats and WhatsApp messages from one inbox in {siteName}, set up the chat bubble and its bot, office hours and round-robin, and read response times.",
    keywords: ["customer inbox", "website live chat", "WhatsApp business inbox"],
  },
  guide: {
    module: "inbox",
    heading: "Customer inbox",
    summary: "Website chat and WhatsApp in one inbox. A bot answers first from your own set answers and hands over to a person; your team replies, passes conversations on, and makes a lead or a ticket from any of them.",
    purpose: [
      p("The Customer inbox is where your team talks to customers. Two kinds of channel bring conversations in: a chat bubble on your website, and WhatsApp numbers — a shared number the whole team answers, and reps' own numbers. Each reply goes back the way the customer wrote."),
      p("Each channel can have a bot. It greets the customer, answers from the set answers you write, asks for their name and contact details, and hands over to a person when it can't help. If you switch it on, {siteName} AI can answer what the set answers don't."),
      p("A new customer can become a lead by themselves, and anybody answering can make a lead or a ticket from a conversation. Customers already on file are linked to their company and contact."),
      p(runs({ b: "Inbox reports" }, " shows how quickly customers hear from a person, what the bot handles alone, and how satisfied customers are.")),
      note("The Customer inbox is for customers. Messages between colleagues belong in Chat, which customers never see."),
    ],
    access: [
      p("Anybody with the permission to answer customer conversations can open the inbox. Which conversations they see depends on the channel:"),
      ul(
        "A website chat or the shared WhatsApp number: everybody with the inbox.",
        "A rep's own WhatsApp number: that rep, whoever the conversation is given to, and people allowed to see every conversation.",
      ),
      p(runs("Making a lead from a conversation also needs Leads, and making a ticket needs the permission to create tickets. Without them, the ", { b: "Make lead" }, " or ", { b: "Make ticket" }, " button isn't shown.")),
      p("While an admin is viewing the app as somebody else, they can read the inbox but can't reply or change anything — a reply would go out in that person's name."),
      p(runs("Setting up channels, saved replies and blocks is for admins, in ", { b: "Settings › Customer inbox" }, ".")),
    ],
    permissions: [
      perm("inbox.view", "Opens the Customer inbox and Inbox reports: read and reply to website chats and WhatsApp messages, take or pass on a conversation, add notes and tags, close it, block a nuisance, and make a lead or a ticket from it. Calling, Sales, Sales Manager, Support and Management have it by default."),
      perm("inbox.viewAll", "Also shows the conversations on colleagues' own WhatsApp numbers, and the By person table in Inbox reports. Sales Manager and Management have it by default."),
      perm("section.inbox", "Shows Customer inbox and Inbox reports in the menu, under Support. Every role has it until an admin unticks it for one."),
      perm("settings.manage", "Opens Settings › Customer inbox: the channels, their bots, WhatsApp, saved replies and the blocked list. Only admins have it by default."),
    ],
    setup: [
      p(runs("The Customer inbox is an add-on. Once it's in your plan and switched on, an admin opens ", { b: "Settings › Customer inbox" }, ". Until a channel is added, the inbox says there's nothing to bring conversations in yet.")),
      p(runs({ b: "For website chat:" })),
      ol(
        runs("Under ", { b: "Website chat" }, ", select ", { b: "Add a website" }, "."),
        runs("Give it a ", { b: "Name, for your team" }, " and a ", { b: "Title on the bubble" }, ", and pick its ", { b: "Colour" }, " and ", { b: "Corner" }, "."),
        runs("Under ", { b: "Sites that may show it, one a line" }, ", list your website's addresses. Left blank, any site can show it."),
        runs("Write the ", { b: "Greeting" }, " and the bot's set answers (see Settings below), then select ", { b: "Add" }, "."),
        "Copy the snippet the card shows and paste it before </body> on every page of your site — or ask whoever looks after your website to.",
      ),
      p(runs({ b: "For WhatsApp:" })),
      ol(
        "You need a WhatsApp Business account on Meta's WhatsApp Cloud API, with each number you want to use in it.",
        runs("Under ", { b: "WhatsApp" }, ", type the ", { b: "Access token" }, " (a permanent system-user token) and the ", { b: "Meta app secret" }, ", and select ", { b: "Save WhatsApp settings" }, ". If Campaigns already has a WhatsApp token, the inbox uses it when you leave the token blank."),
        runs("In your Meta app's ", { b: "WhatsApp › Configuration" }, ", give Meta the ", { b: "Callback URL" }, " and ", { b: "Verify token" }, " shown here, and subscribe to “messages”."),
        runs("Select ", { b: "Add a WhatsApp number" }, ". Type its ", { b: "Phone number ID" }, " from Meta and ", { b: "The number, as people dial it" }, "."),
        runs("Under ", { b: "Whose number" }, ", choose ", { b: "Shared — the whole team answers" }, ", or a rep's own. Then select ", { b: "Add" }, "."),
      ),
      note("Messages can't come in from WhatsApp until the Meta app secret is saved: every call Meta makes is checked against it.", "warning"),
      p(runs("Before going live, type a few customer questions into ", { b: "Try the bot" }, " on the channel's card to see what it would say. Trying it never uses AI credits.")),
    ],
    tasks: [
      task(
        "Answer a conversation",
        ol(
          runs("Open ", { b: "Support › Customer inbox" }, "."),
          runs("Pick a list: ", { b: "Mine" }, ", ", { b: "Unassigned" }, " (the queue), ", { b: "All open" }, " or ", { b: "Closed" }, ". Search by name, phone or email, or filter by channel or tag."),
          "Select a conversation. The customer's details are on the right — on a narrow screen, behind the ⓘ button.",
          runs("Type in the box and select ", { b: "Send" }, " (or press Enter; Shift+Enter makes a new line)."),
        ),
        p("While the bot has a conversation, a line says so. Reply and the bot steps aside for good. The customer sees that you're typing, and ticks show when a WhatsApp message is delivered and read."),
      ),
      task(
        "Take a conversation, or pass it on",
        p(runs("Under ", { b: "Who has it" }, ", select ", { b: "Take it" }, ", or choose a colleague. ", { b: "In the queue" }, " puts it back for whoever takes it first. If a colleague has the same conversation open, or is already replying, a yellow line tells you, so two people don't answer at once.")),
      ),
      task(
        "Use a saved reply",
        p(runs("In the reply box, type / and the start of a shortcut, then pick one. It drops in with the customer's first name and yours filled in, and you can change it before sending. An admin writes saved replies in ", { b: "Settings › Customer inbox" }, ".")),
      ),
      task(
        "Leave a note for the team",
        p(runs("Switch the box to ", { b: "Note" }, ", type, and select ", { b: "Add note" }, ". Notes show in yellow, and only your team sees them — never the customer. Type @ and a name to tell a colleague.")),
      ),
      task(
        "Send a photo or file",
        p("Select the paperclip beside the reply box. What you've typed goes with it as a caption. Up to 5 MB: photos, PDFs, and Word, Excel or text files. The button is there only where the channel lets the team send files."),
      ),
      task(
        "Write on WhatsApp after 24 hours",
        p(runs("WhatsApp lets you write freely for 24 hours after the customer's last message. After that, the box changes: type an approved ", { b: "Template name" }, " and ", { b: "Its values, one a line" }, ", and select ", { b: "Send template" }, ". Templates are approved by Meta, not in {siteName}.")),
      ),
      task(
        "Make a lead or a ticket",
        ul(
          runs({ b: "Make lead" }, " makes a lead from the customer's details. If their email or number is already on file, the conversation is linked to that customer instead."),
          runs({ b: "Make ticket" }, " opens a ticket in the Helpdesk. Check the ", { b: "Ticket title" }, " and select ", { b: "Make the ticket" }, "."),
        ),
        p(runs("Either way, a link to it appears under ", { b: "On file" }, ". If their number or email is on file for several customers, choose the right one with ", { b: "This one" }, ". ", { b: "Not them?" }, " undoes a wrong link; the lead stays in Leads.")),
      ),
      task(
        "Tag a conversation",
        p(runs("Under ", { b: "Tags" }, ", type a tag and press Enter — up to ten a conversation. Filter the list by tag to find them again.")),
      ),
      task(
        "Close or reopen a conversation",
        p(runs("Select ", { b: "Close" }, " at the top of the conversation, or ", { b: "Reopen" }, ". When the customer writes again, it reopens by itself. If the channel asks for a rating and somebody from the team answered, the customer is asked “How did we do?” when you close it. The rating shows on the conversation and in Inbox reports.")),
      ),
      task(
        "Block a nuisance",
        p(runs("Select ", { b: "Block this number" }, " or ", { b: "Block this visitor" }, ", add a reason for the team if you like, and select ", { b: "Block" }, ". Their messages stop coming in and the conversation closes. ", { b: "Unblock them" }, " undoes it, and admins can unblock anybody in Settings.")),
        note("Blocking a website visitor works on their browser. Somebody who clears their browser can start again."),
      ),
      task(
        "Say you're away",
        p(runs("The button at the top of the list says ", { b: "Available" }, " or ", { b: "Away" }, ". Round-robin gives new conversations only to people who are available and have been active in the last ten minutes. Select it to switch.")),
      ),
      task(
        "See response times",
        ol(
          runs("Open ", { b: "Support › Inbox reports" }, "."),
          runs("Pick ", { b: "7 days" }, ", ", { b: "30 days" }, " or ", { b: "90 days" }, ", and a channel if you have more than one."),
        ),
        p(runs("You see ", { b: "First response (median)" }, ", ", { b: "Answered within an hour" }, ", ", { b: "Every reply (median wait)" }, ", ", { b: "Waiting for a person now" }, ", what ", { b: "The bot handled alone" }, ", ", { b: "Leads made" }, " and ", { b: "Customers satisfied" }, ", then day by day and by channel. People who see every conversation also get ", { b: "By person" }, ".")),
        p("First response is counted from when the customer first needed a person, so time with the bot isn't held against anybody. Where a channel has office hours, only the hours the team was in count. The figures cover only the conversations you can see."),
      ),
    ],
    settings: [
      setting(
        "Channels",
        "Settings › Customer inbox",
        p(runs("Each website and WhatsApp number has a card. ", { b: "Edit" }, " opens its settings, ", { b: "Switch off" }, " stops it bringing conversations in, and a channel with no conversations yet can be removed.")),
      ),
      setting(
        "The bot",
        "Settings › Customer inbox, on each channel",
        ul(
          runs({ b: "Answer first, from the set answers below, and hand over to a person when it can't" }, ": on for a new website, off for a new WhatsApp number."),
          runs({ b: "Before handing over to a person, ask for:" }, " name, company, email, phone — one at a time, only what it doesn't know, each asked twice at most."),
          runs("Set answers: ", { b: "Add an answer" }, ", with the words or phrases that trigger it (comma-separated) and what the bot says. The answer matching most words wins. Up to 30."),
          runs({ b: "When it hands over, it says" }, ": {name} becomes the customer's first name."),
          runs({ b: "The assistant's name (optional)" }, ": shown on its messages. Asked whether it's a person, the bot always says it's the virtual assistant."),
        ),
      ),
      setting(
        "{siteName} AI answers",
        "Settings › Customer inbox, under The bot",
        p(runs("Tick ", { b: "Let {siteName} AI answer what the set answers don't" }, " and write ", { b: "What the AI may tell customers about your business" }, ". The AI sees only the conversation, your set answers and that text, says nothing that isn't there, and hands over whenever it isn't sure. Each answer uses your AI credits, charged to whoever switched it on. Until AI is set up for your workspace, the bot hands over instead.")),
      ),
      setting(
        "Leads from new customers",
        "Settings › Customer inbox, on each channel",
        p(runs({ b: "Make a lead from a new customer automatically, once we have:" }, " pick which details are needed. On WhatsApp the number always comes with the message, so a lead can be made from the first message. Customers already on file are linked instead.")),
      ),
      setting(
        "Website chat options",
        "Settings › Customer inbox, on a website",
        ul(
          runs({ b: "Show the team what a visitor is typing, before they send it" }, ": on by default. Never saved."),
          runs({ b: "Show a short form before the chat starts" }, ": each field Required, Optional or Don't ask."),
          runs({ b: "Email a reply to a visitor who has left the website, when they gave an email" }, ": at most one email a quarter of an hour."),
          runs({ b: "Say hello first" }, ": up to five messages shown beside the bubble after a visitor has been on a page a while."),
        ),
      ),
      setting(
        "Ratings and files",
        "Settings › Customer inbox, on each channel",
        ul(
          runs({ b: "Ask “How did we do?” when the team closes a conversation it answered" }, ": on by default."),
          runs({ b: "Customers can send photos and documents" }, " and ", { b: "The team can send photos and documents" }, ": up to 5 MB each."),
        ),
      ),
      setting(
        "Office hours",
        "Settings › Customer inbox, on each channel",
        p(runs("Tick ", { b: "Outside these hours, tell customers waiting for a person when you'll be back" }, ", set each day's hours (in the workspace's time zone) and write the ", { b: "Away message" }, ". It's sent at most once in 12 hours, and not if somebody replied in the last half hour.")),
      ),
      setting(
        "Who gets a conversation that needs a person",
        "Settings › Customer inbox, on a website or shared number",
        p(runs({ b: "The queue — whoever takes it first" }, " (the default), or ", { b: "Each person in turn (round-robin)" }, ". For round-robin, tick who takes turns, or leave every box empty for everybody who answers customers. A rep's own number always goes to that rep.")),
      ),
      setting(
        "Saved replies",
        "Settings › Customer inbox",
        p(runs({ b: "Add a saved reply" }, " with a ", { b: "Shortcut" }, ", ", { b: "What it's for" }, " and ", { b: "The reply" }, ". {name} becomes the customer's first name and {agent} the name of whoever sends it.")),
      ),
      setting(
        "Blocked",
        "Settings › Customer inbox",
        p(runs("Everybody the team has blocked, with the reason and who did it. ", { b: "Unblock" }, " lets them back in.")),
      ),
      setting(
        "Inbox alerts",
        "My work › Notifications › Preferences",
        p("“A customer writes in the Customer inbox” tells you when a customer writes on your own number or in a conversation you have, or somebody gives you one. It says who, never what."),
      ),
    ],
    faq: [
      qa(
        "I don't see Customer inbox in the menu.",
        p("The add-on may not be in your plan, the module may be switched off (Settings › Modules), or your role may not have the permission to answer customer conversations or the section ticked (Settings › Roles & Permissions). Ask an admin."),
      ),
      qa(
        "WhatsApp messages aren't coming in.",
        p("Check in Settings › Customer inbox that the Meta app secret is saved, and that Meta has the Callback URL and Verify token and is subscribed to “messages”. If you made a new verify token, give Meta the new one. Also check the number's Phone number ID and that the channel isn't switched off."),
      ),
      qa(
        "The chat bubble doesn't show on our website.",
        p("Make sure the snippet is on the page, before </body>, and that the site's address is in Sites that may show it — or that list is blank. A switched-off channel doesn't show."),
      ),
      qa(
        "Why can't I type a normal reply on WhatsApp?",
        p("It's more than 24 hours since the customer last wrote. WhatsApp only allows an approved template then. When they write again, the normal box comes back."),
      ),
      qa(
        "The bot handed over when it shouldn't have.",
        p("No set answer matched the customer's words. Add the words they used to an answer, and use Try the bot to check. With AI answers on, the AI also hands over whenever it isn't sure."),
      ),
      qa(
        "Round-robin isn't giving me conversations.",
        p("Make sure you show as Available, and that you're ticked among the people who take turns, if the channel names them. Round-robin skips anybody away or not active in the last ten minutes; with nobody available, the conversation waits in the queue."),
      ),
      qa(
        "I can't see a colleague's WhatsApp conversations.",
        p("Conversations on a rep's own number are theirs. You see one only if it's given to you, or if you're allowed to see every conversation."),
      ),
    ],
    related: ["helpdesk", "leads", "chat"],
  },
};
