import twilio from "twilio";

const MAX_BODY_LENGTH = 1550;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_BODY_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_BODY_LENGTH) {
    let splitAt = remaining.lastIndexOf(" ", MAX_BODY_LENGTH);
    if (splitAt <= 0) splitAt = MAX_BODY_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendTwilioWhatsappMessage(opts: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body?: string;
  mediaUrl?: string;
}): Promise<string> {
  const client = twilio(opts.accountSid, opts.authToken);
  const from = opts.from.startsWith("whatsapp:") ? opts.from : `whatsapp:${opts.from}`;
  const to = opts.to.startsWith("whatsapp:") ? opts.to : `whatsapp:${opts.to}`;

  const chunks = opts.body ? splitMessage(opts.body) : [undefined];
  let lastSid = "";

  for (const chunk of chunks) {
    const msg = await client.messages.create({
      from,
      to,
      ...(chunk ? { body: chunk } : {}),
      ...(opts.mediaUrl ? { mediaUrl: [opts.mediaUrl] } : {}),
    });
    lastSid = msg.sid;
  }

  return lastSid;
}
