import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugins/types.js";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import {
  fetchRemoteMedia,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import {
  findTwilioAccountByPhoneNumber,
  normalizePhoneNumber,
  type ResolvedTwilioAccount,
} from "./accounts.js";
import { parseTwilioWebhook, verifyTwilioSignature } from "./webhook.js";
import { sendTwilioWhatsappMessage } from "./send.js";
import type { StoredTwilioRuntime } from "./runtime-store.js";
import { getRuntimeForPhoneNumber } from "./runtime-store.js";

const MEDIA_MAX_BYTES = 16 * 1024 * 1024; // 16MB (Twilio's WhatsApp media limit)

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

type ResolvedMedia = {
  path: string;
  contentType: string;
};

// Twilio media URLs require Basic auth (accountSid:authToken)
async function downloadTwilioMedia(
  url: string,
  account: ResolvedTwilioAccount,
): Promise<ResolvedMedia | null> {
  try {
    const authHeader =
      "Basic " + Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64");

    const { buffer, contentType } = await fetchRemoteMedia({
      url,
      fetchImpl: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            Authorization: authHeader,
          },
        }),
      maxBytes: MEDIA_MAX_BYTES,
      readIdleTimeoutMs: 30_000,
    });

    const saved = await saveMediaBuffer(buffer, contentType, "inbound", MEDIA_MAX_BYTES);
    return {
      path: saved.path,
      contentType: saved.contentType ?? contentType ?? "application/octet-stream",
    };
  } catch (err) {
    console.error("[twilio-whatsapp] Failed to download media:", url, err);
    return null;
  }
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

      // Respond to Twilio immediately — media download happens async
      twimlOk(res);

      // Download all media attachments in parallel
      const resolvedMedia: ResolvedMedia[] = [];
      if (hasMedia) {
        const results = await Promise.all(
          fields.media.map((m) => downloadTwilioMedia(m.url, account)),
        );
        for (const r of results) {
          if (r) resolvedMedia.push(r);
        }
      }

      // Build media context fields (mirrors Telegram pattern)
      const mediaContext =
        resolvedMedia.length > 0
          ? {
              MediaPath: resolvedMedia[0].path,
              MediaUrl: resolvedMedia[0].path,
              MediaType: resolvedMedia[0].contentType,
              MediaPaths: resolvedMedia.map((m) => m.path),
              MediaUrls: resolvedMedia.map((m) => m.path),
              MediaTypes: resolvedMedia.map((m) => m.contentType),
            }
          : {};

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
        bodyForAgent: messageText || undefined,
        messageId: fields.messageSid,
        timestamp: Date.now(),
        commandAuthorized: true,
        extraContext: mediaContext,
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
