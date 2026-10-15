// Finds a business's published email on its own website without an LLM: the homepage plus up to 3
// contact/about pages, reading mailto: links, plain-text addresses and Cloudflare-obfuscated ones.
// Discovery used to make Claude do this page by page (~$1 a batch, most of it re-reading pages).

const JUNK = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|yourdomain|sentry|wixpress|godaddy|mysite)\.|^(no-?reply|wordpress|admin@wordpress)|@2x|\d+x\d+@/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PAGE = /contact|about|get-in-touch|find-us|enquir|visit|location/i;

const cfDecode = (hex) => {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
};

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

export function extractEmails(html) {
  const text = String(html)
    .replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, '@')
    .replace(/%40/g, '@');
  const found = [
    ...[...text.matchAll(/data-cfemail="([0-9a-f]+)"/gi)].map((m) => cfDecode(m[1])),
    ...[...text.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => decodeURIComponent(m[1])),
    ...(text.replace(/<[^>]+>/g, ' ').match(EMAIL) || []),
  ].map((e) => e.trim().toLowerCase().replace(/\.$/, ''));
  return [...new Set(found)].filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && !JUNK.test(e));
}

export function contactLinks(html, base) {
  const host = hostOf(base), out = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!PAGE.test(m[1]) && !PAGE.test(m[2].replace(/<[^>]+>/g, ''))) continue;
    try { const u = new URL(m[1], base); if (hostOf(u.href) === host && /^https?:$/.test(u.protocol)) out.add(u.href); } catch { /* bad href */ }
  }
  return [...out].slice(0, 3);
}

// the site's own domain first (info@thevenue.co.uk), then anything else it publishes (gmail etc.)
export const pickEmail = (emails, site) => {
  const host = hostOf(site);
  return emails.find((e) => host && (host.endsWith(e.split('@')[1]) || e.split('@')[1].endsWith(host))) || emails[0] || null;
};

async function get(url) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html', 'Accept-Language': 'en-GB' } });
  if (!r.ok || !/html/.test(r.headers.get('content-type') || '')) return '';
  return (await r.text()).slice(0, 1_500_000);
}

export async function findSiteEmail(website) {
  if (!website) return null;
  const home = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  try {
    const html = await get(home);
    const emails = extractEmails(html);
    for (const page of emails.length ? [] : contactLinks(html, home)) {
      emails.push(...extractEmails(await get(page).catch(() => '')));
      if (emails.length) break;
    }
    return pickEmail(emails, home);
  } catch { return null; }
}

// node lib/siteEmail.mjs — self-check
if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: assert } = await import('node:assert');
  const html = `<a href="mailto:Info@TheVenue.co.uk?subject=hi">Email</a> <img src="logo@2x.png"> bookings&#64;thevenue.co.uk
    <span class="__cf_email__" data-cfemail="${(() => { const k = 0x42; return k.toString(16).padStart(2, '0') + [...'hi@cf.com'].map((c) => (c.charCodeAt(0) ^ k).toString(16).padStart(2, '0')).join(''); })()}">[email protected]</span>
    <a href="/contact-us">Contact</a> <a href="https://other.com/contact">x</a> <a href="/menu">Menu</a> <a href="/about">About us</a>`;
  assert.deepEqual(extractEmails(html).sort(), ['bookings@thevenue.co.uk', 'hi@cf.com', 'info@thevenue.co.uk']);
  assert.deepEqual(contactLinks(html, 'https://www.thevenue.co.uk/'), ['https://www.thevenue.co.uk/contact-us', 'https://www.thevenue.co.uk/about']);
  assert.equal(pickEmail(['owner@gmail.com', 'info@thevenue.co.uk'], 'https://www.thevenue.co.uk'), 'info@thevenue.co.uk');
  assert.equal(pickEmail(['owner@gmail.com'], 'https://thevenue.co.uk'), 'owner@gmail.com');
  assert.deepEqual(extractEmails('<a href="mailto:noreply@x.com">'), []);
  console.log('siteEmail ok');
}
