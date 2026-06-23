export function formatMessage(senderName, senderPhone, text) {
  const name = senderName && senderName.trim();
  const phone = senderPhone && senderPhone.trim();
  const hasName = name && !/^\p{Extended_Pictographic}+$/u.test(name);

  if (hasName && phone) return `${name} (${phone}): ${text}`;
  if (phone) return `${phone}: ${text}`;
  if (hasName) return `${name}: ${text}`;
  return `Unknown: ${text}`;
}
