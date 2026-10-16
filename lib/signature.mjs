// The compliance footer — always appended in code, never left to the LLM,
// so the unsubscribe line and sender identity can't go missing or be
// hallucinated. Same shape as fc-outreach's render.js FOOTER_TMPL.
const DEFAULT_PHONE = '+44 7337 397269';

// Who an email is from. London = Daniel (does the London visits) once his mailbox exists: setting
// LONDON_FROM_ADDRESS in .env switches every London email over; until then Fernando signs everything.
export function senderFor(area) {
  const e = process.env;
  if (area === 'london' && e.LONDON_FROM_ADDRESS) {
    return { name: e.LONDON_SENDER_NAME || 'Daniel C.', title: e.LONDON_SENDER_TITLE || '', phone: e.LONDON_SENDER_PHONE || e.SENDER_PHONE || DEFAULT_PHONE, from: e.LONDON_FROM_ADDRESS };
  }
  return { name: e.SENDER_NAME || 'Fernando C.', title: e.SENDER_TITLE || 'Operations Director', phone: e.SENDER_PHONE || DEFAULT_PHONE, from: undefined };
}
export const firstName = (area) => senderFor(area).name.split(' ')[0];

export function withSignature(bodyCore, area) {
  const { name, title, phone } = senderFor(area);
  const website = process.env.SENDER_WEBSITE || 'fccleaningcompany.com';
  return [
    String(bodyCore || '').trimEnd(),
    '',
    'Best,',
    name,
    `${title ? `${title}, ` : ''}FC Cleaning Company Ltd`,
    `${phone} · ${website}`,
    '',
    'Sent to you as a local business owner. Reply "unsubscribe" and I won\'t contact you again.',
  ].join('\n');
}

// Safety net for AI-drafted bodies that were *asked* to include their own
// sign-off: trust it if the compliance line made it through, otherwise strip
// whatever partial sign-off the model produced and append ours. The
// unsubscribe line must never depend on the model getting it right.
export function ensureSignature(text, area) {
  const t = String(text || '').trimEnd();
  if (/reply\s+"?unsubscribe"?/i.test(t)) return t;
  const cut = t.search(/\n\s*Best,\s*\n/i);
  return withSignature(cut !== -1 ? t.slice(0, cut) : t, area);
}

// node lib/signature.mjs — London only switches to Daniel once his address is set
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  delete process.env.LONDON_FROM_ADDRESS;
  assert.equal(senderFor('london').name, 'Fernando C.');
  assert.equal(senderFor('london').from, undefined);
  process.env.LONDON_FROM_ADDRESS = 'daniel@fccleaningcompany.com';
  assert.equal(senderFor('london').from, 'daniel@fccleaningcompany.com');
  assert.equal(firstName('london'), 'Daniel');
  assert.equal(senderFor('manchester').name, 'Fernando C.');
  assert.ok(withSignature('Hi', 'london').includes('Daniel C.\nFC Cleaning Company Ltd'));
  assert.ok(/unsubscribe/.test(ensureSignature('Hi\n\nBest,\nFernando', 'london')));
  console.log('signature ok');
}
