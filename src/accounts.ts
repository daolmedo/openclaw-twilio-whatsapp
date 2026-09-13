import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export type ResolvedTwilioAccount = {
  accountId: string;
  accountSid: string;
  authToken: string;
  phoneNumber: string;
};

type TwilioAccountEntry = {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
};

export type TwilioDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type TwilioChannelConfig = {
  dmPolicy?: TwilioDmPolicy;
  allowFrom?: Array<string | number>;
  accounts?: Record<string, TwilioAccountEntry>;
};

export const getTwilioChannelConfig = (
  cfg: OpenClawConfig,
): TwilioChannelConfig | undefined =>
  (cfg as Record<string, unknown>).channels &&
  ((cfg as Record<string, unknown>).channels as Record<string, unknown>)["twilio-whatsapp"]
    ? (((cfg as Record<string, unknown>).channels as Record<string, unknown>)[
        "twilio-whatsapp"
      ] as TwilioChannelConfig)
    : undefined;

export function listTwilioAccountIds(cfg: OpenClawConfig): string[] {
  const ch = getTwilioChannelConfig(cfg);
  return Object.keys(ch?.accounts ?? {});
}

export function resolveTwilioAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTwilioAccount {
  const ch = getTwilioChannelConfig(cfg);
  const id = accountId ?? "default";
  const entry = ch?.accounts?.[id];
  if (!entry) {
    throw new Error(
      `[twilio-whatsapp] No account configured for accountId="${id}". ` +
        `Add channels.twilio-whatsapp.accounts.${id} to openclaw.json.`,
    );
  }
  return {
    accountId: id,
    accountSid: entry.accountSid,
    authToken: entry.authToken,
    phoneNumber: entry.phoneNumber,
  };
}

export function findTwilioAccountByPhoneNumber(
  cfg: OpenClawConfig,
  phoneNumber: string,
): ResolvedTwilioAccount | undefined {
  const ch = getTwilioChannelConfig(cfg);
  if (!ch?.accounts) return undefined;
  for (const [id, entry] of Object.entries(ch.accounts)) {
    const normalized = normalizePhoneNumber(entry.phoneNumber);
    if (normalized === normalizePhoneNumber(phoneNumber)) {
      return { accountId: id, ...entry };
    }
  }
  return undefined;
}

export function normalizePhoneNumber(phone: string): string {
  return phone.replace(/^whatsapp:/, "").replace(/\s+/g, "");
}
