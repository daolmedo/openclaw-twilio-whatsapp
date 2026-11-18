import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import twilio from "twilio";
import { registerTwilioWhatsappHttpRoutes, resolveOpenAiAudioModelConfig } from "../src/http-routes.js";
import { clearRuntimeForPhoneNumber, setRuntimeForPhoneNumber } from "../src/runtime-store.js";

class FakeRequest extends EventEmitter {
  method = "POST";
  headers: Record<string, string> = {};
  destroyed = false;
  socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    pause() {},
    resume() {},
  });
}

class FakeResponse {
  statusCode?: number;
  ended = false;
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(): this {
    this.ended = true;
    return this;
  }
}

test("resolveOpenAiAudioModelConfig reads the configured audio model", () => {
  assert.deepEqual(resolveOpenAiAudioModelConfig({}), { model: "gpt-transcribe", prompt: undefined, language: undefined });
  assert.deepEqual(
    resolveOpenAiAudioModelConfig({
      tools: {
        media: {
          models: [
            { provider: "openai", model: "gpt-5.4-mini", capabilities: ["image"] },
            { provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"], prompt: "Cody" },
          ],
        },
      },
    }),
    { model: "gpt-4o-mini-transcribe", prompt: "Cody", language: undefined },
  );
  assert.equal(
    resolveOpenAiAudioModelConfig({ tools: { media: { audio: { models: [{ model: "whisper-1" }] } } } }).model,
    "whisper-1",
  );
  // Non-OpenAI audio providers can't be called on the OpenAI endpoint.
  assert.equal(
    resolveOpenAiAudioModelConfig({
      tools: { media: { models: [{ provider: "deepgram", model: "nova-3", capabilities: ["audio"] }] } },
    }).model,
    "gpt-transcribe",
  );
});

test("voice note is transcribed once and marked as transcribed for core", async () => {
  const previousFlushMs = process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS;
  const previousInitialWaitMs = process.env.TWILIO_WHATSAPP_MEDIA_BATCH_INITIAL_WAIT_MS;
  process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS = "10";
  process.env.TWILIO_WHATSAPP_MEDIA_BATCH_INITIAL_WAIT_MS = "10";
  const previousFetch = globalThis.fetch;

  const dir = await mkdtemp(path.join(tmpdir(), "twilio-stt-"));
  const audioPath = path.join(dir, "voice.ogg");
  await writeFile(audioPath, Buffer.from("fake-ogg"));

  const accountSid = "AC123";
  const authToken = "test-auth-token";
  const toPhone = "+15557654321";
  const fromPhone = "+15551234567";
  const webhookUrl = "https://example.test/whatsapp/events";
  const cfg = {
    bindings: [{ agentId: "main", match: { channel: "twilio-whatsapp", accountId: "lisu" } }],
    tools: {
      media: {
        models: [{ provider: "openai", model: "gpt-transcribe", capabilities: ["audio"], prompt: "Cody" }],
      },
    },
    channels: {
      "twilio-whatsapp": {
        dmPolicy: "open",
        allowFrom: ["*"],
        accounts: { lisu: { accountSid, authToken, phoneNumber: toPhone } },
      },
    },
  };
  // Test cfg carries fields beyond the SDK config type (prompt on media models).
  setRuntimeForPhoneNumber(toPhone, { cfg: cfg as never, accountId: "lisu" });

  const sttCalls: FormData[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/audio/transcriptions")) {
      sttCalls.push(init!.body as FormData);
      return new Response(JSON.stringify({ text: "hola Cody" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  let route:
    | { handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }
    | undefined;
  const dispatches: Array<Record<string, unknown>> = [];
  const dispatchInbound = (async (params: Record<string, unknown>) => {
    dispatches.push(params);
  }) as unknown as typeof dispatchInboundDirectDmWithRuntime;
  const api = {
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => dir },
      modelAuth: { resolveApiKeyForProvider: async () => ({ apiKey: "sk-test" }) },
    },
    registerHttpRoute(registered: typeof route) {
      route = registered;
    },
  } as unknown as OpenClawPluginApi;
  registerTwilioWhatsappHttpRoutes(api, {
    dispatchInbound,
    downloadMedia: async () => ({ path: audioPath, contentType: "audio/ogg" }),
  });

  try {
    const rawBody = new URLSearchParams({
      AccountSid: accountSid,
      From: `whatsapp:${fromPhone}`,
      To: `whatsapp:${toPhone}`,
      Body: "",
      NumMedia: "1",
      MediaUrl0: "https://media.test/voice",
      MediaContentType0: "audio/ogg",
    }).toString();
    const request = new FakeRequest();
    request.headers = {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        authToken,
        webhookUrl,
        Object.fromEntries(new URLSearchParams(rawBody)),
      ),
      "x-twilio-webhook-url": webhookUrl,
    };
    const response = new FakeResponse();
    const handled = route!.handler(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    request.emit("data", Buffer.from(rawBody));
    request.emit("end");
    assert.equal(await handled, true);

    assert.equal(sttCalls.length, 1);
    assert.equal(sttCalls[0].get("model"), "gpt-transcribe");
    assert.equal(sttCalls[0].get("prompt"), "Cody");
    assert.equal(dispatches.length, 1);
    const extra = dispatches[0].extraContext as Record<string, unknown>;
    assert.deepEqual(extra.MediaTranscribedIndexes, [0]);
    assert.equal(extra.Transcript, "hola Cody");
    assert.equal(dispatches[0].bodyForAgent, "[Audio]\nTranscript:\nhola Cody");
  } finally {
    globalThis.fetch = previousFetch;
    clearRuntimeForPhoneNumber(toPhone);
    if (previousFlushMs === undefined) delete process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS;
    else process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS = previousFlushMs;
    if (previousInitialWaitMs === undefined) delete process.env.TWILIO_WHATSAPP_MEDIA_BATCH_INITIAL_WAIT_MS;
    else process.env.TWILIO_WHATSAPP_MEDIA_BATCH_INITIAL_WAIT_MS = previousInitialWaitMs;
  }
});
