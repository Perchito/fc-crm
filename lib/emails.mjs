// Branded HTML emails (table layout + inline styles so Gmail / Outlook / Apple Mail all render it).
// Same layout as the Staff Hub / FC Inspect emails (~/fc-staff/lib/emails.mjs) — keep them in step.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NAVY = '#05101f', MUTED = '#5b6b80', LINE = '#e2e8f0';

// Branded layout every email uses: logo, small "FC CLEANING COMPANY LTD", heading, body, optional button.
// body is HTML built with p() / facts(); rows are full-width table rows (rota days).
export function brandEmail({ url, title, eyebrow = true, body = '', rows = '', note = '', button = null, buttonUrl = url, footer = 'FC Cleaning Company Ltd · fccleaningcompany.com' }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6fa"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
    <tr><td align="center" style="padding:32px 28px 8px"><img src="${esc(`${url}/fc-logo.png`)}" width="96" alt="FC Cleaning Company Ltd" style="display:block;width:96px;height:auto"></td></tr>
    ${eyebrow ? `<tr><td align="center" style="padding:16px 28px 0;font-size:12px;font-weight:700;letter-spacing:2px;color:${MUTED}">FC CLEANING COMPANY LTD</td></tr>` : ''}
    <tr><td align="center" style="padding:${eyebrow ? 8 : 16}px 28px 4px;font-size:28px;line-height:1.2;font-weight:700;color:${NAVY}">${title}</td></tr>
    ${body ? `<tr><td style="padding:20px 28px 4px">${body}</td></tr>` : ''}
    ${rows ? `<tr><td style="border-top:1px solid ${LINE}"></td></tr>${rows}` : ''}
    ${note ? `<tr><td style="padding:18px 28px 0;font-size:14px;color:${MUTED}">${note}</td></tr>` : ''}
    ${button ? `<tr><td align="center" style="padding:24px 28px 32px">
      <a href="${esc(buttonUrl)}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px">${esc(button)}</a>
    </td></tr>` : '<tr><td style="padding:8px"></td></tr>'}
  </table>
  <p style="font-size:12px;color:#8a98aa;margin:16px 0 0">${footer}</p>
</td></tr></table></body></html>`;
}

// paragraph (html in); align 'center' for a lead line
export const p = (html, align = 'left') => `<p style="margin:0 0 16px;font-size:17px;line-height:1.55;color:#374151;text-align:${align}">${html}</p>`;
// grey box of LABEL / value pairs; values are escaped, pass { html } to keep markup (links)
export const facts = (pairs) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f9fc;border:1px solid ${LINE};border-radius:14px;margin:4px 0 20px"><tr><td style="padding:18px 22px 4px">
  ${pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:${MUTED};text-transform:uppercase">${esc(k)}</div>
  <div style="font-size:17px;font-weight:700;color:${NAVY};margin:2px 0 14px;word-break:break-word">${v?.html ?? esc(v)}</div>`).join('')}
</td></tr></table>`;
export const hi = (name) => p(`Hi <strong style="color:${NAVY}">${esc(name)}</strong>,`);

// red box for urgent items
export const alert = (html) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fef3f2;border:1px solid #fecdca;border-radius:14px;margin:4px 0 20px"><tr><td style="padding:16px 20px;font-size:15px;line-height:1.5;color:#7a271a">${html}</td></tr></table>`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  const w = brandEmail({ url: 'https://x', title: 'T', body: hi('A<b') + facts([['Site', 'R'], ['Skip', null]]) });
  assert.ok(w.includes('A&#60;b') && !w.includes('Skip') && w.includes('https://x/fc-logo.png'));
  console.log('emails ok');
}
