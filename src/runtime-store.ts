import type { OpenClawConfig } from "openclaw/channels/plugins/types.js";

export type StoredTwilioRuntime = {
  cfg: OpenClawConfig;
  accountId: string;
  channelRuntime: NonNullable<
    import("openclaw/channels/plugins/types.adapters.js").ChannelGatewayContext["channelRuntime"]
  >;
};

const phoneToRuntime = new Map<string, StoredTwilioRuntime>();

export function setRuntimeForPhoneNumber(phoneNumber: string, runtime: StoredTwilioRuntime): void {
  phoneToRuntime.set(phoneNumber, runtime);
}

export function clearRuntimeForPhoneNumber(phoneNumber: string): void {
  phoneToRuntime.delete(phoneNumber);
}

export function getRuntimeForPhoneNumber(phoneNumber: string): StoredTwilioRuntime | undefined {
  return phoneToRuntime.get(phoneNumber);
}
