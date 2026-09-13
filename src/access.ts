import {
  normalizePhoneNumber,
  type TwilioChannelConfig,
  type TwilioDmPolicy,
} from "./accounts.js";

export type TwilioInboundAccess = {
  allowed: boolean;
  commandAuthorized: boolean;
  reason: string;
};

function normalizeAllowEntry(value: string | number): string {
  const raw = String(value).trim();
  return raw === "*" ? raw : normalizePhoneNumber(raw);
}

export function resolveTwilioInboundAccess(params: {
  channelConfig?: TwilioChannelConfig;
  senderPhone: string;
}): TwilioInboundAccess {
  const policy: TwilioDmPolicy = params.channelConfig?.dmPolicy ?? "pairing";
  const sender = normalizePhoneNumber(params.senderPhone);
  const entries = (params.channelConfig?.allowFrom ?? []).map(normalizeAllowEntry);
  const hasSpecificMatch = entries.some((entry) => entry !== "*" && entry === sender);
  const hasWildcard = entries.includes("*");

  if (policy === "disabled") {
    return { allowed: false, commandAuthorized: false, reason: "dmPolicy is disabled" };
  }

  if (policy === "open") {
    return {
      allowed: true,
      // A public wildcard can admit conversation traffic, but must not grant
      // privileged OpenClaw slash/control commands to every WhatsApp sender.
      commandAuthorized: hasSpecificMatch,
      reason: "dmPolicy is open",
    };
  }

  if (hasSpecificMatch || hasWildcard) {
    return {
      allowed: true,
      commandAuthorized: hasSpecificMatch,
      reason: `${policy} sender matched allowFrom`,
    };
  }

  return {
    allowed: false,
    commandAuthorized: false,
    reason:
      policy === "pairing"
        ? "pairing is required and this plugin has no paired sender entry"
        : "sender is not in allowFrom",
  };
}
