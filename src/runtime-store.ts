import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export type StoredTwilioRuntime = {
  cfg: OpenClawConfig;
  accountId: string;
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
