import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import twilio from "twilio";
import { registerTwilioWhatsappHttpRoutes } from "../src/http-routes.js";
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

test("batches sequential Twilio media webhooks and retains both route leases", async () => {
  const previousFlushMs = process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS;
  process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS = "40";

  const accountSid = "AC123";
  const authToken = "test-auth-token";
  const toPhone = "+15557654321";
  const fromPhone = "+15551234567";
  const webhookUrl = "https://example.test/whatsapp/events";
  const cfg = {
    channels: {
      "twilio-whatsapp": {
        dmPolicy: "open",
        allowFrom: ["*"],
        accounts: {
          lisu: { accountSid, authToken, phoneNumber: toPhone },
        },
      },
    },
  };
  setRuntimeForPhoneNumber(toPhone, { cfg, accountId: "lisu" });

  let route:
    | { handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }
    | undefined;
  const dispatches: Array<Record<string, unknown>> = [];
  let signalDispatchStarted: (() => void) | undefined;
  const dispatchStarted = new Promise<void>((resolve) => {
    signalDispatchStarted = resolve;
  });
  let releaseDispatch: (() => void) | undefined;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const dispatchInbound = (async (params: Record<string, unknown>) => {
    dispatches.push(params);
    signalDispatchStarted!();
    await dispatchGate;
  }) as unknown as typeof dispatchInboundDirectDmWithRuntime;
  const api = {
    runtime: {},
    registerHttpRoute(registered: typeof route) {
      route = registered;
    },
  } as unknown as OpenClawPluginApi;
  registerTwilioWhatsappHttpRoutes(api, {
    dispatchInbound,
    downloadMedia: async (url) => ({
      path: `/saved/${url.endsWith("/1") ? "one.jpg" : "two.jpg"}`,
      contentType: "image/jpeg",
    }),
  });

  const invoke = (caption: string, mediaUrl: string) => {
    const rawBody = new URLSearchParams({
      AccountSid: accountSid,
      From: `whatsapp:${fromPhone}`,
      To: `whatsapp:${toPhone}`,
      Body: caption,
      NumMedia: "1",
      MediaUrl0: mediaUrl,
      MediaContentType0: "image/jpeg",
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
    return { handled, response };
  };

  try {
    const first = invoke("first", "https://media.test/1");
    await new Promise((resolve) => setImmediate(resolve));
    const second = invoke("second", "https://media.test/2");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(first.response.statusCode, 200);
    assert.equal(second.response.statusCode, 200);
    assert.equal(first.response.ended, true);
    assert.equal(second.response.ended, true);
    assert.equal(dispatches.length, 0);

    await dispatchStarted;
    let handlersSettled = false;
    void Promise.all([first.handled, second.handled]).then(() => {
      handlersSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlersSettled, false);

    releaseDispatch!();
    assert.deepEqual(await Promise.all([first.handled, second.handled]), [true, true]);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].rawBody, "first\n\nsecond");
    assert.deepEqual(
      (dispatches[0].extraContext as { MediaPaths: string[] }).MediaPaths,
      ["/saved/one.jpg", "/saved/two.jpg"],
    );
  } finally {
    clearRuntimeForPhoneNumber(toPhone);
    if (previousFlushMs === undefined) {
      delete process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS;
    } else {
      process.env.TWILIO_WHATSAPP_MEDIA_BATCH_FLUSH_MS = previousFlushMs;
    }
  }
});
