// {{field}} merge fields against a contact row.
export function render(tmpl, contact) {
  return String(tmpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (key === 'first_name') return (contact.contact_name || '').split(' ')[0] || contact.business || 'there';
    return contact[key] ?? '';
  });
}
