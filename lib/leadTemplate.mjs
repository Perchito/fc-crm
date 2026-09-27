// Fixed cold-outreach template for AI-discovered leads (worker/discover.mjs).
// No AI drafting involved — just {{business}} substituted in. Replaced the
// earlier "AI writes a researched opener" approach on Luis's feedback: too
// long, the personalised opening paragraph wasn't wanted.
export function subjectFor(contact) {
  return `Commercial cleaning for ${contact.business}`;
}

export function bodyFor(contact) {
  return `Hi there,

I'm Fernando from FC Cleaning Company — owner-managed commercial cleaning for restaurants, pubs, bars and cafés across Greater Manchester and the North West.

I'm reaching out about commercial cleaning for ${contact.business}. We work around service with early-morning or post-close slots, we're fully insured, and every job is checked by me personally.

If it's useful I can send a free written quote within 24 hours — would a quick look round work in the next week or two?`;
}
