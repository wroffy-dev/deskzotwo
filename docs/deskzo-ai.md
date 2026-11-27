# Deskzo AI — setting up the provider

Deskzo AI (src/lib/ai) runs the copilot and Automate's "Draft with AI" on Deskzo's own provider account,
paid for by workspaces in credits. Workspaces bring no key. This page is for whoever sets up that account
in **console › Settings › AI**. The first provider (owner, 17 Oct 2026) is **Claude on Amazon Bedrock,
India**: requests are processed only in Mumbai (ap-south-1) and Hyderabad (ap-south-2).

AWS renames console pages from time to time. If a page below has moved, search for it in the AWS
console's search bar.

## 1. In AWS

### Turn on the Claude models

1. Sign in to the AWS console with an account that can manage IAM and billing.
2. Switch the region (top right) to **Asia Pacific (Mumbai) — ap-south-1**.
3. Open **Amazon Bedrock › Model catalog** (older consoles: **Model access**). Enable **Claude Sonnet 5**,
   **Claude Opus 5** and **Claude Haiku 4.5**.
   - The first time, AWS asks for a short use-case form for Anthropic's models. Answer it as the company:
     "an AI assistant inside our business software, for our customers' staff".
   - Enabling may subscribe the account to the models through AWS Marketplace. That's done once, by the
     person enabling them, not by Deskzo's key.
4. Check the India inference profiles exist: **Amazon Bedrock › Cross-region inference** (or
   **Inference profiles**) in ap-south-1 should list `in.anthropic.claude-sonnet-5`,
   `in.anthropic.claude-opus-5` and `in.anthropic.claude-haiku-4-5-20251001-v1:0`. If the names differ,
   use the ones listed there as each model's "Name at the provider" in step 3 below.

### Make the key Deskzo uses

**Recommended: an IAM user with only this permission.**

1. **IAM › Policies › Create policy › JSON**. Paste the policy below, with your 12-digit AWS account ID in
   place of `ACCOUNT_ID`, and name it `DeskzoBedrockIndia`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "DeskzoInvokeClaudeInIndia",
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": [
           "arn:aws:bedrock:ap-south-1:ACCOUNT_ID:inference-profile/in.anthropic.*",
           "arn:aws:bedrock:ap-south-1::foundation-model/anthropic.*",
           "arn:aws:bedrock:ap-south-2::foundation-model/anthropic.*"
         ]
       }
     ]
   }
   ```

   An inference profile needs permission on the profile in the region requests are sent from, and on the
   model in every region it routes to. Here that's Mumbai and Hyderabad.

2. **IAM › Users › Create user**. Name it something like `deskzo-bedrock`, with no console access. Attach
   the `DeskzoBedrockIndia` policy and nothing else.
3. Open the user › **Security credentials › Create access key** › "Application running outside AWS".
   Copy the **Access key ID** (`AKIA…`) and the **Secret access key**. AWS shows the secret once, so if
   you lose it, make a new key.

**Alternative: a Bedrock API key.** In **Amazon Bedrock › API keys**, generate a **long-term API key** and
choose when it expires. It goes in the key field, with Access key ID left empty. It's quicker, but it
expires: put a reminder in the calendar to renew it. AWS suggests IAM credentials for anything long-lived.

### Watch the cost

- Check the per-token prices for the India profiles on **aws.amazon.com/bedrock/pricing** (Anthropic,
  Asia Pacific (Mumbai)). The rates Deskzo suggests assume list prices at ₹90 to the dollar; set each
  model's rates and costs in the console to match (step 3 below).
- Set an **AWS Budgets** alert on the account, so a surprise is an email rather than an invoice.

## 2. Add the account in the console

**console › Settings › AI › Add account**:

| Field | Value |
|---|---|
| Provider | Claude on Amazon Bedrock |
| Name in the console | Bedrock India |
| Where it processes requests | India (Mumbai and Hyderabad) |
| AWS region | ap-south-1 |
| Access key ID | the IAM user's `AKIA…` (empty with a Bedrock API key) |
| Secret access key, or Bedrock API key | the secret. It's sealed when saved and never shown again; only an owner can save it |
| No training | tick it once you have read AWS's Bedrock data terms (prompts and answers aren't used to train models or shared with the model's maker) |
| On | ticked |

## 3. Models, rates and routing

1. On the account: **Add suggested models** adds the three India profiles with suggested rates (credits
   for a million tokens; a credit is ₹1) and costs (paise for a million tokens, used only for the margin
   table). Change them to match Bedrock's price page.
2. **Routing**: Copilot chat → Claude Sonnet 5; Automate: drafting a workflow → Claude Haiku 4.5 (or
   Sonnet 5 for better drafts). Save.
3. **Test** on the account asks its first model for one word. It costs a few tokens and is charged to no
   workspace. The result is kept on the account.

Until a feature is routed, workspaces see "Deskzo AI isn't available right now" for it. The rest of the
app — Automate's workflows included — works the same without AI.

## When the test fails

| What it says | What it usually means |
|---|---|
| `AccessDeniedException` … not authorized to perform `bedrock:InvokeModel` | The policy is missing, attached to another user, or has the wrong account ID. |
| `AccessDeniedException` … don't have access to the model | The model isn't enabled in ap-south-1 (step 1.3), or the use-case form is still pending. |
| `ValidationException` … model identifier / inference profile is invalid | The "Name at the provider" doesn't match the profile listed in ap-south-1 (step 1.4). |
| The security token included in the request is invalid | The access key ID and secret don't belong together, or the key was deleted or rotated. |
| `ThrottlingException` | The account's per-minute quota for the model; ask AWS for more under **Service Quotas › Amazon Bedrock**. |

## Changing the key

Make a new access key on the IAM user and save it on the account with **Edit**. A blank key field keeps
the saved one. Then press **Test**, and delete the old key in IAM. Nothing in the workspaces changes.

## Other providers

The Add account dialog says where each one's key comes from. In short:

- **Azure OpenAI**: a resource in Central or South India, with Standard (regional) deployments. The
  deployment's name is the model's "Name at the provider".
- **Gemini on Vertex AI**: a service account with Vertex AI User and a JSON key, location `asia-south1`
  (never `global`).
- **Anthropic or OpenAI direct**, and **Google AI Studio**: an API key from their console. Processing is
  in the United States.
- **OpenAI-compatible** (vLLM, Ollama, Deskzo's own GPU later): the server's `/v1` base URL. Plain http
  is accepted only on the private network.

## Haiku first, Sonnet when it can't

Owner, 23 Nov 2026: the copilot runs on **Claude Haiku 5.5**, and a question Haiku can't answer goes to **Claude Sonnet 5.5**.
On the Anthropic account add both models (names at the provider `claude-haiku-5-5` and `claude-sonnet-5-5`), then in
**Routing**:

| Feature | Model |
|---|---|
| Deskzo AI chat | Claude Haiku 5.5 |
| Deskzo AI chat: questions its model couldn't answer | Claude Sonnet 5.5 |

A question moves to the second for the rest of that question (src/lib/copilot/agent.ts) when the chat's model fails the
call, declines, comes back with nothing, or has all its tool calls refused twice. A step is re-run on Sonnet only if
nothing of it was on the screen yet, so nothing is shown twice; the person sees "Asked a stronger model". The next
question starts on Haiku again. Each turn is charged at the rates of the model that ran it. Left without a model (or on
the same model as the chat), nothing is handed on — the setting is optional, and the console doesn't warn about it.
The server log says why each time: `[ai] copilot.chat handed to copilot.escalate: …`. `npm run check:copilot`.

## Deskzo's own Ollama (ai.deskzo.com)

Deskzo's own model server (owner, 23 Nov 2026): Ollama with **llama3.2:3b** on an Azure VM (4 vCPU, 32 GiB, no GPU),
behind nginx at `https://ai.deskzo.com` with a Let's Encrypt certificate. Ollama itself listens only on 127.0.0.1:11434;
nginx refuses every request whose `Authorization` header isn't `Bearer <the key>`. Nothing else is needed in Deskzo's
code: it is an **OpenAI-compatible** account in the console, like any other.

### 1. On the VM: give Ollama an 8,192-token window

A copilot question carries about 16,000 characters before the person types anything — the system prompt and 20 tools,
about 4,600 tokens. Ollama's default window on a machine without a GPU is **4,096 tokens**, so without this every
question overflows it and is cut from the start. Add one line to `/etc/systemd/system/ollama.service.d/override.conf`:

```ini
Environment="OLLAMA_CONTEXT_LENGTH=8192"
```

then `sudo systemctl daemon-reload && sudo systemctl restart ollama`. Ask it something, and `ollama ps` should show
`8192` under CONTEXT. 8,192 is also Deskzo's default (`AI_LOCAL_CONTEXT_TOKENS`), so nothing changes in Deskzo's `.env`;
if Ollama is ever given another number, set `AI_LOCAL_CONTEXT_TOKENS` to the same one. Don't go much above 8,192 on this
VM: Ollama reads about 58 tokens a second here, so a full 8k window is already about two minutes before a cold answer
starts. A larger window only lets longer conversations through, at that speed.

### 2. In the console

**console › Settings › AI › Add account** (an owner):

| Field | Value |
|---|---|
| Provider | OpenAI-compatible server |
| Name in the console | Deskzo Ollama |
| Base URL | `https://ai.deskzo.com/v1` |
| API key | the key nginx expects — without `Bearer`. It's sealed under the platform key when saved and never shown again |
| Where it processes requests | Deskzo's own server (Azure, and its region) |
| No training | tick it: nothing sent to it leaves Deskzo's own VM |
| On | ticked |

Then on the account, **Add model**: key `llama3.2-3b`, name `Llama 3.2 3B`, name at the provider `llama3.2:3b` (exactly
as `ollama list` shows it), and the rates workspaces are charged in credits (0 is allowed). **Test** asks it for one word;
a self-hosted account gets two minutes, since the server may be loading the model or answering somebody first.
**Routing**: Deskzo AI chat → Llama 3.2 3B. Save. The route and key are read on every turn, so the next question in
every workspace runs on it — no restart, and the same for a changed key.

### What to expect

- **One question at a time.** `OLLAMA_NUM_PARALLEL=1`: the others wait in Ollama's queue. Deskzo lets a person have two
  turns running and a workspace eight; past that they're told to wait. A short answer is a few seconds; the first
  question after the model loads, or after a different feature's prompt, reads the whole prompt again (up to about two
  minutes). The same feature's next question reuses Ollama's cache and starts much sooner.
- **Most features borrow the chat's model.** Every feature with no model of its own runs on Deskzo AI chat's
  (`fallback` in src/lib/ai/catalogue.ts). **llama3.2:3b reads no images**, so reading a vendor's bill or a receipt (a
  photo or a PDF) fails on it — the person is told Deskzo AI couldn't answer, and nothing is charged. Route
  "Purchase: reading vendors' bills" and "Expenses: reading receipts" to a model that reads images when there is one.
  Background features (nurture emails, bank matching) share the one queue with people's questions.
- **The copilot is lighter on it.** On an OpenAI-compatible account the copilot gets a short system prompt (~1,350
  characters instead of ~3,600), only the tools the question is about (none for a "Hi"; src/lib/copilot/local-tools.ts),
  temperature 0.2 and at most four steps a question. A "Hi" is ~400 tokens to read instead of ~4,600; a data question
  ~600–1,100. Hosted models are unchanged. `npm run check:local-copilot`.
- **A small model.** 3B parameters answers simple questions and lookups well, and longer reasoning less well than the
  qwen2.5:7b this was first tried on. A tool call it writes as text is still run (see "A call written as text" below).

### When the test fails

| What it says | What it usually means |
|---|---|
| Invalid API key: the server refused it (401) | The key saved isn't the one in nginx's `if ($http_authorization …)` line — after a rotation, say. Type it again with **Edit**. |
| Not found (404) … model "…" not found | The name at the provider isn't what `ollama list` shows, or `ollama pull llama3.2:3b` wasn't run. |
| Not found (404) | The base URL doesn't end in `/v1`. |
| No answer within 120 seconds | Ollama is answering a long question, or stopped: `systemctl status ollama` on the VM. |
| The server failed to answer (502) | nginx is up but Ollama isn't: `sudo systemctl restart ollama`. |
| Connection error | DNS, the certificate, or port 443 in the Azure NSG. `curl -i https://ai.deskzo.com/v1/models` should give 401. |

### Rotating the key

Make a new one on the VM, put it in nginx's site in place of the old one, `sudo systemctl reload nginx`, then **Edit**
the account in the console, paste the new key and **Test**. Between the reload and the save, Deskzo AI's questions
fail with "couldn't answer just now", so do the two together.

## Changing a lead from the chat

"Edit the 50 laptop leads in to 60 laptop" was answered that leads can't be changed. Deskzo AI now proposes a change to
**one** lead (`propose_lead_update`, src/lib/copilot/tools.ts and lead-update.ts); nothing is saved until the person presses
**Save changes** on its card.

- **What it can change:** the quantity of one product on the lead, its title, description, estimated value and expected
  close date. Not the owner, stage, contact or company; it doesn't empty a field, delete, or change several at once.
- **Finding the lead:** by its LEAD- reference only, which `list_leads` gives with each lead's products and quantities. A
  number that can be a quantity or a count ("50 laptop leads") is asked about, and so is a lead or a product that isn't the
  only one that fits — the tool refuses and hands back the list. A question gets one card, whatever the model calls.
- **The card** shows each field's old value and its new one, from the stored proposal — in the chat and on Settings › AI
  activity.
- **Confirming** (`confirmCopilotProposal`) goes through the lead page's own actions, `updateLeadDetails` and
  `updateLeadRequirement`, as the person: what they may edit, `products.edit`, field rules and the won lead's locked value
  all apply, and the lead's Activity records an edit of its details as it would from the page. Fields nobody asked about are sent back as they are.
- **Refused, with nothing saved:** a field on the card that has changed since it was drawn, a title or description the person
  sees masked (whole or in part), or access taken away since. A quantity is saved after the other fields; should only it be
  refused then, the card says what was saved.
- A new kind of card, `LEAD_UPDATE` (migration `20261226100000_copilot_lead_update`). A workspace without it yet is told to
  try again in a few minutes. `npm run check:copilot-lead-update`.

## AI Knowledge — answering from the company's own files

**Settings › AI Knowledge** (src/lib/ai-knowledge, owner 3 Nov 2026) holds a workspace's own guides, product notes
and processes as `.md` or `.txt` files. Deskzo AI answers from them in two places: the copilot, and the Customer
inbox's bot on a channel that allows it. Nothing here is set up in the console: each workspace looks after its own.

### Who and where

- Only somebody with **Change organisation settings** (`settings.manage`) sees the page or can change anything on it:
  the page, its actions (src/actions/ai-knowledge.ts) and the upload route (src/app/api/ai-knowledge/upload) all
  check it, and none of them works while an admin is viewing as somebody. The upload route also refuses a post from
  any other site's page. Every upload, edit and delete is in the audit trail.
- The files live in the workspace's own database (tenant DB): `ai_knowledge_files` (each file whole) and
  `ai_knowledge_chunks` (its pieces). Migration `20261203110000_ai_knowledge`; `npm run tenants:migrate` takes it to
  every workspace. Before a workspace has it, the page says it's being updated and the copilot simply doesn't offer
  the tool.

### On the page

- **Choose files**: several `.md`/`.txt` files at once, or a `.zip` of them. Inside a `.zip`, the zipped folder's own
  name is left off and the folders below it kept (`handbook/hr/leave.md` → `hr/leave.md`). A name already there
  (whatever its case) replaces that file. What's left out is listed with why: not `.md`/`.txt`, empty, not text,
  over 1 MB, or a second file with the same name. Limits: 25 MB a request, 300 files an upload, a `.zip` unpacking to
  at most 40 MB (refused before it's inflated if it says it's more), 500,000 characters a file, 1,000 files in all.
- **Find a file** filters the list by name or title. **Edit** opens a file's name and text; **Delete** removes it and
  its chunks.
- **What would the AI find?** runs a question through the same search the copilot uses and shows the very chunks it
  would be given.

### How a file is cut and searched

- Each file is cut at its headings (`#` to `######`; a `#` inside a code fence is code) into chunks of about 800
  characters (src/lib/ai-knowledge/chunk.ts). Every chunk keeps the headings above it — `Leads › Q: How do I add a
  lead?`. Small sections that follow each other share a chunk, each with its own heading line; a new `#` topic always
  starts one. A long section is cut at its paragraphs, then lines, sentences and words — never inside a word — and a
  short last piece stays with the one before (no chunk is over 960 characters). A `.txt` file has no headings and is
  cut at its paragraphs. The 81 files of `deskzo-knowledge/` come to about 1,140 chunks.
- Search is Postgres full-text search (src/lib/ai-knowledge/search.ts). Each chunk's `search` column is a `tsvector`
  the database makes itself from the heading (weight A) and the text (weight B) — `GENERATED ALWAYS … STORED`, so it
  is never stale — with a GIN index. English stemming (`invoicing` finds `invoice`); any of the question's words is
  enough to be found, chunks with all of them first, then by `ts_rank_cd`.

### The copilot: `search_knowledge(query)`

- Offered (first in the list) once the workspace has at least one file. It returns the top 5 chunks, each with its
  file's name and headings.
- The system prompt (src/lib/copilot/prompt.ts) then says: for any question about the company, its products or
  services, or a process, run `search_knowledge` first, answer from it, and end with the source file's name —
  `(Source: crm-leads.md)`; if nothing answers it, say so rather than guess.
- AI Knowledge is the company's own guides, not business records, so everybody who may use the copilot can search it.

### The Customer inbox: "Use AI Knowledge"

- In **Settings › Customer inbox**, a channel with Deskzo AI on has a **Use AI Knowledge** tick (`bot.ai.knowledge`,
  off by default). Ticked, before the AI answers a customer it is given the top 3 chunks for the customer's last two
  messages, and told to answer in its own words without naming the files. Tick it only if everything in AI Knowledge
  may be told to customers.
- With it ticked, AI Knowledge alone is enough for the AI to be switched on (no set answers or notes needed).

### The 4,000-character budget

The model behind these answers is **qwen2.5:7b** (on an OpenAI-compatible server — see "Other providers"), with an
8k-token context for the whole request. So no prompt is ever given more than **4,000 characters of knowledge** at a
time (src/lib/ai-knowledge/budget.ts `KNOWLEDGE_PROMPT_CHARS`), counting file names, headings and text:

- the copilot's 5 chunks are cut to fit — the best ones whole, the last one that fits cut at a word with "…", a
  scrap of under 200 characters left out;
- the inbox's 3 chunks and the website pages a channel reads share the same 4,000: AI Knowledge first, the website's
  passages in the room left.

`npm run check:ai-knowledge` checks all of this — the chunking (over every file in `deskzo-knowledge/`), the upload
reader, the budget, the search on a real database, the permissions, the copilot tool and the inbox's brief.

## AI training — the console's files for each teammate

**Console › Settings › AI training** (`/settings/ai-training` on admin.<domain>; src/lib/ai-training, owner 20 Nov 2026)
holds Deskzo's own `.md`/`.txt` training files for the AI teammates. No workspace sees, lists or edits them.

- **Who it's for.** Each file is for every teammate or the ones ticked (Deskzo AI, Ved, Tara, Kabir, Mira, Arjun,
  Priya), and for every workspace or only the ones chosen. **Off** keeps a file but gives it to nobody.
- **Always give it.** For short rules and tone: the file goes into every answer of its teammates (at most 1,200
  characters of such files). Everything else is searched: only the chunks the question finds are given.
- **Where it's used.** The gateway (src/lib/ai/gateway.ts) gives a teammate's training as a note just before the
  question, never in the system prompt — which then stays the same from question to question, with the tools, so it is
  read from the cache (src/lib/ai/fit-context.ts) — for every feature: copilot → Deskzo AI, inbox → Kabir, research → Ved, nurture → Tara, Automate → Mira, collections,
  bills, receipts and bank matching → Arjun, HR desk → Priya (`FEATURE_TEAMMATE`). At most 2,500 characters a prompt,
  on top of the workspace's own AI Knowledge.
- **Never in the way.** The control plane gets 1.5 s; a failure is an answer without training, logged. What was found
  is kept a minute per process, so a copilot turn's steps send the same prompt (and Ollama can reuse its work on it).
- **A self-hosted model's window.** An OpenAI-compatible account (Ollama, vLLM) has the window its server was
  started with, so each turn is cut to fit it: `AI_LOCAL_CONTEXT_TOKENS` (default 8192 — set it to the same number as
  Ollama's `OLLAMA_CONTEXT_LENGTH`). Older lookups are shortened first, then the oldest exchanges left out, then the
  current question's lookups shortened; the answer gets a quarter of the window, at most 1,536 tokens. Before this, a
  chat failed after two or three questions ("Deskzo AI couldn't answer just now").
- **A call written as text.** A small self-hosted model sometimes writes a tool call as a ```json block, a
  `<tool_call>` tag or a bare object (alone, or in the middle of a sentence) instead of making it. The OpenAI adapter
  hides such blocks as the answer streams
  and runs them as the call they meant (src/lib/copilot/providers/text-tool-calls.ts) — by their `name`, or the one
  tool whose parameters they fit — checked against the tool's schema like any call. `run_report`'s dates default
  (the source's main date, the last 12 months, by month), and `people_directory` answers headcount questions from
  the People directory.
- **Small talk.** A message that is only a greeting, "how are you", a thank-you, "ok" or a goodbye is answered at once
  without the model (src/lib/copilot/small-talk.ts) — no lookup, no credits. A small model with tools otherwise
  looked up a company nobody asked about. The prompt also gives no example references it could copy (it once looked
  up "COM-000123" on "Hello").
- **Try it** shows what a teammate in a workspace would be given for a question, in characters and milliseconds.
- Owners and admins change the files; Settings' viewers read them. Every change is in the platform audit log by name.
- **Many at once** (owner, 23 Nov 2026): tick files in the list (or the header box for every file shown) for a bar
  that switches them on or off, deletes them, or opens **Change…** — teammates, workspaces, "Always give it" and on/off,
  each left as every file has it or set for all of them. Text and chunks are untouched; one audit row
  (`ai.training.bulk_update` / `ai.training.bulk_delete`) names up to 20 of the files.
- Tables in the control database: `platform_ai_training_files`, `platform_ai_training_chunks` (migration
  `20261221100000_ai_training`; `npm run control:migrate`).

## Data masking — what the AI provider sees

Each AI account in the console (Settings › AI) has **Mask customer data**, on by default for every provider's API and off for
Deskzo's own Ollama server. With it on, every request goes through `src/lib/ai/mask.ts` in the gateway (`chargedTurn`):

- Company and contact names (from the workspace's own records, and from the name fields of what tools return), people's
  names — a saved person's first or last name alone too — street addresses, emails, phone numbers (mobiles, landlines,
  numbers abroad), GSTIN, PAN, Aadhaar, IFSC, bank account and card numbers become placeholders such as `COMPANY_K3F9Q` or
  `PHONE_7XM2A`. A company nobody has saved is masked when it's written with its legal ending (Pvt Ltd, LLP, Ltd).
- **Photos and PDFs can't be masked**, so a masked account is never sent one: reading bills and receipts is refused, before
  the file is kept. To have them read, give `bills.read` and `receipts.read` a model that reads images on an account that
  doesn't mask — Deskzo's own server, or a provider's account you have decided may see the files.
- A saved turn not written from masked data (a chat from before masking, or from an account that doesn't mask) is sent as
  its words alone, masked. Its provider's own form, with the thinking that holds real values, is never sent again.
- Between a deploy and its migrations, accounts are taken as masked (Deskzo's own server as not) and AI goes on.
- A placeholder is a hash of the workspace and the value, so the same customer gets the same placeholder in every turn and
  every chat — the model can still reason about "the same company" — and Claude's signed thinking replays unchanged.
- Amounts, dates, order references and product names are left as they are; the model needs them to answer.
- The reply is unmasked as it streams, and tool inputs are unmasked before the tool runs, so people see real names and
  tools search the real data.

Masking is code, not another model: no extra cost, no extra delay. It cannot catch a name Deskzo
doesn't hold, a nickname, a misspelling, or an address written in an unusual way, and a city, state or PIN code in its own
field is left as it is. It lowers what reaches the provider; it doesn't make leakage impossible. Where no customer data may
leave at all, use Deskzo's own server.

## AI activity — usage and chats, for admins

Settings › AI activity (permission `copilot.review`, admins and the super admin by default, not delegable):

- **This month:** credits used, questions asked, chats and people using it; per person their questions, chats, credits this
  month and today, and when they last used it; and what the credits went on, feature by feature.
- **View chats:** every chat of a person's, read-only. A chat its owner deletes is hidden from them (`hiddenAt`) and kept
  here, marked *Deleted by them*; a hidden chat can't be continued.
- **On the record:** each time an admin opens somebody else's chat a row is written to `copilot_reviews`, shown as
  *Chats reviewed lately*. Viewing as somebody can't review.
- The chat panel tells everybody, under the box they type in, that admins can read their chats.

Before a workspace has `20261225200000_copilot_review`, deleting a chat deletes it outright, as before, and reviews aren't
recorded.
