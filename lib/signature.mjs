// The compliance footer — always appended in code, never left to the LLM,
// so the unsubscribe line and sender identity can't go missing or be
// hallucinated. Same shape as fc-outreach's render.js FOOTER_TMPL.
export function withSignature(bodyCore) {
  const name = process.env.SENDER_NAME || 'Fernando C.';
  const title = process.env.SENDER_TITLE || 'Operations Director';
  const phone = process.env.SENDER_PHONE || '0161 399 0482';
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
