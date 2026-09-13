import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveTwilioInboundAccess } from "../src/access.js";

test("open policy admits messages without authorizing wildcard commands", () => {
  assert.deepEqual(
    resolveTwilioInboundAccess({
      channelConfig: { dmPolicy: "open", allowFrom: ["*"] },
      senderPhone: "+15551234567",
    }),
    {
      allowed: true,
      commandAuthorized: false,
      reason: "dmPolicy is open",
    },
  );
});

test("an explicitly allowlisted sender is command-authorized", () => {
  const access = resolveTwilioInboundAccess({
    channelConfig: {
      dmPolicy: "allowlist",
      allowFrom: ["whatsapp:+15551234567"],
    },
    senderPhone: "+15551234567",
  });

  assert.equal(access.allowed, true);
  assert.equal(access.commandAuthorized, true);
});

test("allowlist, pairing, and disabled policies block unapproved senders", () => {
  for (const dmPolicy of ["allowlist", "pairing", "disabled"] as const) {
    const access = resolveTwilioInboundAccess({
      channelConfig: { dmPolicy, allowFrom: ["+15550000000"] },
      senderPhone: "+15551234567",
    });
    assert.equal(access.allowed, false, dmPolicy);
    assert.equal(access.commandAuthorized, false, dmPolicy);
  }
});
