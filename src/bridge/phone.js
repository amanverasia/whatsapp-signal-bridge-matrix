import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalize(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/@s\.whatsapp\.net$/, '');
  let parsed = parsePhoneNumberFromString(cleaned);
  if (!parsed && /^\d/.test(cleaned)) {
    parsed = parsePhoneNumberFromString('+' + cleaned);
  }
  return parsed && parsed.isValid() ? parsed.number : null;
}

export function phonesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return na !== null && na === nb;
}
