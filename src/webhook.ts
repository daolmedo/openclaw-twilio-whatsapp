import twilio from "twilio";

export type ParsedTwilioWebhook = {
  from: string;
  to: string;
  body: string;
  waId: string;
  profileName: string;
  messageSid: string;
  media: Array<{ url: string; contentType: string }>;
  repliedToSid?: string;
};

export function verifyTwilioSignature(params: {
  authToken: string;
  signature: string;
  url: string;
  rawBody: string;
}): boolean {
  try {
    const parsed = Object.fromEntries(new URLSearchParams(params.rawBody));
    return twilio.validateRequest(params.authToken, params.signature, params.url, parsed);
  } catch {
    return false;
  }
}

export function parseTwilioWebhook(rawBody: string): ParsedTwilioWebhook {
  const p = Object.fromEntries(new URLSearchParams(rawBody));
  const numMedia = parseInt(p["NumMedia"] ?? "0", 10);
  const media = Array.from({ length: numMedia }, (_, i) => ({
    url: p[`MediaUrl${i}`] ?? "",
    contentType: p[`MediaContentType${i}`] ?? "application/octet-stream",
  }));
  return {
    from: (p["From"] ?? "").replace("whatsapp:", ""),
    to: (p["To"] ?? "").replace("whatsapp:", ""),
    body: p["Body"] ?? "",
    waId: p["WaId"] ?? "",
    profileName: p["ProfileName"] ?? "",
    messageSid: p["MessageSid"] ?? "",
    media,
    repliedToSid: p["OriginalRepliedMessageSid"],
  };
}
