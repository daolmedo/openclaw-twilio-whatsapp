import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  createFixedWindowRateLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { resolveTwilioInboundAccess } from "./access.js";
import {
  findTwilioAccountByPhoneNumber,
  getTwilioChannelConfig,
  normalizePhoneNumber,
  type ResolvedTwilioAccount,
} from "./accounts.js";
import {
  parseTwilioWebhook,
  verifyTwilioSignature,
  type ParsedTwilioWebhook,
} from "./webhook.js";
import { sendTwilioWhatsappMessage } from "./send.js";
import { startTypingKeepalive } from "./typing.js";
import type { StoredTwilioRuntime } from "./runtime-store.js";
import { getRuntimeForPhoneNumber } from "./runtime-store.js";
import { createReplayCache } from "./replay-cache.js";

const MEDIA_MAX_BYTES = 16 * 1024 * 1024; // 16MB (Twilio's WhatsApp media limit)
const WEBHOOK_MAX_BODY_BYTES = 128 * 1024;
const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
});
const replayCache = createReplayCache({ ttlMs: 10 * 60_000, maxEntries: 10_000 });

type DispatchInbound = typeof dispatchInboundDirectDmWithRuntime;

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

function firstHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

type ResolvedMedia = {
  path: string;
  contentType: string;
};

type TwilioDispatchParams = {
  fields: ParsedTwilioWebhook;
  stored: StoredTwilioRuntime;
  account: ResolvedTwilioAccount;
  toPhone: string;
  fromPhone: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  messageText: string;
  resolvedMedia: ResolvedMedia[];
  commandAuthorized: boolean;
  messageSids?: string[];
};

type PendingMediaItem = TwilioDispatchParams & {
  receivedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingMediaBatch = {
  items: PendingMediaItem[];
  firstReceivedAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const pendingMediaByConversation = new Map<string, PendingMediaBatch>();
const dispatchQueueByConversation = new Map<string, Promise<void>>();

function resolveMediaBatchFlushMs(): number {
  const raw = Number(process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, 60_000);
  return 3_000;
}

function resolveMediaBatchInitialWaitMs(): number {
  const rawValue = process.env.TWILIO_WHATSAPP_MEDIA_BATCH_INITIAL_WAIT_MS;
  const raw = Number(rawValue);
  if (rawValue !== undefined && Number.isFinite(raw) && raw >= 0) {
    return Math.min(raw, 60_000);
  }

  // Preserve the old behavior for operators who explicitly configured the
  // original flush setting. New/default installs wait longer for a possible
  // sibling webhook because Twilio sends a WhatsApp media group as separate
  // inbound messages and does not expose a documented group identifier.
  if (process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS !== undefined) {
    return resolveMediaBatchFlushMs();
  }
  return 15_000;
}

function resolveMediaBatchMaxWaitMs(): number {
  const raw = Number(process.env.TWILIO_WHATSAPP_MEDIA_BATCH_MAX_WAIT_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, 60_000);
  return Math.min(resolveMediaBatchInitialWaitMs() + resolveMediaBatchFlushMs(), 60_000);
}

function resolveMediaBatchMaxItems(): number {
  const raw = Number(process.env.TWILIO_WHATSAPP_MEDIA_BATCH_MAX_ITEMS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(Math.min(raw, 50));
  return 10;
}

function summarizeText(text?: string): string {
  if (!text) return "chars=0";
  return `chars=${text.length} preview=${JSON.stringify(text.slice(0, 120))}`;
}

function resolvePendingMediaKey(accountId: string, fromPhone: string): string {
  return `${accountId}:${fromPhone}`;
}

function uniqueMessageSids(sids: Array<string | undefined>): string[] {
  return [...new Set(sids.map((sid) => sid?.trim()).filter((sid): sid is string => Boolean(sid)))];
}

function combineBatchMessageText(items: PendingMediaItem[]): string {
  return items
    .map((item) => item.messageText.trim())
    .filter(Boolean)
    .join("\n\n");
}

// Twilio media URLs require Basic auth (accountSid:authToken)
async function downloadTwilioMedia(
  url: string,
  account: ResolvedTwilioAccount,
): Promise<ResolvedMedia | null> {
  try {
    const authHeader =
      "Basic " + Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64");

    const response = await fetch(url, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching media`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength > MEDIA_MAX_BYTES) {
      throw new Error(`Media too large: ${arrayBuffer.byteLength} bytes`);
    }

    const buffer = Buffer.from(arrayBuffer);
    const saved = await saveMediaBuffer(buffer, contentType, "inbound", MEDIA_MAX_BYTES);
    return {
      path: saved.path,
      contentType: saved.contentType ?? contentType,
    };
  } catch (err) {
    console.error("[twilio-whatsapp] Failed to download media:", url, err);
    return null;
  }
}

function enqueueConversationDispatch(key: string, task: () => Promise<void>): Promise<void> {
  const previous = dispatchQueueByConversation.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .catch((err) => {
      console.error(`[twilio-whatsapp] Conversation dispatch failed key=${key}:`, err);
    });

  dispatchQueueByConversation.set(key, next);
  void next.then(() => {
    if (dispatchQueueByConversation.get(key) === next) {
      dispatchQueueByConversation.delete(key);
    }
  });
  return next;
}

function stopBatchTimer(batch: PendingMediaBatch): void {
  if (!batch.timer) return;
  clearTimeout(batch.timer);
  batch.timer = undefined;
}

function armBatchTimer(
  api: OpenClawPluginApi,
  dispatchInbound: DispatchInbound,
  key: string,
  batch: PendingMediaBatch,
): void {
  stopBatchTimer(batch);
  const batchAgeMs = Math.max(0, Date.now() - batch.firstReceivedAt);
  const desiredWaitMs =
    batch.items.length === 1
      ? resolveMediaBatchInitialWaitMs()
      : resolveMediaBatchFlushMs();
  const remainingMaxWaitMs = Math.max(0, resolveMediaBatchMaxWaitMs() - batchAgeMs);
  const waitMs = Math.min(desiredWaitMs, remainingMaxWaitMs);
  batch.timer = setTimeout(() => {
    void flushPendingMediaBatch(api, dispatchInbound, key, "timer");
  }, waitMs);
  batch.timer.unref?.();
}

async function flushPendingMediaBatch(
  api: OpenClawPluginApi,
  dispatchInbound: DispatchInbound,
  key: string,
  reason: string,
): Promise<void> {
  const batch = pendingMediaByConversation.get(key);
  if (!batch) return;

  stopBatchTimer(batch);
  pendingMediaByConversation.delete(key);
  const items = [...batch.items].sort((a, b) => a.receivedAt - b.receivedAt);
  const last = items.at(-1);
  if (!last) return;

  const resolvedMedia = items.flatMap((item) => item.resolvedMedia);
  const messageText = combineBatchMessageText(items);
  if (!resolvedMedia.length && !messageText) {
    for (const item of items) item.resolve();
    return;
  }

  const messageSids = uniqueMessageSids(items.map((item) => item.fields.messageSid));
  console.log(
    `[twilio-whatsapp] Flushing media batch key=${key} reason=${reason} messages=${items.length} media=${resolvedMedia.length} sids=${messageSids.join(",") || "unknown"}`,
  );

  try {
    await enqueueConversationDispatch(key, () =>
      dispatchTwilioInbound(api, dispatchInbound, {
        ...last,
        messageText,
        resolvedMedia,
        messageSids,
      }),
    );
    for (const item of items) item.resolve();
  } catch (err) {
    for (const item of items) item.reject(err);
  }
}

function queueMediaBatch(
  api: OpenClawPluginApi,
  dispatchInbound: DispatchInbound,
  key: string,
  item: TwilioDispatchParams & { receivedAt: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let batch = pendingMediaByConversation.get(key);
    if (!batch) {
      batch = { items: [], firstReceivedAt: item.receivedAt };
      pendingMediaByConversation.set(key, batch);
    }
    batch.items.push({ ...item, resolve, reject });
    console.log(
      `[twilio-whatsapp] Buffered media inbound sid=${item.fields.messageSid || "unknown"} key=${key} pendingMessages=${batch.items.length} pendingMedia=${batch.items.reduce(
        (count, pending) => count + pending.resolvedMedia.length,
        0,
      )}`,
    );

    if (batch.items.length >= resolveMediaBatchMaxItems()) {
      void flushPendingMediaBatch(api, dispatchInbound, key, "max-items");
      return;
    }
    if (resolveMediaBatchFlushMs() === 0) {
      void flushPendingMediaBatch(api, dispatchInbound, key, "disabled");
      return;
    }
    armBatchTimer(api, dispatchInbound, key, batch);
  });
}

async function dispatchTwilioInbound(
  api: OpenClawPluginApi,
  dispatchInbound: DispatchInbound,
  params: TwilioDispatchParams,
): Promise<void> {
  const {
    fields,
    stored,
    account,
    toPhone,
    fromPhone,
    senderAddress,
    recipientAddress,
    conversationLabel,
    resolvedMedia,
  } = params;
  let messageText = params.messageText;

  const mediaContext: Record<string, unknown> =
    resolvedMedia.length > 0
      ? {
          MediaPath: resolvedMedia[0].path,
          MediaUrl: resolvedMedia[0].path,
          MediaType: resolvedMedia[0].contentType,
          MediaPaths: resolvedMedia.map((media) => media.path),
          MediaUrls: resolvedMedia.map((media) => media.path),
          MediaTypes: resolvedMedia.map((media) => media.contentType),
        }
      : {};

  let bodyForAgent: string | undefined = messageText || undefined;
  const firstAudio = resolvedMedia.find((media) => media.contentType.startsWith("audio/"));
  if (firstAudio) {
    try {
      const cfgAny = stored.cfg as unknown as {
        bindings?: Array<{
          agentId?: string;
          match?: { channel?: string; accountId?: string };
        }>;
      };
      const agentId = cfgAny.bindings?.find(
        (binding) =>
          binding.match?.channel === "twilio-whatsapp" &&
          binding.match?.accountId === stored.accountId,
      )?.agentId;
      if (!agentId) {
        throw new Error(`No agent binding found for WhatsApp account ${stored.accountId}`);
      }
      const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(stored.cfg, agentId);
      const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
        provider: "openai",
        cfg: stored.cfg,
        workspaceDir,
      });
      if (!auth.apiKey) throw new Error("No OpenAI API key available for audio transcription");

      const audioBuffer = await readFile(firstAudio.path);
      const form = new FormData();
      form.append(
        "file",
        new Blob([audioBuffer], { type: firstAudio.contentType }),
        path.basename(firstAudio.path),
      );
      form.append("model", "gpt-4o-mini-transcribe");
      form.append("response_format", "json");
      const transcribeRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!transcribeRes.ok) {
        const errBody = await transcribeRes.text();
        throw new Error(`OpenAI transcription HTTP ${transcribeRes.status}: ${errBody}`);
      }
      const { text } = (await transcribeRes.json()) as { text?: string };
      console.log("[twilio-whatsapp] Transcription result:", text);
      if (text) {
        bodyForAgent = messageText
          ? `${messageText}\n\n[Audio]\nTranscript:\n${text}`
          : `[Audio]\nTranscript:\n${text}`;
        messageText = messageText ? `${messageText}\n\n${text}` : text;
        mediaContext.Transcript = text;
      } else {
        bodyForAgent = messageText || "<media:audio>";
      }
    } catch (err) {
      console.error("[twilio-whatsapp] Audio transcription failed:", err);
      bodyForAgent = messageText || "<media:audio>";
    }
  }

  console.log(
    `[twilio-whatsapp] Dispatching inbound sid=${fields.messageSid || "unknown"} bodyForAgent=${summarizeText(bodyForAgent)} media=${resolvedMedia.length}`,
  );

  const typingMessageSids = uniqueMessageSids(params.messageSids ?? [fields.messageSid]);
  const stopTypingKeepalives = typingMessageSids.map((messageSid) => {
    console.log(`[twilio-whatsapp] Typing keepalive start sid=${messageSid}`);
    return {
      messageSid,
      stop: startTypingKeepalive({
        accountSid: account.accountSid,
        authToken: account.authToken,
        messageId: messageSid,
      }),
    };
  });
  let typingStopped = false;
  const stopTyping = (): void => {
    if (typingStopped) return;
    typingStopped = true;
    for (const keepalive of stopTypingKeepalives) {
      keepalive.stop();
      console.log(`[twilio-whatsapp] Typing keepalive stop sid=${keepalive.messageSid}`);
    }
  };

  try {
    await dispatchInbound({
      cfg: stored.cfg,
      runtime: api.runtime,
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
      commandAuthorized: params.commandAuthorized,
      inboundAccessAuthorized: true,
      provider: "twilio-whatsapp",
      surface: "twilio-whatsapp",
      originatingChannel: "twilio-whatsapp",
      originatingTo: senderAddress,
      extraContext: mediaContext,
      deliver: async (payload) => {
        stopTyping();
        const text = payload.text ?? "";
        const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
        console.log(
          `[twilio-whatsapp] Direct deliver invoked sid=${fields.messageSid || "unknown"} ${summarizeText(text)} media=${mediaUrl ? "yes" : "no"}`,
        );
        if (!text && !mediaUrl) {
          console.log(
            `[twilio-whatsapp] Direct deliver skipped empty payload sid=${fields.messageSid || "unknown"}`,
          );
          return;
        }
        console.log(
          `[twilio-whatsapp] Twilio direct send start sid=${fields.messageSid || "unknown"} from=${recipientAddress} to=${senderAddress} ${summarizeText(text)} media=${mediaUrl ? "yes" : "no"}`,
        );
        const messageId = await sendTwilioWhatsappMessage({
          accountSid: account.accountSid,
          authToken: account.authToken,
          from: toPhone,
          to: fromPhone,
          body: text || undefined,
          mediaUrl,
        });
        console.log(
          `[twilio-whatsapp] Twilio direct send ok sid=${fields.messageSid || "unknown"} outboundSid=${messageId}`,
        );
      },
      onRecordError: (err) => {
        console.error("[twilio-whatsapp] Session record error:", err);
      },
      onDispatchError: (err, info) => {
        stopTyping();
        console.error(`[twilio-whatsapp] Dispatch error (${info.kind}):`, err);
      },
    });
  } finally {
    stopTyping();
  }
}

export function registerTwilioWhatsappHttpRoutes(
  api: OpenClawPluginApi,
  dependencies: {
    dispatchInbound?: DispatchInbound;
    downloadMedia?: typeof downloadTwilioMedia;
  } = {},
): void {
  const dispatchInbound = dependencies.dispatchInbound ?? dispatchInboundDirectDmWithRuntime;
  const downloadMedia = dependencies.downloadMedia ?? downloadTwilioMedia;
  api.registerHttpRoute({
    path: "/twilio/whatsapp/events",
    auth: "plugin",
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (req.method !== "POST") {
        twimlError(res, 405, "Method not allowed");
        return true;
      }

      let rawBody: string;
      try {
        rawBody = await readRequestBodyWithLimit(req, {
          maxBytes: WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: 10_000,
          destroyOnLimit: false,
        });
      } catch (err) {
        if (isRequestBodyLimitError(err)) {
          twimlError(res, err.statusCode, "Invalid request body");
          return true;
        }
        throw err;
      }

      const signature = firstHeader(req, "x-twilio-signature");
      const webhookUrl = firstHeader(req, "x-twilio-webhook-url");

      const fields = parseTwilioWebhook(rawBody);
      const toPhone = normalizePhoneNumber(fields.to);
      console.log(
        `[twilio-whatsapp] Webhook received sid=${fields.messageSid || "unknown"} from=${fields.from} to=${fields.to} bodyChars=${fields.body.length} media=${fields.media.length}`,
      );

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

      if (!webhookUrl || !signature) {
        console.error("[twilio-whatsapp] Missing forwarded Twilio signature headers");
        twimlError(res, 403, "Forbidden");
        return true;
      }

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

      if (!fields.accountSid || fields.accountSid !== account.accountSid) {
        console.error("[twilio-whatsapp] Twilio AccountSid does not match the target account");
        twimlError(res, 403, "Forbidden");
        return true;
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

      const rateLimitKey = `${account.accountId}:${fromPhone}`;
      if (webhookRateLimiter.isRateLimited(rateLimitKey)) {
        console.warn(`[twilio-whatsapp] Inbound rate limit exceeded for account=${account.accountId}`);
        twimlError(res, 429, "Too many requests");
        return true;
      }

      const inboundAccess = resolveTwilioInboundAccess({
        channelConfig: getTwilioChannelConfig(stored.cfg),
        senderPhone: fromPhone,
      });
      if (!inboundAccess.allowed) {
        console.warn(
          `[twilio-whatsapp] Blocked inbound sender for account=${account.accountId}: ${inboundAccess.reason}`,
        );
        twimlOk(res);
        return true;
      }

      if (fields.messageSid && replayCache.seen(`${account.accountId}:${fields.messageSid}`)) {
        console.info(`[twilio-whatsapp] Ignoring replayed MessageSid for account=${account.accountId}`);
        twimlOk(res);
        return true;
      }

      const receivedAt = Date.now();

      // Twilio receives its acknowledgement before any media or agent work. The
      // handler deliberately remains pending so OpenClaw retains the request's
      // work-admission lease through the eventual queued dispatch.
      twimlOk(res);
      console.log(
        `[twilio-whatsapp] Webhook acknowledged sid=${fields.messageSid || "unknown"} accountId=${account.accountId}`,
      );

      // Download all media attachments in parallel
      const resolvedMedia: ResolvedMedia[] = [];
      if (hasMedia) {
        const results = await Promise.all(
          fields.media.map((m) => downloadMedia(m.url, account)),
        );
        for (const r of results) {
          if (r) resolvedMedia.push(r);
        }
        console.log(
          `[twilio-whatsapp] Media resolved sid=${fields.messageSid || "unknown"} requested=${fields.media.length} saved=${resolvedMedia.length}`,
        );
      }

      const pendingMediaKey = resolvePendingMediaKey(account.accountId, fromPhone);
      const dispatchParams: TwilioDispatchParams = {
        fields,
        stored,
        account,
        toPhone,
        fromPhone,
        senderAddress,
        recipientAddress,
        conversationLabel,
        messageText,
        resolvedMedia,
        commandAuthorized: inboundAccess.commandAuthorized,
      };

      if (hasMedia && resolvedMedia.length > 0) {
        await queueMediaBatch(api, dispatchInbound, pendingMediaKey, {
          ...dispatchParams,
          receivedAt,
        });
        return true;
      }

      if (hasMedia && resolvedMedia.length === 0 && !messageText) {
        console.warn(
          `[twilio-whatsapp] Dropping media-only inbound with no resolved media sid=${fields.messageSid || "unknown"}`,
        );
        return true;
      }

      if (!hasMedia) {
        await flushPendingMediaBatch(api, dispatchInbound, pendingMediaKey, "before-text");
      }

      await enqueueConversationDispatch(pendingMediaKey, () =>
        dispatchTwilioInbound(api, dispatchInbound, dispatchParams),
      );

      return true;
    },
  });
}
