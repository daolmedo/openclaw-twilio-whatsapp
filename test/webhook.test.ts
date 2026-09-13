import { strict as assert } from "node:assert";
import { test } from "node:test";
import twilio from "twilio";
import { parseTwilioWebhook, verifyTwilioSignature } from "../src/webhook.js";

const authToken = "test-auth-token";
const url = "https://example.execute-api.us-east-1.amazonaws.com/main/whatsapp/events";
const form = new URLSearchParams({
  AccountSid: "AC123",
  MessageSid: "SM123",
  From: "whatsapp:+15551234567",
  To: "whatsapp:+15557654321",
  Body: "hello",
  NumMedia: "1",
  MediaUrl0: "https://api.twilio.com/media/ME123",
  MediaContentType0: "image/jpeg",
}).toString();

test("Twilio webhook parsing retains account and media identity", () => {
  const parsed = parseTwilioWebhook(form);
  assert.equal(parsed.accountSid, "AC123");
  assert.equal(parsed.messageSid, "SM123");
  assert.equal(parsed.from, "+15551234567");
  assert.deepEqual(parsed.media, [
    { url: "https://api.twilio.com/media/ME123", contentType: "image/jpeg" },
  ]);
});

test("Twilio signature validation uses the original router URL and form fields", () => {
  const fields = Object.fromEntries(new URLSearchParams(form));
  const signature = twilio.getExpectedTwilioSignature(authToken, url, fields);

  assert.equal(
    verifyTwilioSignature({ authToken, signature, url, rawBody: form }),
    true,
  );
  assert.equal(
    verifyTwilioSignature({ authToken, signature, url: `${url}/wrong`, rawBody: form }),
    false,
  );
});
