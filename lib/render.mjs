import { BOOK_URL } from './booking.mjs';

// {{field}} merge fields against a contact row.
export function render(tmpl, contact) {
  return String(tmpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (key === 'booking_link') return `${BOOK_URL}?c=${contact.booking_token}`;
    if (key === 'first_name') return (contact.contact_name || '').split(' ')[0] || contact.business || 'there';
    return contact[key] ?? '';
  });
}
