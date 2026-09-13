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

test("splits oversized outbound messages without losing content", () => {
  const text = `${"word ".repeat(400)}tail`;
  const chunks = splitMessage(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_BODY_LENGTH));
  assert.equal(chunks.join(" "), text);
});
