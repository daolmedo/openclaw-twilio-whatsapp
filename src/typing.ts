export async function sendWhatsappTypingIndicator(opts: {
  accountSid: string;
  authToken: string;
  messageId: string;
}): Promise<void> {
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64");
  const body = new URLSearchParams({ messageId: opts.messageId, channel: "whatsapp" });
  const response = await fetch("https://messaging.twilio.com/v2/Indicators/Typing.json", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Typing indicator failed: HTTP ${response.status}`);
  }
}

export function startTypingKeepalive(opts: {
  accountSid: string;
  authToken: string;
  messageId: string;
  intervalMs?: number;
}): () => void {
  const { intervalMs = 20_000 } = opts;
  let stopped = false;

  void sendWhatsappTypingIndicator(opts).catch(() => {});

  const timer = setInterval(() => {
    if (stopped) return;
    void sendWhatsappTypingIndicator(opts).catch(() => {});
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
