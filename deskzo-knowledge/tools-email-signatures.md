# Email Signatures — Deskzo

Email Signatures in Deskzo gives everybody the same email signature design with their own details filled in from their record. Signatures are put into everybody's Gmail, Zoho Mail or Outlook and kept up to date when a title or number changes. Email Signatures is part of Deskzo Signatures and Deskzo One.

## Q: What does Email Signatures do?
A: Email Signatures gives everybody the same signature design with their own name, job title, department, work phone, email, office address and photo, taken from their Deskzo record. Change somebody's title and their signature changes too. You design templates, decide who gets which, and can add a banner under signatures for an event or offer. A **Clicks** report counts clicks on banners and buttons, without knowing who clicked.

## Q: How does the signature get into my mailbox?
A: It depends on your company's email:
- **Google Workspace (Gmail)** or **Zoho Mail**: connected once by an admin, then each person's signature is put into their mailbox and kept up to date.
- **Microsoft 365 (Outlook)**: an add-in deployed by your Microsoft 365 administrator puts the signature into each new message as you write it.
- Without either: copy your signature from **Tools → My email signature** and paste it into your mail program.

## Q: How do I copy my email signature?
A: To copy your signature:
1. Go to **Tools → My email signature**.
2. Select **Copy signature**, or **Copy HTML** for a mail program that wants the code.
3. Paste it into your mail program's signature settings. **Pasting it in yourself** on the page has steps for Outlook, Gmail and Apple Mail.
The top of the page says whether your signature is already in your Gmail, Zoho Mail or Outlook. If the template has a shorter signature for replies and forwards, it is shown separately to copy too.

## Q: How do I get my email signature?
A: Go to **Tools → My email signature**. Everybody can open it. If your company has connected Gmail or Zoho Mail, or turned on the Outlook add-in, your signature is put in for you. Otherwise select **Copy signature** and paste it into your mail program's signature settings.

## Q: My job title or phone is wrong in my signature.
A: Your email signature takes these details from your Deskzo record. Change the record, or ask whoever keeps the records, and your signature follows. With Gmail or Zoho Mail connected, the change reaches your mailbox within minutes.

## Q: How do I design a company email signature template?
A: To design a signature template:
1. Go to **Tools → Email signatures**, open the **Templates** tab, and select **New template**, or **Edit** beside one.
2. Pick a **Layout**, and set the **Name**, **Font** and **Colour**.
3. Under **From each person's record**, choose what to show: photo, job title, department, work phone, email, office address.
4. Under **Logo**, leave the address empty to use the logo in **Settings → Branding**, or give one starting https://.
5. Under **The same for everybody**, add the **Website**, social profiles, a button (**Button text** and **Button link**), a **Sign-off** and a **Disclaimer**.
6. Check the **Preview**, then select **Save**. The button says how many signatures will change.
Every link must start with https://. **Make default** sets the template everybody gets unless a rule says otherwise. You need the **Manage email signatures** permission.

## Q: How do I give different signatures to different teams?
A: To decide who gets which signature:
1. Go to **Tools → Email signatures** and open the **Who gets which** tab.
2. Under **Who**, choose **A person**, **A department**, **A branch** or **A role**, then which one under **Which**.
3. Under **Gets**, choose the template, and select **Add**.
When several rules fit somebody, a rule for the person wins, then their department's, their branch's and their role's. Everybody else gets the default template.

## Q: How do I connect Gmail (Google Workspace) for signatures?
A: On **Tools → Email signatures**, open the **Connection** tab and follow the steps shown. In short: in Google Cloud, turn on the Gmail API for a company project and make a service account with a JSON key. In the Google Admin console, give that service account domain-wide delegation with the scope the screen names. Then paste the key under **Service account key (JSON)**, give a Google Workspace administrator's address under **Try it as**, and select **Connect Google Workspace**.

## Q: How do I connect Zoho Mail for signatures?
A: First, the Zoho app must be set up in **Settings → Security & data protection**, under Email & sign-in. Then on **Tools → Email signatures**, **Connection** tab, a Zoho Mail administrator selects **Connect Zoho Mail** and approves. If asked, give the **Organisation ID** from the Zoho Mail Admin Console.

## Q: How do I set up email signatures in Outlook?
A: On **Tools → Email signatures**, **Connection** tab, select **Turn on the Outlook add-in**, then **Download the add-in file**. A Microsoft 365 administrator uploads the file in the Microsoft 365 admin center, under Settings → Integrated apps → Upload custom apps, as an Office Add-in, and deploys it to everybody or to some groups. Outlook can take a few hours to pick up a new add-in (up to a day), and people may need to restart Outlook.

## Q: Outlook doesn't put my signature in.
A: The Outlook add-in can take a few hours to reach you after it is deployed, up to a day. Restart Outlook. **Tools → My email signature** says when Outlook last fetched your signature. If it never has, ask your admin whether the add-in was deployed to you.

## Q: My Outlook messages carry two signatures.
A: Ask whoever manages signatures to tick **Turn off people's own Outlook signature, so a message never carries two** on the **Connection** tab of **Tools → Email signatures**. Or remove your own signature in Outlook's signature settings.

## Q: How do I push signatures to everybody's mailbox?
A: With Gmail or Zoho Mail connected, the **People** tab on **Tools → Email signatures** shows each person's template and status: **In their mailbox**, **Changed — goes out next**, **Waiting to go out**, **Failed** or **No mailbox**. Select **Sync everybody now** to put them in straight away. A failed one is tried again on its own. With the Outlook add-in there is nothing to sync.

## Q: What does "Keep everybody's signature in step on its own" do?
A: This option is on the **Connection** tab. When ticked, a changed title or phone goes out to Gmail or Zoho Mail within minutes. When unticked, signatures go out only when you select **Sync everybody now**. **Disconnect** stops putting signatures into Gmail or Zoho Mail; signatures already in mailboxes stay there.

## Q: It says my signature failed.
A: The reason is shown beside it, on **Tools → My email signature** and on the **People** tab. Deskzo tries again on its own. If the whole connection stopped, the **Connection** tab says why. Tell whoever manages signatures.

## Q: It says No mailbox, or "Not for Zoho Mail".
A: The connected mail service has no account at your work address, so there is nowhere to put the signature. Copy your signature from **Tools → My email signature** and paste it into the mail program you use.

## Q: How do I add a banner under email signatures?
A: To add a banner:
1. On **Tools → Email signatures**, open the **Banners** tab and select **New banner**. You can **Start from a sample**.
2. Give it a **Name** (only for you; it is not shown in emails).
3. For the **Picture**, **Upload a picture** (PNG, JPEG or GIF, 1 MB at most) or **Use an https:// address**.
4. Fill in **Links to (https://)**, **What it says** (shown where pictures are blocked), and **Width (pixels)**.
5. Set the days it **Starts** and **Ends**, or leave them empty to run until you pause it.
6. Under **Under whose signature**, choose **Everybody's** or some templates, and select **Save banner**.
A signature carries one banner at a time. **Pause** stops a banner for now.

## Q: It says the picture is over 1 MB.
A: Signature banner pictures can be at most 1 MB, because they travel in every email. Make the picture smaller; a few hundred KB is best. Use PNG, JPEG or GIF.

## Q: How do I see how many people clicked my signature banner?
A: Open the **Clicks** tab on **Tools → Email signatures** and choose the last 7, 30 or 90 days. Pick a banner or button to see clicks by day, by team and by whose signature. Clicks are counted only while **Count clicks on banners and buttons** is ticked. Deskzo never knows who clicked. Some mail programs check links before the reader sees them, so the numbers may be a little high.

## Q: How do I give a shared mailbox like sales@ its own signature?
A: This works with the Outlook add-in only. On the **Who gets which** tab, under **Shared mailboxes (Outlook)**, select **Add a mailbox**. Give its **Address**, the name it is **Signed as**, its **Phone** and its **Template**, and select **Save mailbox**. When somebody sends from that mailbox in Outlook, it carries the mailbox's signature instead of theirs.

## Q: What signature goes on replies and forwards?
A: Each template has an **On replies and forwards** setting: the whole signature, a short one (name, title, company and phone), or none. Only the Outlook add-in can tell a reply from a new message. Gmail and Zoho Mail keep one signature for both.

## Q: Which permissions control Email Signatures?
A: The **Manage email signatures** permission lets a person design templates and banners, decide who gets which, connect Google Workspace or Zoho Mail, turn on the Outlook add-in, sync signatures and read the clicks report. Management has it by default. The **Tools › Email Signatures** section tick shows Email Signatures in the menu, including My email signature. Both are in **Settings → Roles & Permissions**.

## Q: I can't see Email signatures in my menu.
A: **My email signature** is there for everybody when all of these are true:
1. Your company's plan includes Email Signatures (Deskzo Signatures or Deskzo One).
2. The Email Signatures module is switched on in **Settings → Modules**.
3. The **Tools › Email Signatures** section is ticked for your role in **Settings → Roles & Permissions**.
**Email signatures** (for managing everybody's) also needs the **Manage email signatures** permission. Ask your admin.
