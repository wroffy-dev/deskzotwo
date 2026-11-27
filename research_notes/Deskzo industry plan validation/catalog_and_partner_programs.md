# Catalog data sources and software vendor partner programs (India, as of 30 Oct 2026)

Research note scope: GS1 India DataKart, TecAlliance TecDoc, Microsoft CSP, Autodesk's new transaction model, and India software distributors' platforms and APIs. Research was done 30 Oct 2026 with web search and page fetches. Several primary documents could not be read: the GS1 India fee PDF and terms PDF, the Autodesk 10-K (HTTP 403), and the YourStory Autodesk India Store article (HTTP 403). Those gaps are flagged below.

## 1. GS1 India DataKart: what solution providers get, on what terms

### Takeaway
DataKart is GS1 India's national product-data repository. Brand owners upload GTIN-keyed attributes, and retailers and "solution providers" can access the data. The public solution-provider page describes a paid registration with KYC documents. It does not publish an API specification, a field list, a free tier, fee amounts or usage restrictions, so the plan's assumption of an open catalog API that Deskzo can redistribute to merchants is unverified. Treat it as a commercial negotiation with GS1 India.

### Cited Findings
- GS1 India's site lists separate DataKart pages for Retailers, Brand Owners, Solution Providers, Premium and Trace, plus a site-wide Terms and Conditions PDF — [GS1 India llms.txt](https://www.gs1india.org/llms.txt)
- **What the solution-provider page offers:**
  - The page promises access to "millions of retail products" uploaded by "thousands of brand owners".
  - Listed attributes include dimensions, manufacturing details, nutritional information and expiry dates.
  - Its stated use is integration into POS scanning solutions.
  - Its stated benefits are accurate data, easy integration with local software, standardised formats and real-time updates.
  - The page names no API, no endpoints, no field list and no image rights.
  - Source: [DataKart for Solution Providers](https://www.gs1india.org/datakart/datakart-for-solution-providers), fetched 30 Oct 2026.
- **Registration requirements:**
  - Scanned copies of the company PAN (or the proprietor's PAN), GST/VAT/TIN, the ROC certificate for an LLP or company, proof of company status, audited balance sheets for the last two years, and proof of fee payment.
  - The form is completed online and the documents are emailed to info@gs1india.org.
  - Fees are in a linked "fee structure" PDF. The page itself gives no amounts.
  - Source: [DataKart for Solution Providers](https://www.gs1india.org/datakart/datakart-for-solution-providers)
- **Main DataKart page features:**
  - Digital Link QR codes, mapping several FSSAI licence numbers to one GTIN, and SSCC generation.
  - Sharing with retailers, e-tailers, the Smart Consumer app, Verified by GS1 and government bodies.
  - Sync with the GS1 Cloud registry, DataKart Trace, and a Premium tier.
  - A testimonial mentions "GS1 India API traceability services", but the page has no API documentation.
  - Source: [GS1 India DataKart](https://www.gs1india.org/services/datakart)
- **Product counts conflict:**
  - GS1 India's own blog says DataKart carries "data of over 20 million products" (undated page) — [GS1 India blog: What is DataKart?](https://gs1india.org/blog/how-datakart-is-revolutionising-product-data-exchange-across-sectors)
  - A third-party June 2025 stats blog cites about 42.8 million barcoded products from about 33,000 Indian companies — [indiafoodstats blog, June 2025](https://indiafoodstats.blogspot.com/2025/06/open-food-facts-june-2025-stats.html). This is secondary and does not reconcile with GS1's figure.
  - An older Zee Business piece said about 7.5 million products from about 14,000 manufacturers (undated) — [Zee Business](https://zeebiz.com/companies/news-how-datakar-powered-smart-consumer-app-is-empowering-online-shoppers-to-make-better-purchase-decisions-93516)
- **Retailer example:** GS1 UK reports that BigBasket used DataKart and Verified by GS1 to cut catalogue errors across more than 20,000 products and more than 1,000 brands. That is BigBasket's own catalogue, not a DataKart total — [GS1 UK case study](https://www.gs1uk.org/insights/news/GS1India-building-trust-and-boosting-efficiency-with-verified-product-data)
- **Excerpted DataKart terms (unverified):** A third-party legal database excerpts DataKart service terms from an unspecified agreement. They say GS1 India may revoke access on 30 days' written notice, access is suspended when the underlying GS1 barcode subscription lapses, and liability is capped at the fees paid. It is unknown whether these terms apply to solution providers — [Law Insider: "DataKart Service"](https://www.lawinsider.com/dictionary/datakart-service)
- **Site-wide terms PDF:** The Terms and Conditions PDF linked from the site is one page, created 20 July 2022, and could not be text-extracted. Its contents are unverified — [GS1 India T&C PDF](https://admin.gs1india.org/uploads/Terms_and_Conditions_ad3c6beced.pdf)

### Inferences
- **Data flow is brand-owner controlled.** Brand owners upload and share data with chosen recipients (retailers, e-tailers, apps). A solution provider most likely gets data that brand owners have shared or published, not an unrestricted bulk dump. Merchant-facing auto-fill ("scan a barcode, get the product") is plausible for products whose owners publish to DataKart. Coverage of long-tail and unbranded SKUs will be poor.
- **Registration is aimed at established vendors.** The KYC asks for two years of audited balance sheets, so it suits a registered company such as Deskzo or Wroffy, not individual merchants.
- **Redistribution rights are the key open question.** Whether Deskzo may cache the data and show it to many tenant merchants could not be confirmed and must be settled in writing with GS1 India.

### Gaps
- Fee amounts. The fee-structure PDF was linked but not read.
- Whether a REST API or bulk feed exists for solution providers, and its field list and image rights.
- Caching and storage limits, redistribution to merchants, brand-owner consent mechanics and rate limits. No solution-provider-specific terms were found publicly.
- Whether a free tier exists. None is mentioned anywhere.
- An authoritative 2026 count of products and brands. Published figures range from 7.5M to 42.8M and are mostly undated.
- Recommended next step: email info@gs1india.org for the solution-provider agreement and the fee PDF.

## 2. TecAlliance TecDoc: India coverage and licensing

### Takeaway
TecAlliance has a Chennai-based Indian subsidiary and a localised Indian TecDoc catalogue built with ACMA and Hella India. It is active in 2026: MotoDoc launched at ACMA Automechanika in February 2026. Licensing for software vendors is negotiated directly with TecAlliance, with no public price list. Indian coverage figures in the press are old, and no credible Indian alternative fitment database was found.

### Cited Findings
- **MotoDoc launch (7 Feb 2026):**
  - At ACMA Automechanika 2026 in New Delhi, Automoto and TecAlliance unveiled MotoDoc, a garage operating system covering intake, diagnostics, parts identification, repairs, billing and customer engagement.
  - It uses the TecDoc catalogue for vehicle and part identification, with TecAlliance described as the "data partner".
  - Ravish Deshpande is MD – India, TecAlliance.
  - The article gives no coverage statistics or licence terms.
  - Source: [Motor India, 7 Feb 2026](https://www.motorindiaonline.in/tecalliance-and-automoto-launch-motodoc-to-digitise-indias-workshop-ecosystem/)
- **Indian catalogue partners:** The Indian catalogue was built with Hella India Lighting, ACMA and the TecAlliance India team — [Motor India: Hella India Lighting and TecAlliance team up](https://motorindiaonline.in/hella-india-lighting-ltd-and-tecalliance-team-up) (dated before 2026; exact date not captured)
- **Coverage claims (old):** Trade press reported about 100 aftermarket brands in the Indian TecDoc catalogue and "high coverage of domestic vehicles" (circa 2023). A 2017-era report claimed Indian reference data covering 85% of the Indian vehicle park. All figures are dated — [Motor India: TecAlliance leading India's aftermarket evolution](https://www.motorindiaonline.in/tecalliance-leading-the-charge-in-indias-aftermarket-evolution/); [Pressebox: TecDoc vehicle reference data India](https://pressebox.com/pressrelease/yooze-gmbh-frechen/tecdoc-vehicle-reference-data-india/boxid/371781)
- **Older India pricing:** An earlier report cited the Indian catalogue from Rs 355 a month and global data from Rs 15,930 a year. These are catalogue-user prices, likely outdated, not a data licence for software vendors — [Autocar Pro: TecAlliance eyes India business at Auto Expo](https://autocarpro.in/news-national/tecalliance-eyes-slice-of-india-business-at-auto-expo-components-show-55417)
- **Expansion beyond passenger vehicles:** In 2024 Deshpande said TecAlliance had built solutions for passenger vehicles and was exploring other segments, including EVs — [Motor India](https://www.motorindiaonline.in/tecalliance-leading-the-charge-in-indias-aftermarket-evolution/)
- **Licensing model (secondary source):**
  - The TecDoc licence comes directly from TecAlliance GmbH.
  - Cost depends on data volume, number of end users and distribution model.
  - There is "no public fixed price", and terms are negotiated annually.
  - Source: [Dev-Opla: What is TecDoc (and is the license worth it)?](https://dev-opla.com/resources/what-is-tecdoc-auto-parts-ecommerce-guide) (vendor blog)
- **Access channels:** TecDoc is offered as the TecDoc Catalogue, a Web Service, data packages and IDP APIs. Brand manufacturers act as Data Suppliers and supply the data, while software vendors and distributors license it as data users — [Prodexa KB: TecDoc](https://prodexa.com/en/kb/tecdoc/)
- **Ownership terms:** TecAlliance's GTC state that the databases and data are TecAlliance-owned and copyright-protected, and grant a "non-exclusive, non-transferable" right of use — [TecAlliance GTC (EN) PDF](https://a.storyblok.com/f/297549/x/d6dca87535/gtc-en.pdf)

### Inferences
- **Vendor licence is a negotiation, not self-serve.** For Deskzo to show fitment data to many tenant parts shops, it would need a redistribution or per-end-user licence from TecAlliance. Pricing would be per deal, and the data cannot be passed on to tenants as their own.
- **Coverage leans to cars.** Indian coverage appears strongest for passenger cars from catalogue-participating brands. Two-wheelers, three-wheelers and commercial vehicles (the bulk of Indian parts retail) are probably thinner. This is not verified.
- **MotoDoc is the model.** An integration partnership with TecAlliance India is the precedent route for an Indian software vendor.

### Gaps
- Current (2025–2026) counts of Indian makes, models and brands in TecDoc.
- India-specific pricing for software-vendor or data-user licences.
- Any credible Indian alternative fitment database. None was found in this search; OEM catalogues such as Maruti/Mobis/TVS e-catalogues were not researched.

## 3. Microsoft CSP: models, API, the 2025–26 changes, and what it means for Wroffy and Deskzo

### Takeaway
Since 1 October 2025 (FY26), CSP direct bill needs at least US$1M trailing-12-month CSP revenue at the Partner Global Account (PGA) level, plus at least one Solutions Partner designation, a paid ASfP/PSfP support plan, the security score and an annual reassessment. Partners that miss it are moved to indirect reseller.

The Partner Center REST API and sandbox are available only to direct-bill partners. Indirect resellers lose API access and must order through a distributor (indirect provider). A small Gurugram reseller such as Wroffy is almost certainly indirect.

For Deskzo, that means automating provisioning and renewals has to run through the distributor's API (Ingram Xvantage, TD SYNNEX StreamOne Ion, Redington CloudQuarks), not Microsoft's Partner Center API.

### Cited Findings
- **Direct-bill entry requirements:**
  - The partner must first transact as an indirect reseller for at least 12 months.
  - It needs at least US$1M eligible CSP revenue as an indirect reseller at PGA level over the preceding 12 months, verified at Microsoft's sole discretion.
  - It needs Advanced or Premier Support for Partners, completion of the mandatory security-score items (MFA, a security contact, a 24-hour alert response) and at least one Solutions Partner designation.
  - It must pass an automated capabilities assessment. One item is "Billing and provisioning systems: Automated platforms based on API integration with Partner Center".
  - Page dated 2 Oct 2025, updated 18 May 2026.
  - Source: [MS Learn: Requirements for CSP direct-bill partners](https://learn.microsoft.com/en-us/partner-center/enroll/direct-partner-new-requirements)
- **Annual reassessment:**
  - Since October 2025, direct-bill partners are reassessed annually in their onboarding anniversary month.
  - They need at least US$1M TTM Direct Bill revenue at PGA level; indirect-reseller revenue is excluded.
  - Partners that fail must transition to indirect reseller and wait one year before reapplying.
  - Source: [MS Learn: direct-partner requirements](https://learn.microsoft.com/en-us/partner-center/enroll/direct-partner-new-requirements)
- **Threshold history:**
  - The direct-bill threshold rose from US$300K (FY25) to US$1M (FY26), announced in May 2025 and effective 1 October 2025.
  - Distributors (formerly "indirect providers") need at least US$30M TTM per authorised region.
  - Indirect resellers need at least US$1,000 TTM billed revenue at the reseller tenant level, business vetting and the security score.
  - Indirect-reseller incentives need a Solutions Partner designation (or 25 capability points) plus US$25K TTM.
  - Source: [TechPartner.News, 2 May 2025](https://www.techpartner.news/news/microsoft-announces-sweeping-csp-changes-adding-us1m-csp-revenue-threshold-to-direct-bill-616900)
- **Indirect-reseller threshold conflict:** One guide states US$25K TTM for indirect resellers — [CloudCockpit](https://cloudcockpit.com/blog/microsoft-csp-new-program-requirements). This appears to conflate the incentive threshold with the authorisation threshold; TechPartner.News and Channel Insider give US$1,000 — [Channel Insider](https://www.channelinsider.com/news-and-trends/microsoft-partner-changes-may-2025/)
- **Reported pause in reassessment (unconfirmed):** A single third-party source says Microsoft paused reassessment of existing direct-bill and distributor partners on 21 April 2026 while redesigning the process. Microsoft's page, updated 18 May 2026, still describes annual reassessment — [CloudCockpit: CSP direct-bill automation](https://cloudcockpit.com/blog/csp-direct-bill-automation-requirement)
- **Revenue visibility problems:** A partner forum post reports a direct-bill termination at about US$892K TTM and poor revenue visibility where tenants mix direct and indirect. This is an anecdote — [Microsoft Tech Community](https://techcommunity.microsoft.com/discussions/cloudservicesproviderspartners/urgent-csp-direct-bill-termination-due-to-revenue-discrepancy--visibility-gap-su/4503894)
- **API access by role:**
  - "Sandbox and Partner Center API/SDK capabilities are available only to direct-bill partners. After the transition from direct-bill to indirect reseller, you lose access to the sandbox and Partner Center API capabilities."
  - Direct-bill tasks include ordering, billing customers, downloading CSP price lists, using the API for storefront integration and adding customer records.
  - Indirect resellers can request that their provider order, manage licences and users, raise service requests and view analytics.
  - Indirect resellers "can't create Microsoft Entra tenants for their new customers". The provider creates the tenant and names the reseller.
  - Admin management of customer tenants uses GDAP.
  - Page dated 14 Oct 2025, updated 29 May 2026.
  - Source: [MS Learn: Switch direct-bill partner to indirect reseller](https://learn.microsoft.com/en-us/partner-center/enroll/transition-direct-to-indirect)
- **Distributor ordering for resellers:** Distributors (indirect providers) place orders for a reseller's customers through the API and set `PartnerIdOnRecord` to the reseller's ID — [MS Learn: Create an order for a customer of an indirect reseller](https://learn.microsoft.com/en-ca/partner-center/developer/create-an-order-for-a-customer-of-an-indirect-reseller)
- **Partner of Record validation:**
  - Enforced for changes to existing subscriptions from 1 December 2025, in addition to new orders.
  - An invalid POR blocks the purchase.
  - A POR Validation API is available.
  - Source: [MS Learn: indirect provider tasks](https://learn.microsoft.com/en-us/partner-center/customers/indirect-provider-tasks-in-partner-center) (summarised via search; verify on the page)
- **Reconciliation:** Reconciliation files carry the "Reseller or Tier 2 MPNID", and new-commerce reconciliation files download asynchronously — [MS Learn: Read your bill](https://learn.microsoft.com/da-DK/partner-center/read-your-bill)
- **Price and term rules for FY27 (secondary sources):**
  - From 1 October 2026, annual-term CSP software subscriptions billed monthly carry a 5% uplift.
  - The products named include Windows Server, SQL Server, CALs and System Center; the change is not a blanket Microsoft 365 increase.
  - Annual-billed and month-to-month subscriptions are not affected.
  - From 1 December 2026, new Microsoft 365 Copilot Business licences through CSP include usage-based billing by default.
  - The indirect-reseller Microsoft 365/Dynamics 365 Growth Accelerator rises from 7.5% (FY26) to 12.5% (FY27).
  - Sources: [Pax8 blog](https://www.pax8.com/blog/?p=6908); [Work365: October 2026 CSP software price change](https://resources.work365apps.com/blog/october-2026-csp-software-price-change). Not verified against Microsoft's own announcement page.
- **Three-year terms:** Three-year CSP terms for M365 E3/E5 and Teams Enterprise launched 1 June 2025 — [TechPartner.News](https://www.techpartner.news/news/microsoft-announces-sweeping-csp-changes-adding-us1m-csp-revenue-threshold-to-direct-bill-616900)

### Inferences
- **Wroffy is very likely indirect.** Unless Wroffy Technologies bills more than US$1M (about ₹8.5 crore+) of Microsoft CSP a year and holds a Solutions Partner designation, it sits, or will end up, in the indirect-reseller tier under an Indian distributor. Wroffy's actual CSP volume was not researched.
- **No Partner Center API for indirect resellers.** As an indirect reseller, Wroffy has no access to the Partner Center API. A Deskzo feature that "provisions M365 licences and renews subscriptions automatically" therefore cannot call Microsoft directly for Wroffy or similar SMB resellers. It must integrate with the distributor's marketplace API, such as Ingram Xvantage or TD SYNNEX Ion, or with direct-bill partners' tenants.
- **What remains possible without ordering:**
  - Managing users and licence assignment inside customer tenants through GDAP and Microsoft Graph. This is an inference from the GDAP mention, not verified for API scope.
  - Reading the distributor's invoices and reconciliation exports to drive renewal reminders.
- **The 5% monthly-billing uplift** is a concrete pricing rule a renewal or quote tool must model, with its scope taken from Microsoft's own notice.

### Gaps
- Microsoft's own FY27 (from Oct 2026) CSP announcement pages for the 5% rule and any India-specific changes. No India-specific CSP policy change was found.
- Whether the April 2026 reassessment pause is real. It is single-sourced.
- Whether the indirect-reseller minimum changed for FY27.

## 4. Autodesk new transaction (agency) model

### Takeaway
Under Autodesk's "new transaction model", partners (Solution Providers) quote, but the order and payment are transacted directly between Autodesk and the customer. Partner pay becomes an Autodesk-paid incentive booked as operating expense, rather than a resale margin.

Autodesk said it would move its indirect business to the model in all major markets during FY25–FY26; it was tested first in Australia and launched in more markets in June 2024. By FY26 Q4 (Feb 2026), Autodesk said Solution Providers worldwide primarily serve new-transaction-model customers and that the tailwinds fade in FY27.

No Autodesk statement confirming India's go-live date or GST invoicing mechanics was found. Autodesk did revamp its direct India Store for SMBs in June 2026.

### Cited Findings
- **Model and rollout plan (Q3 FY24 commentary):** Partners quote, Autodesk transacts with the customer, and the indirect business moves to this model across major markets in FY25–FY26 — [Autodesk Q3 FY24 investor materials](https://investors.autodesk.com/static-files/bad7ff29-5489-4da9-86fd-7b29caba2341)
- **Australia first:** "We began testing the new transaction model across our product suite in Australia" — [Q3 FY24 earnings call transcript (Barchart)](https://www.barchart.com/story/news/22205616/autodesk-adsk-q3-2024-earnings-call-transcript)
- **10-K (filed 3 Mar 2026):** "Our sales incentives to Solution Providers are recorded as operating expenses under the new transaction model." Quoted via search excerpt; the document itself returned HTTP 403 — [Autodesk Form 10-K](https://investors.autodesk.com/static-files/b3be800e-0806-43a4-b40a-9a770dc85d54)
- **FY26 progress:**
  - In Q3 FY26 the model added $135M to billings.
  - Autodesk acknowledged "operational friction that partners faced".
  - The earliest partner renewals under the model, in EMEA, went "generally as expected".
  - Tailwinds are expected to fade in FY27.
  - Sources: [Autodesk Q3 FY26 earnings call (Motley Fool, 25 Nov 2025)](https://www.fool.com/earnings/call-transcripts/2025/11/25/autodesk-adsk-q3-2026-earnings-call-transcript/); [Q4 FY26 call (26 Feb 2026)](https://www.fool.com/earnings/call-transcripts/2026/02/26/autodesk-adsk-q4-2026-earnings-call-transcript/)
- **Partner-side view:**
  - Solution providers "remain engaged in all aspects of the pre- and post-sales journey, with the exception of the actual order and payment transaction".
  - Autodesk invoices customers with 30-day terms subject to approval.
  - A launch date of 10 June 2024 is cited for those partners' markets.
  - Sources: [Graitec: Autodesk new transaction model](https://graitec.com/us/resources/autodesk-new-transaction-model/); [NexGenSolutions](https://nexgensolutions.com/nexgensolutions-autodesks-new-customer-buying-process/)
- **India direct channel:** Autodesk revamped its India Store in June 2026 as a self-serve platform for startups and SMBs, including Flex tokens. The article itself was not readable (403); this is from the search snippet — [YourStory, June 2026](https://yourstory.com/enterprise-story/2026/06/autodesk-revamps-india-store-targets-startups-smbs-self-serve-digital-platform); see also [Autocar Pro: Autodesk converts Indian digital storefront into automated procurement platform](https://www.autocarpro.in/news/autodesk-converts-indian-digital-storefront-into-automated-procurement-platform-133055)
- **Indian reseller sites:** Indian resellers, including Wroffy, still market Autodesk subscriptions and renewals with "GST-compliant invoices". These are vendor marketing claims, not evidence of how India transacts — [Wroffy Autodesk page](https://www.wroffy.com/autodesk/); [autodeskreseller.com](https://www.autodeskreseller.com/)
- **India distribution:** Redington is listed as an Autodesk value-added distributor in India (undated) — [Geospatial World](https://geospatialworld.net/news/autodesk-expands-its-distribution-network-in-india)

### Inferences
- **Where India stands is unconfirmed.** If India is on the agency model, Wroffy's role becomes quote, influence and services, with commission-like incentives; renewals are invoiced and collected by Autodesk. A Deskzo "renewal invoicing" flow for Autodesk would then be wrong, and it should track quotes, incentives and renewal opportunities instead. If India is not yet on it, the classic buy-resell margin model still applies. Wroffy can confirm this from its own partner portal in minutes.
- **No partner API was found.** No public Autodesk partner API for quoting or renewals turned up. Partner tooling appears to sit in Autodesk's partner portal, which was not verified.

### Gaps
- India go-live status and date for the new transaction model, and GST and invoicing treatment.
- Partner incentive percentages.
- Whether an Autodesk partner quoting or renewals API exists.

## 5. India software distributors and marketplaces with APIs

### Takeaway
The major Indian software distributors run cloud marketplaces that provision and bill CSP and other SaaS for resellers: Ingram Micro (Xvantage), Redington (CloudQuarks) and TD SYNNEX (StreamOne Ion). Ingram and TD SYNNEX publish reseller APIs. No public CloudQuarks API documentation was found. Crayon/Rhipe was not researched.

### Cited Findings
- **Ingram Micro Xvantage API:**
  - Published OpenAPI spec and SDKs on GitHub.
  - Reseller endpoints for auth, product catalogue, orders, quotes, invoices, renewals, deals and returns, with sandbox and production hosts.
  - The endpoints are global, not India-specific.
  - Source: [GitHub: ingrammicro-xvantage/xi-sdk-openapispec](https://github.com/ingrammicro-xvantage/xi-sdk-openapispec)
- **Ingram in India:** Ingram expanded its AI-enabled Xvantage marketplace in India (Dec 2025) and in 2026 pushed partners to use Xvantage beyond fulfilment — [YourStory, Dec 2025](https://yourstory.com/2025/12/ingram-micro-xvantage-redefining-distribution-ai-driven-platform-model); [CRN Asia India, 2026](https://www.crnasia.com/india/news/2026/do-not-use-us-just-for-fulfilment-says-ingram-micro-as-it-pushes-xvantage-led-partner-growth)
- **TD SYNNEX StreamOne Ion API:**
  - Manages subscriptions, catalogue, end customers and orders.
  - Base URL ion.tdsynnex.com with OAuth 2.0, documented via a third-party mirror.
  - PSA integrations datasheet available.
  - Sources: [API Evangelist: TD SYNNEX](https://providers.apievangelist.com/providers/synnex/); [TD SYNNEX StreamOne PSA integrations datasheet](https://dach.tdsynnex.com/cloud/de/wp-content/uploads/sites/2/2023/09/td-synnex-streamone-psa-integrations-datasheet.pdf)
  - India availability of StreamOne Ion was not confirmed.
- **Redington CloudQuarks:**
  - Described by an analyst note as a marketplace supporting provisioning, billing, analytics and lifecycle for 40,000+ resellers and SMBs.
  - No public API documentation was found.
  - Sources: [Simply Wall St narrative](https://simplywall.st/community/narratives/in/tech/nse-redington/redington-shares/redington-set-to-ride-the-ongoing-ai-and-cloud-boom-by-transforming-to-saas-marketplace-and-vendor-business-model); [CRN Asia India: Redington Q1 2026](https://www.crnasia.com/india/news/2026/redington-q1-earnings-profit-growth-outpaces-revenue-as-cloud-and-enterprise-demand-accelerate)

### Inferences
- **Integrate with distributors, not vendors.** For Deskzo's software-reseller vertical, the realistic automation layer is a connector to the reseller's distributor (Ingram Xvantage first, since its API is public, then TD SYNNEX Ion). Direct Microsoft or Autodesk APIs are out of reach for this tier. A per-customer "which distributor do you use" setting is needed.
- **Wroffy can confirm the starting point.** Wroffy's own distributor relationships would tell Deskzo which connector to build first.

### Gaps
- Redington CloudQuarks API availability. Ask Redington.
- Crayon/Rhipe India status and APIs. Not researched.
- India-specific API access terms for Ingram and TD SYNNEX, such as whether resellers need approval for API keys.
