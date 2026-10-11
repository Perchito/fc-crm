-- 003 — contract clause titles/wording aligned with FC's LaTeX agreement (HDO-001).
-- Only touches clauses still exactly as 002 seeded them, so anything edited in the app is kept.
update content_blocks set body = 'This Agreement is made between:', updated_at = now()
 where doc_type = 'contract' and key = 'overview'
   and body = 'This Agreement is made between FC Cleaning Company Ltd ("the Contractor") and the Client named below, for the cleaning services described in this Agreement.';
update content_blocks set title = 'Term and Termination', updated_at = now()
 where doc_type = 'contract' and key = 'term_termination' and title = 'Contract Term and Termination';
update content_blocks set title = 'Acceptance', updated_at = now()
 where doc_type = 'contract' and key = 'acceptance' and title = 'Acceptance and Signatures';
-- ROLLBACK: reverse the three updates (titles 'Contract Term and Termination' / 'Acceptance and Signatures', overview sentence above).
