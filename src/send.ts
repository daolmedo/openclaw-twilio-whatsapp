import twilio from "twilio";

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
  const msg = await client.messages.create({
    from,
    to,
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.mediaUrl ? { mediaUrl: [opts.mediaUrl] } : {}),
  });
  return msg.sid;
}
