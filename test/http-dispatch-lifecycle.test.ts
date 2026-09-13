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
  body = "";
  ended = false;

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(body = ""): this {
    this.body = body;
    this.ended = true;
    return this;
  }
}

test("acknowledges Twilio immediately but retains the route lease through dispatch", async () => {
  const accountSid = "AC123";
  const authToken = "test-auth-token";
  const toPhone = "+15557654321";
  const fromPhone = "+15551234567";
  const webhookUrl = "https://example.test/whatsapp/events";
  const rawBody = new URLSearchParams({
    AccountSid: accountSid,
    From: `whatsapp:${fromPhone}`,
    To: `whatsapp:${toPhone}`,
    Body: "hello",
    NumMedia: "0",
  }).toString();
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    webhookUrl,
    Object.fromEntries(new URLSearchParams(rawBody)),
  );

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
  let releaseDispatch: (() => void) | undefined;
  const dispatchPromise = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const dispatchInbound = (() => dispatchPromise) as unknown as typeof dispatchInboundDirectDmWithRuntime;
  const api = {
    runtime: {},
    registerHttpRoute(registered: typeof route) {
      route = registered;
    },
  } as unknown as OpenClawPluginApi;
  registerTwilioWhatsappHttpRoutes(api, { dispatchInbound });

  const request = new FakeRequest();
  request.headers = {
    "x-twilio-signature": signature,
    "x-twilio-webhook-url": webhookUrl,
  };
  const response = new FakeResponse();
  const handled = route!.handler(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  request.emit("data", Buffer.from(rawBody));
  request.emit("end");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.ended, true);
  assert.equal(response.statusCode, 200);

  let handlerSettled = false;
  void handled.finally(() => {
    handlerSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handlerSettled, false);

  releaseDispatch!();
  assert.equal(await handled, true);
  clearRuntimeForPhoneNumber(toPhone);
});
