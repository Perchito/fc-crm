-- 002 — starting content taken from FC's own LaTeX proposal (FCC-HDO-001) and service
-- agreement (HDO-001). Everything here is editable in Settings → Library / Company.
-- Body markup: "## " sub-heading, "### " group heading, "- " bullet, blank line = paragraph.
-- {{merge}} fields are filled per document; [[...]] marks wording someone must complete —
-- a proposal/contract can't be issued while any [[...]] is left in it.

insert into meta (k, v) values ('company', jsonb_build_object(
  'name', 'FC Cleaning Company Ltd',
  'address', '57 St. Davids Crescent, Aspull, Wigan WN2 1SZ',
  'phone', '0161 399 0482',
  'email', 'fernando.c@fccleaningcompany.com',
  'website', 'fccleaningcompany.com',
  'vat_number', '517 4596 68',
  'company_number', '17091521',
  'signatory_name', 'Fernando Caceres',
  'signatory_title', 'Operations Director',
  'signatory_email', 'fernando.c@fccleaningcompany.com',
  'vat_rate_bp', 2000,
  'proposal_valid_days', 30
)) on conflict (k) do nothing;

insert into service_templates (name, billing, frequency, visits_per_week, hours_per_visit, staff, price_pence, scope, sort) values
('One-off deep clean', 'fixed', 'one_off', null, null, 3, 69500,
'- High-level AC dust removal (accessible surfaces, subject to safe access)
- Skirting boards, door frames, corners and ledges
- Industrial oven cleaning (cool, safely isolated; interior focus)
- Floors, touchpoints and final inspection
- Setup, protection and close-down', 10),
('Daily cleaning service', 'fixed', 'monthly', 7, 5, null, 375000,
'### Front customer area and counter
- Wipe tables, chairs, counters and touchpoints.
- Clean front counter surfaces and splashbacks.
- Vacuum and mop floors.

### Kitchen and prep areas
- Clean accessible food-prep surfaces, tables and equipment exteriors.
- Clean sinks, taps and splashbacks.
- Empty and replace internal bin bags.
- Sweep, vacuum and mop floors.

### Entrance, corridors and staff areas
- Clean entrance doors, mats, thresholds and frames.
- Clean corridors, stairs and handrails.
- Vacuum and mop floors; empty bins.

### End-of-visit checks
- Complete daily checklist.
- Store chemicals and equipment safely.
- Report damage, maintenance issues or restricted access.', 20),
('Weekly deep-clean and hygiene-support service', 'fixed', 'monthly', 1, 9, null, 120500,
'- One visit per week, on a fixed day, unless otherwise agreed.
- Production, prep and storage floors; flour and crumb build-up; touchpoints; front-of-house areas.
- Exterior surfaces of ovens cleaned each visit.
- Internal clean of one oven per week (rotating), when cool, empty, safely isolated and available.', 30),
('Hourly cleaning', 'hourly', 'weekly', 5, 2, 1, null, '', 40);

insert into content_blocks (doc_type, key, title, sort, required, body) values
('proposal', 'executive_summary', 'Executive Summary', 10, true,
'FC Cleaning Company Ltd is pleased to submit this proposal for commercial cleaning services at {{client}}, {{site_address}}. [[Describe the premises and what the site walkaround covered.]]'),
('proposal', 'management_qa', 'Management & Quality Assurance', 40, false,
'- The FC Cleaning Company Ltd {{signatory_title}} will be present with the team during the deep clean and the first two days of routine service.
- Weekly quality-assurance follow-ups will be carried out throughout the first five weeks of the contract.
- Follow-ups include checklist review, area inspection, discussion with site contact and team, and corrective actions where required.
- These management activities are included in the price.

After the first five weeks, routine quality checks will continue according to the agreed contract-management schedule.'),
('proposal', 'exclusions_assumptions', 'Exclusions & Assumptions', 50, false,
'## Exclusions
- High-level cleaning above safe working limits without agreed access equipment.
- Extraction canopy, filter and ductwork cleaning.
- Carpet extraction and specialist floor treatments.
- Heavy grease, carbon or oven interior cleaning beyond the agreed scope.
- External window cleaning and facade cleaning.
- Pest control, waste removal and skip hire.
- Repairs, maintenance or building works.

## Assumptions
- Client provides cleaning consumables (soap, toilet rolls, paper towels, bin bags) unless otherwise agreed.
- Equipment to be cleaned (for example ovens) is cool, safely isolated and accessible before cleaning.
- Safe access arrangements are provided for high-level work where required.
- Cleaning is carried out after [[time, e.g. 4:00 pm]] unless otherwise agreed.'),
('proposal', 'health_safety', 'Health, Safety & Compliance', 60, false,
'- Comply with applicable UK health-and-safety legislation and guidance.
- Use appropriate PPE and safe working methods.
- Maintain COSHH documentation and safety data sheets for cleaning products.
- Ensure staff are trained and supervised in safe working practices.
- Report accidents, near-misses and hazards promptly.

The client is requested to:
- Provide safe access to all areas to be cleaned.
- Ensure equipment and surfaces are safe to clean.
- Report hazards, spills or maintenance issues promptly.'),
('proposal', 'commercial_terms', 'Commercial Terms', 70, true,
'## Introductory Period
- The recurring price applies for an initial {{minimum_term}} period.
- After this period, the service and pricing will be reviewed based on actual labour time, site requirements and any additional duties.
- The ongoing rate will be confirmed by mutual agreement.

## Payment Terms
- One-off deep clean: 50% deposit before scheduling; 50% within 14 days of completion and invoice.
- Recurring cleaning: invoiced monthly in advance; payment due within 14 days of invoice date.
- Any undisputed overdue amount may attract statutory interest and reasonable recovery costs under applicable UK commercial late-payment legislation.'),
('proposal', 'acceptance', 'Acceptance', 90, true,
'By signing below, {{client}} accepts this proposal and authorises FC Cleaning Company Ltd to commence the services described above under the stated terms.

To accept, sign and return this proposal, or reply to the email it came with. A service agreement will follow for signature.'),

('contract', 'overview', 'Service Agreement Overview', 10, true,
'This Agreement is made between FC Cleaning Company Ltd ("the Contractor") and the Client named below, for the cleaning services described in this Agreement.'),
('contract', 'commercial_terms', 'Commercial Terms and Payment', 30, true,
'## Payment Terms
- One-off deep clean: 50% deposit payable before scheduling; balance due within 14 days of completion and invoice.
- Recurring service: invoiced monthly in advance, payable within 14 days of invoice date.
- Additional work: requires written approval and will be quoted separately.

## Introductory Period and Review
- Introductory period: {{minimum_term}}
- Service review: after 7–14 days
- Formal price and scope review: at the end of the introductory period'),
('contract', 'access_safety', 'Access, Safety and Supplies', 40, true,
'- Client to provide safe access, the agreed cleaning window, water, power, reasonable storage, and any site induction.
- Kitchen areas must be released according to the client''s food-safety procedure.
- Work above 5 metres requires a suitable access method, risk assessment, and method statement.
- Toilet tissue, hand soap, paper towels and other consumables are excluded unless expressly included in this Agreement.'),
('contract', 'quality_assurance', 'Quality Assurance', 50, true,
'- The Contractor''s {{signatory_title}} will be present during the deep clean and first two days of routine service.
- Weekly quality-assurance follow-ups for the first 5 weeks, including checklist review, site inspection, communication with site contact and corrective actions within agreed scope.'),
('contract', 'term_termination', 'Contract Term and Termination', 60, true,
'- This Agreement commences on the Effective Date and continues for the introductory period of {{minimum_term}}, thereafter subject to review and mutual agreement.
- Either party may terminate with {{notice_period}} written notice after the introductory period.'),
('contract', 'liability_insurance', 'Liability and Insurance', 70, true,
'- The Contractor has public liability insurance and will take reasonable care to avoid damage.
- The Contractor is not liable for pre-existing damage, wear and tear, or issues arising from client-provided equipment or unsafe conditions.'),
('contract', 'governing_law', 'Governing Law', 80, true,
'- This Agreement is governed by the laws of England and Wales.'),
('contract', 'acceptance', 'Acceptance and Signatures', 90, true,
'By signing below, the Client confirms acceptance of the scope, pricing, assumptions, exclusions, and introductory-period review described in this Agreement.');

insert into meta (k, v) values ('automation', '{
  "new_lead_task":        {"enabled": true,  "days": 1},
  "visit_reminder_task":  {"enabled": true,  "days": 1},
  "proposal_follow_up":   {"enabled": true,  "days": 3},
  "accepted_contract":    {"enabled": true,  "days": 0},
  "signing_follow_up":    {"enabled": true,  "days": 3},
  "activate_on_signature":{"enabled": false},
  "onboarding":           {"enabled": true},
  "quality_follow_ups":   {"enabled": true,  "weeks": 5},
  "renewal_task":         {"enabled": true,  "days": 60},
  "expired_proposal_flag":{"enabled": true}
}') on conflict (k) do nothing;

-- ROLLBACK: delete from content_blocks; delete from service_templates;
--   delete from meta where k in ('company', 'automation'); delete from schema_migrations where name = '002_seed_content.sql';
