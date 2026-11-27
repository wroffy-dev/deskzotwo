# India (and UAE) market and compliance facts for the SMB SaaS go-to-market plan (as of 30 Oct 2026)

Method note: 19 tool calls. The live MSME dashboards (dashboard.msme.gov.in, udyamregistration.gov.in) and the PIB release page all refused automated fetch (TLS certificate errors / HTTP 403), so the Udyam figures below come from PIB-sourced statements as reported by wire services, IBEF and a Rajya Sabha committee summary. No figure dated later than 14 July 2026 could be confirmed.

## 1. Udyam + Udyam Assist Platform (UAP) registrations

### Takeaway
The report's "~99.9 million (≈9.99 crore) cumulative Udyam + UAP on 29 Oct 2026" **could not be verified and looks high**. The latest official figure I could confirm is **"more than 8.9 crore" (~89 million) as of 14 July 2026**. That total is about 99.3% micro enterprises. It counts registrations, not active or GST-registered businesses. Use "~9 crore (90 million) registrations, mid-2026" unless someone reads the dashboard by hand.

### Cited Findings
- **14 Jul 2026:** a Ministry of MSME statement said about 9 crore MSMEs are registered across the Udyam Registration Portal and the UAP, with over 38 crore jobs reported. The article gives no split by platform or by size. — [NewKerala/IANS, 14 Jul 2026](https://www.newkerala.com/news/a/nearly-crore-msmes-registered-udyam-platforms-generating-38-913.htm); [IANS](https://ianslive.in/nearly-9-crore-msmes-registered-on-udyam-platforms-generating-38-crore-jobs--20260714145911)
- **30 Jun 2026:** a parliamentary reply gave "over 8.84 crore" enterprises (search snippet only; the reply itself was not opened). — [KNN India](https://knnindia.co.in/news/newsdetails/msme/over-884-crore-msmes-registered-on-udyam-platforms-mos-karandlaje)
- **March 2026: Udyam vs UAP split.** About 7.9 crore in total: **4.72 crore on the Udyam Portal and 3.21 crore on the UAP** (informal micro enterprises). — [IBEF MSME Infographic May 2026](https://www.ibef.org/uploads/industry/Infrographics/large/MSME-Infographic-May-2026.pdf); [IMPRI summary table](https://www.impriindia.com/?p=76630)
- **28 Feb 2026:** a Lok Sabha reply gave 7.83 crore MSMEs and 34.50 crore jobs. — [Assam Tribune](https://assamtribune.com/business/udyam-portal-sees-783-cr-msmes-345-cr-jobs-created-minister-1609362)
- **Size split (31 Jan 2026, out of 7.61 crore registered):** 7.56 crore micro (99.3%), 4.88 lakh small, 36,816 medium. This comes from a Rajya Sabha standing committee report. — [The Week, 12 Mar 2026](https://www.theweek.in/news/biz-tech/2026/03/12/rajya-sabha-committee-proposes-a-nano-fix-for-india-msme-woes)
- **Size split (27 Feb 2026, about 7.79 crore):** roughly 99.3% micro, 0.62% small and 0.05% medium. — [IBEF MSME Infographic Feb 2026](https://www.ibef.org/uploads/industry/Infrographics/large/MSME-Infographic-February-2026.pdf)
- **UAP growth over time:** about 37 lakh (Aug 2023), about 1.11 crore (Dec 2023), over 1.5 crore (Mar 2024), about 2.6 crore (Mar 2025), 3.21 crore (Mar 2026). About 70% of UAP units are women-owned, against 20.5% on the main Udyam portal. — [IMPRI](https://www.impriindia.com/?p=76630)
- **Data-quality critique:**
  - About 1 crore registrations were added between 28 Feb and mid-July 2026, which is unexplained in the releases.
  - The combined register now exceeds the ASUSE 2023-24 estimate of 7.34 crore MSME establishments.
  - Only 0.17% of registrants have deregistered for closure.
  - Some releases count unique enterprises and others count registrations.
  - [IMPRI policy note](https://www.impriindia.com/?p=76630)
- **A secondary blog cites "9.6 crore" total from the ministry dashboard.** It is undated and unverified. — surfaced via search ([finvest.ambit.co](https://finvest.ambit.co/blog/udyam-registration-simple-guide-msmes-india)); treat with caution.

### Inferences
- Projecting the Feb–Jul 2026 pace (about 0.24 crore a month) from 8.9 crore in mid-July gives roughly 9.6–9.8 crore by end-October. That fits the unverified "9.6 crore" dashboard figure. **The report's 9.99 crore is at the top of what is plausible and should be marked unverified.**
- The commercially relevant pool is much smaller than the headline:
  - UAP entities (3.2 crore or more) are informal, have no GSTIN, and are mostly women-run nano units. They are unlikely to pay for SaaS.
  - The Udyam-proper base is about 4.7 crore or more. Of that, small and medium firms are under 0.6 crore (about 5.3 lakh at Jan 2026).
- A better TAM anchor for paid B2B software is GST-registered businesses (about 1.5 crore active GSTINs, a figure not verified in this research) rather than Udyam totals.

### Gaps
- I could not read the live dashboard, so I have no October 2026 figure and no confirmation of the 29 Oct claim.
- I found no official count of Udyam registrants that are GST-registered or active. The Udyam form captures GSTIN, but the share is not published in anything I found.
- I found no micro/small/medium split for the July 2026 total.

## 2. GST e-invoicing, 30-day rule, 2FA, IMS

### Takeaway
**The ₹5 crore AATO threshold (Notification 10/2023-CT, effective 1 Aug 2023) is still the law as of October 2026.** I found no official notification lowering it to ₹2 crore, ₹1 crore or "all B2B". The 30-day IRP reporting limit for AATO ≥ ₹10 crore has applied since 1 Apr 2025. 2FA on the e-invoice and e-way bill portals was announced as mandatory, but whether it is actually enforced is unclear. IMS is live and has an offline tool (April 2026), but no 2026 notification makes acting in IMS mandatory before GSTR-3B.

### Cited Findings
- **Threshold:** e-invoicing applies to a registered person whose aggregate turnover exceeded ₹5 crore in any FY from 2017-18. This is under Notification No. 10/2023-Central Tax (10 May 2023), effective 1 Aug 2023, read with Notification 13/2020-CT. Turnover is tested PAN-wide. The source article was reviewed as of 11 Oct 2026 and reports no change. — [TaxGuru, 12 Oct 2026](https://taxguru.in/goods-and-service-tax/gst-invoice-october-2026-rs-5-crore-coverage-30-day-irn-reporting-rule.html)
- **Claims of a ₹2 crore threshold:** some blogs say "effective 1 Oct 2025", others say "1 July 2026". They contradict each other, and none cites a notification. — search results summarised; e.g. [support.taxaj.com](https://support.taxaj.com/portal/en/kb/articles/e-invoicing-threshold-reduced-to-5-crore-compliance-checklist-10-6-2026), [GimBooks 2026](https://www.gimbooks.com/blog/5-crore-e-invoice-turnover-rule-2026). **Treat these as unreliable.**
- **30-day reporting limit:** GSTN advisory dated 5 Nov 2024, effective **1 Apr 2025**, for AATO ≥ ₹10 crore. The IRP rejects invoices, credit notes and debit notes older than 30 days. — [TaxGuru Oct 2026](https://taxguru.in/goods-and-service-tax/gst-invoice-october-2026-rs-5-crore-coverage-30-day-irn-reporting-rule.html); [Taxmann](https://www.taxmann.com/research/gst-new/top-story/222330000000022527/gstn-issues-advisory-on-time-limit-for-reporting-invoices-on-the-irp-portal-news); [Taxreply (advisory text)](https://taxreply.com/gst/GSTN_Advisory__Time_Limit_for_Reporting_e-Invoice_on_the_IRP_Portal_-_Lowering_of_Threshold_to_AATO_10_Crores_and_Above-1455.html)
  - Earlier, from Nov 2023, the limit applied only to AATO ≥ ₹100 crore. There is no limit below ₹10 crore.
- **2FA on the e-invoice and e-way bill portals:**
  - A GSTN advisory of Dec 2024 phased 2FA in: AATO > ₹20 crore from 1 Jan 2025, then all taxpayers from 1 Apr 2025. — [Taxo summary of 18 Dec 2024 advisory](https://taxo.online/latest-news/18-12-2024-gstn-issued-advisory-on-updates-to-e-way-bill-and-e-invoice-systems/); [MBG Corp](https://www.mbgcorp.com/in/insights/advisory-on-updates-to-e-way-bill-and-e-invoice-systems/)
  - Reporting from 2 Apr 2025 says the portal still treated 2FA as optional "for the time being". — [CAalley](https://caalley.com/news-updates/indian-news/no-gst-e-way-bill-without-two-factor-authentication-from-april-1-2025-gstn-to-shortly-make-it-mandatory)
  - A July 2026 trade-press item reports 2FA being rolled out to all e-way bill and e-invoice users. — [India Sea Trade News](https://indiaseatradenews.com/cbic-launches-two-factor-authentication-for-all-e-way-bill-e-invoice/) (not opened)
- **Related:** E-Way Bill 2.0 portal running in parallel since 1 Jul 2025 (search summary; not verified against a GSTN page).
- **IMS (Invoice Management System):**
  - Live since Oct 2024.
  - A GSTN advisory in Oct 2025 said IMS does not change how ITC auto-populates from GSTR-2B to GSTR-3B, or the monthly generation of GSTR-2B.
  - GSTN Advisory No. 658 of 21 Apr 2026 added an IMS Offline Tool (JSON download, act offline, upload).
  - [StudyCafe on GSTN clarification](https://studycafe.in/?p=395612); [Taxscan](https://www.taxscan.in/top-stories/incorrect-information-regarding-changes-in-gst-return-filing-gstn-issues-advisory-on-ims-1434515); [a2ztaxcorp on IMS offline tool](https://a2ztaxcorp.net/?p=30373); [Business Standard on Oct 2025 IMS changes](https://www.business-standard.com/finance/news/invoice-management-gst-october-changes-credit-itc-system-125092400159_1.html)
- **Other Oct–Nov 2026 items:**
  - RCM self-invoices can now be reported on the e-invoice system ("a capability, not yet an obligation").
  - GST TDS and mandatory registration for scrap suppliers from 1 Nov 2026.
  - These were page headlines only, with no notification numbers given. — [TaxGuru Oct 2026](https://taxguru.in/goods-and-service-tax/gst-invoice-october-2026-rs-5-crore-coverage-30-day-irn-reporting-rule.html)

### Inferences
- **The report's ₹5 crore and 1 Aug 2023 claim is correct.**
- Most Udyam micro units (turnover under ₹5 crore) are **not** required to e-invoice. A pitch built on "mandatory e-invoicing" only reaches the over-₹5 crore segment, which is a few lakh businesses, not crores.
- For micro firms the compliance pull comes from GST returns, IMS reconciliation and e-way bills.
- A future cut to ₹1–2 crore is often rumoured but has not been notified. Do not plan on it.

### Gaps
- I did not read the GSTN advisory pages or the einvoice1.gst.gov.in news pages directly; the 30-day rule rests on the advisory as reproduced by tax sites.
- I could not confirm the current enforcement status of 2FA, or whether IMS action has become mandatory in 2026.

## 3. What Indian SMBs pay for business software

### Takeaway
List prices for mass-market Indian billing and accounting software cluster at about **₹250–600 per month per business**, billed annually and before GST. Zoho Books starts near ₹750–900 a month and TallyPrime at about ₹675–750 a month. **The plan's ARPA of ₹399–799 a month sits squarely in this band.** ₹799 is at or above the entry price of established accounting incumbents, and ₹399 is above myBillBook's entry plan. I found no primary industry survey (Bain, Redseer, Zinnov, SaaSBoomi or KPMG) giving a measured average monthly SaaS spend for Indian SMBs.

### Cited Findings
- **myBillBook (vendor page, fetched 30 Oct 2026), billed annually, GST treatment not stated:**
  - Plus: ₹3,490 a year (₹291/mo), 1 user plus a CA.
  - Pro: ₹3,990 a year (₹333/mo).
  - Pro Max: from ₹570/mo, 3 users, 2 businesses.
  - The FAQ says "starts at ₹349/month", which is inconsistent with the plan list.
  - [mybillbook.in/pricing](https://mybillbook.in/pricing)
- **TallyPrime (vendor page, fetched 30 Oct 2026), all plus 18% GST:**
  - Silver (single user): ₹750 a month; ₹8,100 a year (₹675/mo effective); ₹22,500 perpetual.
  - Gold (multi-user): ₹2,250 a month; ₹24,300 a year; ₹67,500 perpetual.
  - [tallysolutions.com/buy-tally](https://tallysolutions.com/buy-tally/)
- **Zoho Books India (secondary guides, Mar–Apr 2026), per organisation per month, excluding GST:**
  - Free tier for turnover under ₹25 lakh.
  - Standard ₹899, Professional ₹1,499, Premium ₹2,999, Elite ₹5,999, Ultimate ₹9,999.
  - Annual billing is about 17% cheaper; the Standard annual price is ₹8,988 a year (about ₹749/mo).
  - [Patron Accounting](https://www.patronaccounting.com/blog/zoho-books-pricing-india-2026); [myBillBook vs Zoho](https://mybillbook.in/s/mybillbook-vs-zoho/) (not verified on zoho.com/in)
- **Vyapar:** secondary listings conflict: ₹699 a year (discounted from ₹1,199), ₹899 a year per device, or ₹1,999 a year. The vendor page did not render for automated fetch. — via search summaries ([Capterra compare](https://www.capterra.com/compare/180579-202732/Vyapar-vs-FloBooks), [Techjockey](https://www.techjockey.com/alternatives/mybillbook-accounting-software)). **Unverified.** Even the highest of these is under ₹200 a month, which shows how low the floor for desktop billing tools is.
- **Practitioner and anecdotal willingness to pay (not survey-based):**
  - Indian SMB B2B SaaS is typically priced at ₹500–5,000 a month, billed monthly. — [24Squad 2026 playbook](https://www.24squad.in/blog/b2b-saas-pricing-india-2026/)
  - Customer interviews suggest about ₹999 a month for a 20-user SMB plan. — [upGrowth](https://upgrowth.in/saas-pricing-packaging-strategy-india-gtm/)
  - Indian buyers are said to pay 50–70% less than US/EU buyers, or to have 5–10x lower willingness to pay. Both claims are unsourced.

### Inferences
- The low end of the market (myBillBook, Vyapar) sets anchor prices for a single-user billing app at about ₹150–350 a month.
- Getting ₹399–799 realized requires one of:
  - multi-user packaging (CRM plus billing plus team);
  - accounting depth comparable to Tally or Zoho Books;
  - compliance features (e-invoice, e-way bill, GSTR).
- If ₹399–799 is meant to be realized *after* annual-prepay discounts and GST exclusion, it is consistent with list prices of about ₹500–999.
- Expect a long tail of ₹0–300 accounts if a cheap single-user plan exists.

### Gaps
- I found no primary report from Bain, Google, Redseer, SaaSBoomi, Chiratae, Zinnov or KPMG quantifying Indian SMB monthly software spend or ARPA. My searches surfaced only blogs and paywalled Statista pages.
- I could not confirm Vyapar pricing on its own site, or Zoho prices on zoho.com/in.
- I could not find any public realized ARPA for Khatabook, Vyapar or myBillBook.

## 4. Free-to-paid conversion and SMB churn benchmarks

### Takeaway
A **3–10% free-to-paid** assumption is reasonable for **freemium**:
- Medians are roughly 2.6–5%, and 8% in ChartMogul's cross-model figure.
- The top quartile reaches 8–12%.

It is conservative for **time-limited free trials**, where medians are 8–18.5% for opt-in trials and about 49% when a card is required. SMB SaaS logo churn benchmarks are commonly **3–7% a month (about 30–58% a year)**. I found no India-specific primary benchmark, and most figures are second-hand.

### Cited Findings
- **ChartMogul Conversion Report:** median free-to-paid of 8% across product types. — [ChartMogul](https://chartmogul.com/reports/saas-conversion-report/)
- **Freemium median:** about 3–5%, with the top quartile at 8–12%. — [RevTurbine via reader](https://hn.jakechampion.name/reader/https://www.revturbine.com/resources/freemium-vs-free-trial)
- **Freemium figure of 2.6%** (aggregated). — [Flint](https://www.flint.com/blog/b2b-saas-free-trial-conversion-rate-statistics)
- **B2B free-trial median:** 18.5% (1Capture, 10k+ companies), with the top quartile at 35–45%. — [Flint](https://www.flint.com/blog/b2b-saas-free-trial-conversion-rate-statistics)
- **Kyle Poyar analysis of 200 B2B products:** median free-trial conversion of 8%. — [Userpilot](https://userpilot.com/blog/saas-average-conversion-rate)
- **Trials that take a card up front ("opt-out")** convert at about 48.8%, against 18.2% for opt-in trials. — [Userpilot](https://userpilot.com/blog/free-trial-conversion-rate/)
- **SMB SaaS churn:** 3–7% a month, or 30–58% a year (citing Vena 2025). — [Vena](https://www.venasolutions.com/blog/saas-churn-rate)
  - Healthy SMB churn is 3–5% a month. — [UserJot](https://userjot.com/blog/saas-churn-rate-benchmarks)
- **Recurly cross-industry subscription churn median:** about 3.27% a month. This is not specific to SaaS, and some pages describe it ambiguously. — via search summary ([Orb](https://www.withorb.com/blog/saas-churn-statistics))
- **ChartMogul segment medians (unverified, single secondary source):** about 14–18% annual logo churn for self-serve products with ACV under $1k. — [StealthAgents](https://stealthagents.com/research/saas-churn-rate-statistics-2026)

### Inferences
- For Indian micro-SMBs on monthly plans, the global SMB band of 3–7% monthly churn is a sensible prior. Plan for the upper half (5–7%) until the product has its own cohort data.
- Annual prepay plans, which are common in Indian billing apps, mask churn until renewal. Model renewal rates separately.

### Gaps
- I found no India-specific primary data on free-to-paid conversion or SMB SaaS churn (SaaSBoomi, Chiratae or others).
- I did not open the original OpenView, High Alpha or ProfitWell reports. OpenView shut down in 2024, so its last benchmarks are 2023 data and are older than the other figures here.

## 5. UAE: SME count and e-invoicing timeline

### Takeaway
- **SMEs:** about 94–95% of UAE businesses. There were about 1.4 million registered companies at the end of 2025, so roughly 1.3 million SMEs by inference.
- **E-invoicing:** mandatory B2B and B2G e-invoicing, using the Peppol-based five-corner model with Accredited Service Providers (ASPs), phases in from 1 Jan 2027.
- **Large firms:** businesses with revenue of AED 50m or more must appoint an ASP by **30 Oct 2026**.
- **Everyone else:** businesses under AED 50m go live **1 Jul 2027** and must appoint an ASP by 31 Mar 2027. Government entities go live 1 Oct 2027.

### Cited Findings
- **Phases (KPMG Tax News Flash, 22 Jul 2026):**

  | Phase | Scope | Appoint an ASP by | Go-live |
  |---|---|---|---|
  | 1 | Revenue of AED 50m or more | 30 Oct 2026 | 1 Jan 2027 |
  | 2 | Revenue under AED 50m | 31 Mar 2027 | 1 Jul 2027 |
  | 3 | Government entities | 31 Mar 2027 | 1 Oct 2027 |

  Invoices are exchanged as structured XML, and the mandate applies whether or not a business is VAT-registered unless it is excluded. — [KPMG TNF](https://kpmg.com/us/en/taxnewsflash/news/2026/07/tnf-uae-phased-implementation-of-e-invoicing-beginning-january-1-2027.html)
- **Legal basis and rollout:**
  - Ministerial Decision No. 244 of 2025 sets the phased rollout.
  - A pilot and voluntary adoption run from 1 Jul 2026.
  - B2C is not yet in scope.
  - The penalty for failing to appoint an ASP or implement is reported as AED 5,000 a month.
  - [Tally MENA guide](https://tallysolutions.com/mena/uae-vat/uae-e-invoicing-timeline-2026-2027-complete-phase-by-phase-implementation-guide/); [Fonoa](https://www.fonoa.com/resources/blog/uae-national-electronic-invoicing-system-rollout); [VATit](https://vatit.com/e-invoicing-guide/united-arab-emirates/)
  - One source (Sovos) shows a conflicting "31 July 2026" date for SMBs, likely an error.
- **SME share and company count:**
  - SMEs are about 95% of UAE businesses and over 85% of private-sector employment (Ministry of Economy and Tourism). The Khalifa Fund puts it at about 94% and 86%. — [Gulf News](https://gulfnews.com/business/markets/uae-small-business-licences-jump-over-900-in-two-decades-1.500664805)
  - The UAE added about 250,000 companies in 2025, for a total of about 1.4 million at year-end. The target is 2 million or more by 2031. — [The National, 6 Jan 2026](https://www.thenationalnews.com/business/economy/2026/01/06/uae-adds-250000-more-companies-in-2025-as-llc-rules-simplified); [WAM](https://www.wam.ae/en/article/bltjo32-minister-economy-uae-seeks-increase-number)
  - SMEs contributed 63.5% of non-oil GDP (mid-2022, older figure). — [Gulf News](https://gulfnews.com/business/markets/uae-small-business-licences-jump-over-900-in-two-decades-1.500664805)

### Inferences
- **Phase 2 (1 Jul 2027) is when SMBs become a market for UAE e-invoicing**, and the ASP deadline of 31 Mar 2027 is the buying window.
- A SaaS entrant would probably need to integrate with an accredited ASP rather than become one. ASP accreditation is a separate regulatory process, not researched here.

### Gaps
- I did not read the official MoF or FTA text, so the decision numbers and the Peppol five-corner detail rest on secondary sources (Tally, Fonoa, VATit).
- I found no exact official SME count, only percentages and the total number of companies.
