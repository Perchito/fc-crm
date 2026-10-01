// The compliance footer — always appended in code, never left to the LLM,
// so the unsubscribe line and sender identity can't go missing or be
// hallucinated. Same shape as fc-outreach's render.js FOOTER_TMPL.
export function withSignature(bodyCore) {
  const name = process.env.SENDER_NAME || 'Fernando C.';
  const title = process.env.SENDER_TITLE || 'Operations Director';
  const phone = process.env.SENDER_PHONE || '+44 7337 397269';
  const website = process.env.SENDER_WEBSITE || 'fccleaningcompany.com';
  return [
    String(bodyCore || '').trimEnd(),
    '',
    'Best,',
    name,
    `${title}, FC Cleaning Company Ltd`,
    `${phone} · ${website}`,
    '',
    'Sent to you as a local business owner. Reply "unsubscribe" and I won\'t contact you again.',
  ].join('\n');
}

// Safety net for AI-drafted bodies that were *asked* to include their own
// sign-off: trust it if the compliance line made it through, otherwise strip
// whatever partial sign-off the model produced and append ours. The
// unsubscribe line must never depend on the model getting it right.
export function ensureSignature(text) {
  const t = String(text || '').trimEnd();
  if (/reply\s+"?unsubscribe"?/i.test(t)) return t;
  const cut = t.search(/\n\s*Best,\s*\n/i);
  return withSignature(cut !== -1 ? t.slice(0, cut) : t);
}
