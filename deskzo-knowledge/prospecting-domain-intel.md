# Domain Intel — Deskzo

Domain Intel looks up a customer's website domain and shows who runs their email, whether their domain can be spoofed, what their website is built on and who hosts it. It also suggests the sales conversation each finding opens. Domain Intel is part of Deskzo CRM and Deskzo One.

## Q: What is Domain Intel in Deskzo?
A: Domain Intel reads public information about a company's domain. From the website on the company's record it finds:
- who runs their email (for example Google Workspace or Microsoft 365, or self-hosted mail) and any mail security service;
- whether the domain has SPF, DMARC and DKIM;
- what the website is built on, who hosts it, who runs its DNS, and its registrar;
- the homepage title and description, with a thumbnail.
Each finding comes with **Where the conversation is**: the sales opening it suggests.

## Q: I can't see Domain Intel in my menu. Why?
A: Ask your admin to check:
1. Your company's plan includes Domain Intel (Deskzo CRM or Deskzo One).
2. The Domain Intel module is switched on in Settings → Modules.
3. Your role has the **Prospecting › Domain Intel** section ticked in Settings → Roles & Permissions.

## Q: Who can use Domain Intel?
A: Everyone with **Prospecting › Domain Intel** in their menu can open the list, look up a company and refresh a lookup. There is no other permission. Every role has the section unless an admin unticks it.

## Q: How do I look up one company's domain?
A: 
1. Open the company's page and go to the **Details** tab.
2. Find the **Domain & web** card.
3. Click **Look up** (or **Refresh** if it was looked up before).
4. Read the findings: **Email**, **Mail security**, **Website platform**, **Hosted on**, **DNS**, **Registrar**, the SPF, DMARC and DKIM badges, and **Where the conversation is**.
The card shows when it was last checked.

## Q: How do I check if a customer's email domain can be spoofed?
A: Look up the company in Domain Intel. On the company's **Domain & web** card, check the DMARC badge. A domain with no DMARC can be impersonated. On Prospecting → Domain Intel, the **Protection** column shows **No SPF**, **No DMARC** or **DMARC p=none** for open domains, and **Protected** for safe ones. The **Spoofable** card at the top counts domains with no DMARC.

## Q: How do I find companies worth a sales conversation?
A: 
1. Go to Prospecting → Domain Intel.
2. The cards at the top count **Looked up**, **Spoofable**, **On Google Workspace** and **Self-hosted mail**.
3. Filter by **Email** provider or website **Platform**, or search by company or website.
4. Check the **Protection** column for open domains.

## Q: How do I look up companies nobody has checked yet?
A: 
1. Go to Prospecting → Domain Intel.
2. Click **Not looked up yet**.
3. Click the refresh button on a row (**Look this domain up now**).

## Q: Why is there no Domain & web card on a company?
A: Domain lookups are only for customers and resellers. Vendors, OEMs, distributors, partners and commission parties do not get the card. Also, the card is hidden if Domain Intel is not in your menu.

## Q: It says "This company has no website on file." What do I do?
A: The lookup needs the company's **Website**. Open the company, click **Edit**, add the website and save. Then click **Look up** on the **Domain & web** card. Companies with no website are not listed on Prospecting → Domain Intel.

## Q: The lookup failed. What now?
A: The card says why it failed, for example "The lookup failed." The last good findings stay until a new lookup works. Check that the company's **Website** is a real website address, fix it with **Edit** if needed, then click **Refresh**.

## Q: Are Domain Intel findings updated automatically?
A: No. Deskzo only looks up a domain when someone clicks **Look up** or **Refresh**. It never runs in the background. The date of the last check shows beside the findings, so you know how old they are.

## Q: Where does Domain Intel get its information?
A: Domain Intel reads public DNS records, the company's homepage and the public domain registration record. A lookup takes a few seconds. The page thumbnail comes from an outside screenshot service.

## Q: Can I build a list of companies based on their domain?
A: Yes. In Prospecting → Workspace, create a list and use the **What their domain says** filters: **Email provider**, **Website platform**, **Domain can be spoofed** and **Domain not looked up yet**. Companies must be looked up in Domain Intel first for these filters to match.

## Q: How do I find customers on Google Workspace or with self-hosted mail?
A: Go to Prospecting → Domain Intel. Click the **On Google Workspace** or **Self-hosted mail** card, or use the **Email** filter. Only companies already looked up are counted.
