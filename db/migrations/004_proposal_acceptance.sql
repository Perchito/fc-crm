-- 004 — proposals are no longer signed (only service agreements are). New acceptance wording
-- for the library and for DRAFT proposals still using the original text. Sent versions are untouched.
update content_blocks set body = 'To accept this proposal, simply reply to the email it came with or call us on {{company_phone}}, quoting reference {{reference}}. We will then send you the service agreement to sign electronically.', updated_at = now()
 where doc_type = 'proposal' and key = 'acceptance'
   and body = 'By signing below, {{client}} accepts this proposal and authorises FC Cleaning Company Ltd to commence the services described above under the stated terms.

To accept, sign and return this proposal, or reply to the email it came with. A service agreement will follow for signature.';
update proposals p set data = jsonb_set(p.data, '{sections}', (
    select jsonb_agg(case when s->>'key' = 'acceptance' and s->>'body' = (select 'By signing below, {{client}} accepts this proposal and authorises FC Cleaning Company Ltd to commence the services described above under the stated terms.

To accept, sign and return this proposal, or reply to the email it came with. A service agreement will follow for signature.')
      then jsonb_set(s, '{body}', to_jsonb((select body from content_blocks where doc_type = 'proposal' and key = 'acceptance'))) else s end order by ord)
    from jsonb_array_elements(p.data->'sections') with ordinality t(s, ord))), updated_at = now()
 where p.status = 'draft' and jsonb_typeof(p.data->'sections') = 'array';
-- ROLLBACK: set the acceptance body back to the 002 text (drafts keep whichever text they now have).
