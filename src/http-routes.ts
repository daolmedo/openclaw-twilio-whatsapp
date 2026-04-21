import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugins/types.js";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm.js";
import {
  findTwilioAccountByPhoneNumber,
  normalizePhoneNumber,
} from "./accounts.js";
import { parseTwilioWebhook, verifyTwilioSignature } from "./webhook.js";
import { sendTwilioWhatsappMessage } from "./send.js";
import type { StoredTwilioRuntime } from "./runtime-store.js";
import { getRuntimeForPhoneNumber } from "./runtime-store.js";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function twimlOk(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
}

function twimlError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`,
  );
}

export function registerTwilioWhatsappHttpRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/twilio/whatsapp/events",
    auth: "plugin",
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const rawBody = await readBody(req);

      const headers = req.headers as Record<string, string | string[] | undefined>;
      const signature = String(headers["x-twilio-signature"] ?? "");
      const webhookUrl = String(headers["x-twilio-webhook-url"] ?? "");

      const fields = parseTwilioWebhook(rawBody);
      const toPhone = normalizePhoneNumber(fields.to);

      const stored: StoredTwilioRuntime | undefined = getRuntimeForPhoneNumber(toPhone);
      if (!stored) {
        console.error(`[twilio-whatsapp] No runtime found for To=${fields.to}`);
        twimlError(res, 404, "No agent bound to this number");
        return true;
      }

      const account = findTwilioAccountByPhoneNumber(stored.cfg, toPhone);
      if (!account) {
        console.error(`[twilio-whatsapp] Account not found for phone=${toPhone}`);
        twimlError(res, 404, "Account not found");
        return true;
      }

      if (webhookUrl && signature) {
        const valid = verifyTwilioSignature({
          authToken: account.authToken,
          signature,
          url: webhookUrl,
          rawBody,
        });
        if (!valid) {
          console.error("[twilio-whatsapp] Invalid Twilio signature");
          twimlError(res, 403, "Forbidden");
          return true;
        }
      } else {
        console.warn("[twilio-whatsapp] Skipping sig verification — headers missing");
      }

      const fromPhone = normalizePhoneNumber(fields.from);
      const senderAddress = `whatsapp:${fromPhone}`;
      const recipientAddress = `whatsapp:${toPhone}`;
      const conversationLabel = fields.profileName || fromPhone;

      const messageText = fields.body.trim();
      const hasMedia = fields.media.length > 0;

      if (!messageText && !hasMedia) {
        twimlOk(res);
        return true;
      }

      const bodyForAgent = hasMedia
        ? [messageText, ...fields.media.map((m) => `[Media: ${m.url}]`)].filter(Boolean).join("\n")
        : messageText;

      twimlOk(res);

      dispatchInboundDirectDmWithRuntime({
        cfg: stored.cfg,
        runtime: { channel: stored.channelRuntime },
        channel: "twilio-whatsapp",
        channelLabel: "WhatsApp",
        accountId: account.accountId,
        peer: { kind: "direct", id: fromPhone },
        senderId: fromPhone,
        senderAddress,
        recipientAddress,
        conversationLabel,
        rawBody: messageText,
        bodyForAgent,
        messageId: fields.messageSid,
        timestamp: Date.now(),
        commandAuthorized: true,
        deliver: async (payload) => {
          const text = payload.text ?? "";
          const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
          if (!text && !mediaUrl) return;
          await sendTwilioWhatsappMessage({
            accountSid: account.accountSid,
            authToken: account.authToken,
            from: toPhone,
            to: fromPhone,
            body: text || undefined,
            mediaUrl,
          });
        },
        onRecordError: (err) => {
          console.error("[twilio-whatsapp] Session record error:", err);
        },
        onDispatchError: (err, info) => {
          console.error(`[twilio-whatsapp] Dispatch error (${info.kind}):`, err);
        },
      }).catch((err) => {
        console.error("[twilio-whatsapp] Unhandled dispatch error:", err);
      });

      return true;
    },
  });
}
