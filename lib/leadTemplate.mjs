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

If it's useful I can send a free written quote within 48 hours — would a quick look round work in the next week or two?`;
}

// Follow-up, sent automatically by the campaign engine 5 days after the first
// (reviewed) email — step 1 of every discovery campaign. Merge fields, not JS,
// because it's stored as a campaign_steps template. Signature added at step
// creation so the unsubscribe line is always there.
export const FOLLOW_UP = {
  wait_days: 5,
  subject_tmpl: 'Re: Commercial cleaning for {{business}}',
  body_tmpl: `Hi there,

Just following up on my email last week about commercial cleaning for {{business}}.

If it would help, I'm happy to pop in for a quick look round at a time that suits you, and I'll send over a free written quote within 48 hours. No obligation at all.

You can pick a time that suits you here: {{booking_link}}

If cleaning isn't something you're looking at right now, no problem, just let me know and I won't chase.`,
};
