# Customer Inbox Setup and Bot — Deskzo

The Customer inbox in Deskzo brings website chat and WhatsApp messages into one inbox for your team. This guide covers who can use the Customer inbox, adding the website chat bubble, connecting WhatsApp, and the bot. The Customer inbox is an add-on, already included in Deskzo One. [PRICING: to be filled by Deskzo team]

## Q: What is the Customer inbox in Deskzo?
A: The Customer inbox is one place to read and answer customer conversations from two channels: a chat bubble on your website, and WhatsApp numbers (a shared number and reps' own numbers). Each channel can have a bot that answers first from your set answers and hands over to a person when it cannot help. Open it from **Support → Customer inbox**. Response times are in **Support → Inbox reports**. Each conversation has a reference like CNV-000123.

## Q: I can't see Customer inbox in my menu. Why?
A: The Customer inbox shows in the menu only when all of these are true:
1. Your company's plan includes the Customer inbox add-on (or Deskzo One).
2. The Customer inbox module is switched on in **Settings → Modules**.
3. Your role has the **Answer customer conversations** permission, and the **Support › Customer inbox** section is not hidden for your role.
Ask your admin to check **Settings → Modules** and **Settings → Roles & Permissions**.

## Q: Which permissions does the Customer inbox use?
A: The Customer inbox uses these permissions in **Settings → Roles & Permissions**:
- **Answer customer conversations**: read and reply to website chats and WhatsApp messages, take or pass on a conversation, and make a lead or ticket from one. Calling, Sales, Sales manager, Support and Management have it by default.
- **See every customer conversation**: also see conversations on colleagues' own WhatsApp numbers. Sales manager and Management have it by default.
- **Change organisation settings**: opens **Settings → Customer inbox**. Only admins have it by default.

## Q: Which conversations can I see in the Customer inbox?
A: With **Answer customer conversations**, you see conversations on shared channels (the website chat and shared WhatsApp numbers), conversations on your own WhatsApp number, and conversations given to you. Conversations on a colleague's own WhatsApp number are hidden unless you have **See every customer conversation**, or the conversation is given to you.

## Q: The Customer inbox says there's nothing to bring conversations in yet. What do I do?
A: The Customer inbox shows "There's nothing to bring them in yet" when no website chat or WhatsApp number is set up. An admin must add one in **Settings → Customer inbox**. If you are an admin, select **Set it up**.

## Q: How do I add the chat bubble to our website?
A: An admin adds website chat in **Settings → Customer inbox**:
1. Under **Website chat**, select **Add a website**.
2. Fill in **Name, for your team** and **Title on the bubble**. Choose the **Colour** and the **Corner** (**Bottom right** or **Bottom left**).
3. Under **Sites that may show it, one a line**, list your website domains, or leave it blank for any site.
4. Set the **Greeting** and the bot (see the bot question), then select **Add**.
5. On the channel's card, copy the snippet with **Copy the snippet**. Paste it before the closing body tag on every page of your website (your web developer can do this).

## Q: How do I connect WhatsApp to the Customer inbox?
A: The Customer inbox uses Meta's WhatsApp Cloud API. Each number must be in your WhatsApp Business account. An admin opens **Settings → Customer inbox** and, under **WhatsApp**:
1. Enter the **Access token**, the **Meta app secret** and the **Template language**, then select **Save WhatsApp settings**.
2. In your Meta app's WhatsApp → Configuration, enter the **Callback URL** and **Verify token** shown on the page, and subscribe to "messages".
3. Select **Add a WhatsApp number**. Enter the **Phone number ID** (from Meta → WhatsApp → API setup) and **The number, as people dial it**.
4. Under **Whose number**, choose **Shared — the whole team answers**, or a rep's own number.
5. Select **Add**.
Messages cannot come in until the app secret is saved.

## Q: How does the Customer inbox bot work?
A: Each channel has a bot under **The bot** in **Settings → Customer inbox**. When **Answer first, from the set answers below, and hand over to a person when it can't** is ticked, the bot replies from your set answers. Each answer has some words or phrases (comma-separated); the answer matching the most words wins. Select **Add an answer** to add one (up to 30). When no answer fits, or the customer asks for a person, the bot hands over and says your **When it hands over, it says** text. Before handing over it can ask for a name, company name, email or phone number. Asked whether it is a person, the bot always says it is the virtual assistant. The bot is on by default for website chat and off by default for WhatsApp.

## Q: How do I test the bot before customers see it?
A: In **Settings → Customer inbox**, each channel card has a **Try the bot** box. Type what a customer might write and select **Try**. Trying the bot here never uses AI credits.

## Q: Can Deskzo AI answer customers in the Customer inbox?
A: Yes, if your workspace has Deskzo AI set up for it. In the channel's bot settings, tick **Let Deskzo AI answer what the set answers don't**. Fill in **What the AI may tell customers about your business**. The AI says nothing that is not there or in the set answers, and hands over whenever it is not sure. Each AI answer uses your Deskzo AI credits. If the page says "Deskzo AI isn't set up for this yet", the bot hands over instead of answering.
