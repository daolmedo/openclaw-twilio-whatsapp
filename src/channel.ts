import type { ChannelPlugin } from "openclaw/channels/plugins/types.js";
import {
  listTwilioAccountIds,
  normalizePhoneNumber,
  resolveTwilioAccount,
  type ResolvedTwilioAccount,
} from "./accounts.js";
import { twilioWhatsappOutbound } from "./outbound-adapter.js";
import { clearRuntimeForPhoneNumber, setRuntimeForPhoneNumber } from "./runtime-store.js";

export const twilioWhatsappPlugin: ChannelPlugin<ResolvedTwilioAccount> = {
  id: "twilio-whatsapp",

  meta: {
    id: "twilio-whatsapp",
    label: "Twilio WhatsApp",
    selectionLabel: "WhatsApp (Twilio)",
    docsPath: "/channels/twilio-whatsapp",
    blurb: "WhatsApp messaging via Twilio Business API",
    markdownCapable: false,
    showInSetup: true,
    showConfigured: true,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },

  config: {
    listAccountIds: listTwilioAccountIds,

    resolveAccount(cfg, accountId) {
      return resolveTwilioAccount(cfg, accountId);
    },

    isConfigured(account) {
      return Boolean(account.accountSid && account.authToken && account.phoneNumber);
    },

    describeAccount(account) {
      return {
        accountId: account.accountId,
        configured: Boolean(account.accountSid && account.authToken && account.phoneNumber),
        name: `WhatsApp ${account.phoneNumber}`,
      };
    },

    hasConfiguredState({ cfg }) {
      return listTwilioAccountIds(cfg).length > 0;
    },
  },

  outbound: twilioWhatsappOutbound,

  gateway: {
    async startAccount(ctx) {
      const account = ctx.account as ResolvedTwilioAccount;
      const phoneNumber = normalizePhoneNumber(account.phoneNumber);

      if (!ctx.channelRuntime) {
        console.error(
          `[twilio-whatsapp] channelRuntime not provided for account ${ctx.accountId}. ` +
            "Inbound dispatch will not work.",
        );
        return;
      }

      setRuntimeForPhoneNumber(phoneNumber, {
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        channelRuntime: ctx.channelRuntime,
      });

      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        connected: true,
        configured: true,
        name: `WhatsApp ${account.phoneNumber}`,
        webhookPath: "/twilio/whatsapp/events",
      });

      console.log(
        `[twilio-whatsapp] Account ${ctx.accountId} started, listening on /twilio/whatsapp/events for ${account.phoneNumber}`,
      );

      await new Promise<void>((_, reject) => {
        ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
      }).catch(() => {
        clearRuntimeForPhoneNumber(phoneNumber);
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          connected: false,
        });
        console.log(`[twilio-whatsapp] Account ${ctx.accountId} stopped`);
      });
    },
  },
};
