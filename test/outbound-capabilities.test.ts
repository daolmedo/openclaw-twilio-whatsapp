import { strict as assert } from "node:assert";
import { test } from "node:test";
import { twilioWhatsappPlugin } from "../src/channel.js";
import { twilioWhatsappOutbound } from "../src/outbound-adapter.js";
import { MAX_BODY_LENGTH, splitMessage } from "../src/send.js";

test("advertises durable final text, media, and sending-hook delivery", () => {
  assert.deepEqual(twilioWhatsappOutbound.deliveryCapabilities?.durableFinal, {
    text: true,
    media: true,
    messageSendingHooks: true,
  });
  assert.ok(twilioWhatsappPlugin.message);
});

test("normalizes ambient WhatsApp targets for message-tool sends", () => {
  const messaging = twilioWhatsappPlugin.messaging;
  assert.ok(messaging?.normalizeTarget);
  assert.ok(messaging.targetResolver?.looksLikeId);

  for (const target of [
    "+15551234567",
    "whatsapp:+15551234567",
    "twilio-whatsapp:+15551234567",
    "twilio-whatsapp:whatsapp:+15551234567",
  ]) {
    const normalized: string | undefined = messaging.normalizeTarget(target);
    assert.equal(normalized, "+15551234567");
    assert.equal(messaging.targetResolver.looksLikeId(target, normalized), true);
  }

  assert.equal(messaging.targetResolver.looksLikeId("not-a-phone"), false);
});

test("routes prefixed WhatsApp targets to the canonical direct session", async () => {
  const resolveRoute = twilioWhatsappPlugin.messaging?.resolveOutboundSessionRoute;
  assert.ok(resolveRoute);

  const route = await resolveRoute({
    cfg: {},
    agentId: "lucas",
    accountId: "default",
    target: "whatsapp:+15551234567",
  });

  assert.ok(route);
  assert.deepEqual(route.peer, { kind: "direct", id: "+15551234567" });
  assert.equal(route.chatType, "direct");
  assert.equal(route.from, "whatsapp:+15551234567");
  assert.equal(route.to, "whatsapp:+15551234567");
  assert.equal(route.recipientSessionExact, true);
  assert.equal(route.sessionKey, route.baseSessionKey);
});

test("splits oversized outbound messages without losing content", () => {
  const text = `${"word ".repeat(400)}tail`;
  const chunks = splitMessage(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_BODY_LENGTH));
  assert.equal(chunks.join(" "), text);
});
