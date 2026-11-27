# Competitors and India pricing: software resellers, FMCG distribution, MSPs, retail billing (as of Oct 2026)

All URLs accessed 2026-10-30 unless noted. "Official" = vendor's own page; "aggregator" = G2/Capterra/Techjockey/blog estimates (lower confidence). Research budget was limited (~20 tool calls), so several named vendors were not fetched directly; they are listed under Gaps rather than filled from memory.

## (a) Software / cloud licence resellers and distributors: what tooling exists, is it in India, what does it cost, what do Indian resellers use?

### Takeaway
Distributor marketplaces (Ingram Micro, Redington CloudQuarks, Crayon) are the plumbing Indian Microsoft CSP resellers buy through; they are free-to-partner platforms paid for by distributor margin, not per-seat software, so they are not a direct pricing comparator. No source found shows a purpose-built India renewal/quote/billing tool that Indian resellers broadly use; the evidence (thin) points to resellers running a generic CRM plus Tally plus the distributor portal, with CSP-specific tools (Work 365, Goolash, CSP Control Centre) being Western/Autotask-centric. Pax8 shows no India presence in any source found.

### Cited Findings
- Pax8: search found APAC activity (APAC website launch, Australia/New Zealand expansion, a January 2026 APAC leadership hire) but no India launch or India partner programme. — [Pax8 APAC site launch](https://www.pax8.com/en-apac/news-post/pax8-hits-new-milestones-launches-custom-website-for-apac-region); [ITPro ANZ expansion](https://www.itpro.com/business-operations/managed-service-provider-msp/367525/cloud-marketplace-pax8-expands-into); [IT Brief India tag page](https://itbrief.in/tag/pax8)
- Ingram Micro Cloud joined Microsoft's CSP programme in India in September 2015 (old, but establishes long-standing India CSP distribution). — [Ingram Micro press release](https://ir.ingrammicro.com/press-releases/detail/278/ingram-micro-cloud-announces-participation-in-microsofts-cloud-solution-provider-program-in-india)
- Ingram Micro acts as the distributor handling licensing transactions, billing and provisioning for CSP resellers, with Xvantage as its operational platform (third-party partner guide, not official). — [msft-partner-site resource](https://msft-partner-site.pages.dev/resources/ingram-micro)
- Redington launched CloudQuarks as a self-service digital platform for onboarding cloud products in India (FY22 results). — [CRN India](https://www.crn.in/?p=51509); [Redington FY22 PDF](https://redingtongroup.com/wp-content/uploads/2023/04/Redington-India-reports-strong-double-digit-growth-in-Q4-and-FY22-Results.pdf)
- Microsoft appointed Crayon Software to its CSP programme in India (indirect provider). — [Microsoft News India](https://news.microsoft.com/en-in/microsoft-appoints-crayon-software-to-its-cloud-solution-provider-program-in-india/)
- Ogma markets Microsoft CSP in India with INR billing and GST invoices — i.e., GST invoicing for CSP is a selling point local resellers advertise. — [Ogma](https://ogma.in/solutions/microsoft-csp-india)
- CSP-specific subscription tools that exist: Datto/Kaseya's Goolash (links CSP account to Autotask, tracks licence changes), Work 365 by IOTAP (CSP billing/subscription management, on Azure Marketplace), CSP Control Centre (listed on Capterra India). None advertised Tally or Zoho connectors in results. — [Datto Goolash](https://www.datto.com/integrations/goolash-1/); [Work 365 on Azure Marketplace](https://azuremarketplace.microsoft.com/en/marketplace/apps/iotapapps.e1ae1652-82c2-4f8b-b846-d5d59d0be038); [CSP Control Centre, Capterra India](https://www.capterra.in/software/1032480/csp-control-centre)
- ScalePad Quoter (MSP quoting tool) integrates with Zoho CRM for quote creation. — [ScalePad Quoter + Zoho CRM](https://www.scalepad.com/quoter/integrations/zoho-crm)
- Microsoft itself frames renewals as "a strategic lever" for partners (partner blog), confirming renewals are a core reseller workflow. — [Microsoft Tech Community partner blog](https://techcommunity.microsoft.com/blog/partnernews/partner-blog--renewals-a-strategic-lever-for-partners-to-drive-customer-engageme/4404623)
- Zoho Billing (formerly Zoho Subscriptions), India page, official: Standard US$50/org/month monthly or US$39 billed annually (up to 3 users); Premium US$100 monthly / US$79 annually (up to 10 users); extra users US$9/month or US$7.5 annually; up to 100,000 invoices/year and annual billed revenue up to ₹8 crore; prices exclude GST. The India page displayed USD, not INR, when fetched. — [Zoho Billing pricing (IN)](https://www.zoho.com/in/billing/pricing/)

### Inferences
- Distributor marketplaces are complements, not competitors: a reseller CRM/renewal tool would sit on top of Ingram/Redington/Crayon portals. The winnable gap is the reseller's own pipeline: renewal calendar, quote, GST invoice, collections, OEM rebates — which the CSP tools found are built around Autotask/ConnectWise (US MSP stack), not Tally/GST.
- Zoho Billing's per-organisation pricing (~US$39–79/month for 3–10 users) is the realistic low-end price anchor for "subscription billing" an Indian reseller would compare against.

### Gaps
- No pricing or India-availability confirmation fetched for CloudBlue, AppDirect, Sherweb, Rhipe/Crayon marketplace, Redington CloudQuarks (fees), Ingram Xvantage (fees), ConnectWise Sell/CPQ, Salesforce Sales Cloud/CPQ India pricing, or Zoho CRM India pricing. These need direct fetches.
- No Reddit/partner-forum evidence found on what Indian Microsoft/Autodesk resellers actually use day to day for renewals; the "CRM + Tally + distributor portal + Excel" picture is an inference, not sourced.
- No 2026 India-specific news on Redington/Ingram CSP renewals or Microsoft CSP rule changes affecting Indian tier-2 resellers.

## (b) FMCG / kirana distribution: DMS and SFA vendors, pricing, who pays, deal shape

### Takeaway
Indian FMCG DMS/SFA (Bizom, FieldAssist) is quote-only and sold to brands, not distributors; both are established at ₹65–90 crore revenue scale. Salesforce Consumer Goods Cloud lists at US$100–525/user/month — enterprise-only. Distributor-side accounting is dominated by low-cost perpetual licences (Marg ~₹8–25k one-time). A per-person all-in-one would compete against free-to-distributor brand-paid DMS on one side and cheap Tally/Marg/BUSY on the other — a hard squeeze.

### Cited Findings
- Bizom and FieldAssist do not publish pricing; buyers are routed to quotes. Aggregator "from" prices (Bizom US$20; FieldAssist ₹7) are unverified and not DMS rates. — [Capterra Bizom pricing](https://www.capterra.com/p/146321/Bizom/pricing/); [G2 FieldAssist pricing](https://g2.com/products/fieldassist/pricing); [Spotsaas FieldAssist](https://www.spotsaas.com/product/fieldassist/pricing)
- Bizom's subscription is structured around user count and module selection, numbers shared on request (third-party comparison). — [MAssist blog comparison](https://blog.massistcrm.com/massist-vs-fieldassist-vs-bizom-comparison)
- Bizom: Series B ~US$12M in Dec 2024 led by Pavestone with IndiaMART participating; total funding US$18.26M+; FY25 revenue ₹90.9 Cr (up 15.7% from ₹78.6 Cr; same page also shows ₹86.2 Cr — inconsistent); FY25 net loss ₹13.6 Cr. — [Inc42 Bizom financials](https://inc42.com/company/bizom/financials/); [Inc42 Bizom funding news](https://inc42.com/buzz/bizom-pockets-12-mn-funding-to-help-retail-brands-boost-distribution-process/amp)
- FieldAssist: FY25 revenue ₹66.5 Cr (up 34.3%), profit after tax ₹64.7 lakh; minimal external equity (largely bootstrapped; a SIDBI debt round in 2017). — [Inc42 FieldAssist financials](https://inc42.com/company/fieldassist/financials/); [CB Insights](https://www.cbinsights.com/company/field-assist/financials)
- Salesforce Consumer Goods Cloud (Retail Execution), official India-region page (no INR shown; USD), per user/month billed annually, annual contract required: Merchandiser Enterprise $100; Field Sales Enterprise $225; Field Sales Unlimited $400; Strategic Sales Enterprise $350; Strategic Sales Unlimited $525. INR pricing only via sales (1800-420-7332). — [Salesforce IN CG Cloud pricing](https://www.salesforce.com/in/consumer-goods/retail-execution-software/pricing/)
- Marg ERP (distributor/pharma accounting): one-time editions Basic ₹8,100 (1 user), Silver ₹12,600 (up to 3 users), Gold ₹25,200 (up to 5 users); Marg Cloud ~₹999/user/month; AMC ~₹2,000–5,000/year; sold through dealers with no enforced list price. Third-party; G2 says Marg publishes no pricing. — [itforsme Marg ERP India](https://itforsme.in/pricing/marg-erp-india); [ERP Research Marg](https://www.erpresearch.com/pricing/marg-erp); [G2 Marg](https://g2.com/products/marg-erp/pricing)
- Generic field-sales software benchmark: US$30–150/user/month depending on scale and region (blog estimate, not India-specific). — [Fieldproxy cost guide](https://www.fieldproxy.ai/blog/field-service-software-cost-guide-pricing-comparison-2024)

### Inferences
- "Who pays": the evidence that pricing is by user and module sold through sales teams, combined with Bizom's IndiaMART/brand positioning, is consistent with brands buying SFA for their reps and pushing DMS to distributors — but no source in this pass states explicitly that the brand pays for distributor DMS seats. Treat as likely, unconfirmed.
- With a brand-paid DMS installed at the distributor and Tally/Marg/BUSY for books, a distributor has little reason to buy a third per-person system. The opening, if any, is small distributors of multiple brands who want one view across brands, and that is a niche.

### Gaps
- Not fetched: BeatRoute, Botree DMS, Ivy Mobility pricing/scale; Tally Prime and BUSY current prices (should be fetched from tallysolutions.com and busy.in); per-distributor DMS pricing; any primary statement of brand-pays model.

## (c) MSP / IT service providers: PSA/RMM vendors and pricing per technician

### Takeaway
MSP tooling is priced in USD/GBP at roughly US$66–250 per technician/month (Halo £66/agent; Atera US$129–249/tech; ConnectWise PSA ~US$75–145/user by transaction data). Halo now shows an India ₹ price option; SuperOps (Chennai-founded, US$54.4M raised) has moved to quote-only per-endpoint pricing with a 150-endpoint minimum, i.e. it has moved upmarket. Indian small IT service firms are price-sensitive and many of these tools are priced for US MSPs, so a cheaper Indian per-person tool has room, but SuperOps and Zoho/ManageEngine sit right there.

### Cited Findings
- HaloPSA (Halo), official: £66 per agent/month billed annually; no tiers or bolt-ons; named or concurrent licences same price; end users free; onboarding package mandatory at bespoke cost; currency selector includes India (₹); Enterprise unlimited licences US$1M/year; 15% charity discount. — [Halo pricing](https://usehalo.com/pricing/) (halopsa.com/pricing redirects here)
- Atera MSP plans (Atera's own page returned 403; figures from multiple aggregators that agree): Pro ~US$129/tech/month annual or $139 monthly; Growth ~$179/$189; Power ~$209/$249; Superpower custom. Older sources show different numbers (e.g., Growth $169). — [CostBench Atera](https://costbench.com/software/rmm/atera); [SuperOps Atera pricing page](https://superops.com/atera-pricing); [eesel Atera pricing 2026](https://www.eesel.ai/blog/atera-pricing)
- ConnectWise PSA: no public pricing (G2). Vendr transaction data (via Flamingo, Feb 2026) puts 10–25-user buyers at ~US$95–145/user/month annual, 50+ users at $75–110; other estimates as low as $25–65. Wide spread; treat as ranges. — [G2 ConnectWise PSA](https://www.g2.com/products/connectwise-psa/pricing); [Flamingo ConnectWise pricing](https://www.flamingo.run/blog/connectwise-pricing); [Rallied guide](https://rallied.pages.dev/blog/connectwise-psa-pricing/)
- SuperOps, official: plans Prime (Windows/macOS/Linux) and Prime Plus (adds iOS/Android MDM), both "Request pricing"; billed per endpoint per month with unlimited technicians; minimum 150 endpoints; no INR pricing shown. — [SuperOps pricing](https://superops.com/pricing)
- SuperOps raised US$25M Series C (Jan 2025, led by March Capital, with Addition and Z47), total US$54.4M; tripled customers in prior year; present in 104 countries; HQ Chennai with Dallas office; funding aimed at mid-market/enterprise push. — [SuperOps press release](https://superops.com/media-release/superops-raises-$25M-in-series-c); [TechCrunch](https://techcrunch.com/2025/01/30/superops-bags-25m-to-use-ai-and-better-help-managed-service-providers); [Z47](https://www.z47.com/news/z47-superops-series-c-march-capital)

### Inferences
- SuperOps' shift to per-endpoint, 150-endpoint-minimum quoting leaves the bottom of the Indian market (small IT service shops with 2–10 technicians and under 150 endpoints) less served by it — a possible opening for a per-person Indian tool combining tickets, AMC contracts, renewals and GST billing.
- A per-person Deskzo price (₹ hundreds/month) would be an order of magnitude below US$66–250/tech, but these tools include RMM (remote agents, patching) which Deskzo would not; the comparison is with the PSA half only.

### Gaps
- Not fetched: Kaseya (VSA/Autotask/BMS) pricing, ManageEngine ServiceDesk Plus MSP and Endpoint Central MSP India pricing, Zoho Desk India pricing, NinjaOne. Atera's official page blocked fetch (403). No data on how many Indian MSPs use each tool.

## Retail billing apps for kirana and small shops: current India plan prices

### Takeaway
Small-merchant billing in India costs roughly ₹3,000–4,300 a year per business (Vyapar, myBillBook), with multi-year discounts down to well under ₹3,000/year; priced per business, not per person, with 1 user plus a CA on entry plans. A per-person SaaS cannot win kirana on price or simplicity; these apps are the floor.

### Cited Findings
- myBillBook, official: Plus ₹3,490/year (₹291/month equivalent, billed annually; 1 business, 1 user + 1 CA; Android/iOS/Web); Pro ₹3,990/year (₹333/month; adds desktop app, 500 SMS/WhatsApp a year, unlimited godowns); Pro Max from ₹570/month billed annually (2 businesses, 3 users + CA; e-way bills, e-invoicing, loyalty, POS billing, Tally export, recurring billing). Yearly saves up to 20%, multi-year up to 65%. GST inclusion not stated; the FAQ's "basic plan from ₹349/month" conflicts with the ₹291 shown. — [myBillBook pricing](https://mybillbook.in/pricing)
- Vyapar: official page (vyaparapp.in/pricing) did not render prices on fetch. Aggregators: Desktop Silver ~₹3,399/year, Desktop Gold ~₹3,699/year; Mobile+Desktop Silver ~₹3,999, Gold ~₹4,299; 3-year Desktop Gold ₹8,199 (Techjockey) or ₹8,848 (GetApp). Oct 2024 figures were ₹3,599 Silver / ₹3,999 Gold. International Gold ~US$99.99/year after a July 2026 change. — [Techjockey Vyapar](https://www.techjockey.com/detail/vyapar); [Capterra Vyapar pricing](https://www.capterra.com/p/180579/Vyapar/pricing/); [Techjockey Q&A Oct 2024](https://www.techjockey.com/question/12078/what-are-the-pricing-plans-for-vyapar); [PricingSaaS Vyapar diffs 2026W28](https://pricingsaas.com/companies/vyapar/diffs/2026W28)
- Marg ERP (also used by retail/pharma shops): one-time ₹8,100–25,200 depending on users; cloud ~₹999/user/month (third-party). — [itforsme Marg ERP India](https://itforsme.in/pricing/marg-erp-india)
- GoFrugal: no INR price found; one listing gives cloud pricing of Retail US$30/register/month or US$300/register/year (QSR $13/month or $130/year). — [Techjockey GoFrugal](https://www.techjockey.com/detail/gofrugal-retail-pos)

### Inferences
- Per-business pricing at ~₹3.5k/year with one user means a shop owner pays roughly what Deskzo One would charge per person for a few months (₹1,499 per person in the workspace's pricing memory). Retail billing is not a realistic lead vertical; at most an add-on for customers who already run Deskzo.

### Gaps
- Zoho POS India pricing: the zoho.com/in/pos/pricing.html URL returned 404; not retrieved. GoFrugal official INR pricing and Vyapar official page prices not confirmed. Whether myBillBook prices include GST is not stated.
