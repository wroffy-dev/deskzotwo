# Credential Vault — Deskzo

The Credential Vault in Deskzo keeps the company's own logins, such as the domain registrar, hosting panel, bank portal or tax account, encrypted in one place. You open a password with your own sign-in password, share logins on purpose, and every opening is recorded and reported to the owner. The Credential Vault is part of Deskzo Vault and Deskzo One.

## Q: What is the Credential Vault for?
A: The Credential Vault is where your company keeps the logins it runs on, instead of in a spreadsheet or in someone's head. A record can be the company's own login or a client's account you look after. Each record belongs to the person who added it. The owner can share it with a colleague or a department. Opening a password always asks for your own sign-in password, and the opening is recorded. The vault also generates strong passwords, reminds you when a password should be changed or a subscription is about to end, and warns you when the same password is used on more than one record.

## Q: How do I add a login to the Credential Vault?
A: To add a login:
1. Go to **Tools → Credential vault** and select **Add a credential**.
2. Under **What it opens**, name it so a colleague can tell what it is, for example "Registrar — example.com".
3. Under **Whose account is it**, choose **Ours** or **A client's**. For a client's, pick **Which client**.
4. Fill in what you know: **Category**, **Access type**, **Username**, **Email**, **Login URL**, and **Two-step goes to** (the phone that gets sign-in codes).
5. Type the **Password**, or select **Generate** for a strong one. Add a **Recovery key** if the service gave you one.
6. Optionally set **Billing expires**, **Recommend a change after (days)** and **Remarks**.
7. Select **Save**.

## Q: How do I save a password in the vault?
A: Go to **Tools → Credential vault**, select **Add a credential**, fill in **What it opens**, the **Username** and the **Password** (or select **Generate**), and select **Save**. You need the **Use the credential vault** permission.

## Q: How do I generate a strong password?
A: When adding or editing a vault record, select **Generate** beside the password. To choose how it is generated, select the length button beside **Generate**: set the **Length**, the kinds of characters, and **Skip lookalikes** to leave out characters that are easy to misread, like O and 0.

## Q: How do I open a stored password?
A: To see a password in the Credential Vault:
1. On the record, select the password (or **Recovery key**, if it has one).
2. Type **Your password**, the one you sign in to Deskzo with, and select **Show password**.
3. Read or copy it, then select **Done**.
The password is not kept on screen. Opening it again asks for your password again. Every opening is recorded. If it is not your record, the owner is told you opened it.

## Q: It says "That password isn't right" when I open a vault record.
A: The Credential Vault wants your own Deskzo sign-in password, not the stored password. Type the password you sign in with. A wrong try is recorded in the workspace audit log.

## Q: It says "This account has no password set".
A: Opening a vault record needs a password on your own Deskzo account. If you always sign in another way, you have no password. Ask your admin about setting a password for you.

## Q: How do I share a login with a colleague?
A: To share a vault record:
1. On the record, select **Share**.
2. Under **Share with**, search for a colleague by name or email, or for a team (department).
3. Under **They can**, choose **Can open** or **Can open, edit and share**.
4. To give access for a while only, set **Until (optional)**.
5. Select **Share**.
The colleague is notified. To take a share back, open **Share** again and remove them from **Already shared with**.

## Q: What can I do with a record shared with me?
A: It depends on how you got the record:
- **Your own** (you added it or it was handed to you): open, edit, share and delete.
- Shared as **Can open**: open it and see who else has.
- Shared as **Can open, edit and share**: also change it and share it on. You cannot delete it; only the owner or an administrator can.
- Shared with your department: everybody in the department has it while they are in it. People who join get it, and people who leave lose it.
A share with an end date stops on that date by itself.

## Q: How do I see who opened a login?
A: On the vault record, select **Who opened it**. It lists openings, latest first: who, when, the password or the recovery key, and how they had access. The record also shows who opened it last and how many times it has been opened. Anybody who can see the record can see this.

## Q: How do I change a stored password?
A: To update a password in the Credential Vault:
1. On the record, select **Edit**.
2. Type the new one under **New password (blank keeps the current one)**, or generate it.
3. Select **Save**.
The record is dated as changed, which resets its change reminder. If you changed somebody else's record, the owner is told.

## Q: How do I delete a login from the vault?
A: On the record, select **Delete**. Say why under **Why (optional)**, then select **Delete and archive**. The record goes to the archive for 60 days, then it is destroyed for good. Everyone it was shared with loses it. The owner is told if somebody else deleted it.

## Q: I deleted a login by mistake. Can I get it back?
A: Yes, within 60 days. Deleted vault records stay in the archive for 60 days. Ask somebody with the **See every vault record** permission to open **Archive** from the vault page and select **Restore**. They can also select **Destroy now** to remove a record straight away.

## Q: How do I find a login in the vault?
A: Type in **Search name, username, email or URL…**, or narrow the list by category, by **Ours** or **A client's**, or by owner. **Pin to the top** keeps a record above the rest, only for you. Records whose billing ends within a month float to the top for everybody.

## Q: What are the change reminder and billing expiry?
A: **Recommend a change after (days)** sets how often the password should be changed. The record says when a change is due from a fortnight before, and how many days overdue it is after. **Billing expires** is when the subscription behind the login ends. From a month before, the owner gets a reminder every few days, and one more when it has lapsed. Leave either empty for no reminder.

## Q: Why does it say "Same password on 2 other records"?
A: The same password is stored on other vault records you can see. Records you cannot see are not counted. Use a different password for each service.

## Q: Why isn't the login address a link?
A: The Credential Vault shows the login address as text and never as a link, on purpose. One wrong click on a fake login page is all an attacker needs. Copy the address into your browser yourself.

## Q: Can an admin read my stored passwords?
A: A person with the **See every vault record** permission can open any record. Each time, the record shows **Admin override — the owner will be told**, the opening is recorded as an override, and you are notified. A login shared with them counts as a share, not an override. Logins are encrypted where they are stored, but somebody with access to the server itself could still decrypt them.

## Q: What happens to a colleague's logins when they leave?
A: When their handover is done, the logins they own move to the person taking over, and each is marked to be changed within fifteen days, because the leaver still knows the password. Logins shared with them move to their successor.

## Q: How do I set up vault categories?
A: An admin opens **Settings → Lists** and finds **Credential vault tags**. There are two lists: **Categories** (what kind of service, for example Hosting) and **Access types** (what access the login gives, for example Billing). A tag can be made inactive instead of deleted. A tag that records use cannot be deleted. You need the **Manage vault categories** permission.

## Q: Which permissions control the Credential Vault?
A: These permissions are in **Settings → Roles & Permissions**:
- **Use the credential vault**: store your own logins and open the ones shared with you. Management, Sales, Support, Accounts and Purchase have it by default.
- **See every vault record**: open any record and see, restore and destroy archived records. No built-in role has it by default; admins hold it. Give it to as few people as possible.
- **Manage vault categories**: edit the vault lists in Settings → Lists. Management has it by default.
- The **Tools › Credential Vault** section tick shows the vault in the menu.

## Q: I can't see Credential vault in my menu.
A: The Credential vault shows in the menu only when all of these are true:
1. Your company's plan includes the vault (Deskzo Vault or Deskzo One).
2. The Credential Vault module is switched on in **Settings → Modules**.
3. Your role has the **Use the credential vault** permission and the **Tools › Credential Vault** section is ticked in **Settings → Roles & Permissions**.
Ask your admin to check these.
