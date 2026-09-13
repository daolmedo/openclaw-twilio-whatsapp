import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { resolveTwilioAccount } from "./accounts.js";
import { sendTwilioWhatsappMessage } from "./send.js";

function summarizeText(text?: string): string {
  if (!text) return "chars=0";
  return `chars=${text.length} preview=${JSON.stringify(text.slice(0, 120))}`;
}

async function deliver(ctx: ChannelOutboundContext): Promise<string> {
  const account = resolveTwilioAccount(ctx.cfg, ctx.accountId);
  console.log(
    `[twilio-whatsapp] Durable adapter deliver start accountId=${ctx.accountId ?? "default"} from=${account.phoneNumber} to=${ctx.to} ${summarizeText(ctx.text)} media=${ctx.mediaUrl ? "yes" : "no"}`,
  );
  try {
    const sid = await sendTwilioWhatsappMessage({
      accountSid: account.accountSid,
      authToken: account.authToken,
      from: account.phoneNumber,
      to: ctx.to,
      body: ctx.text || undefined,
      mediaUrl: ctx.mediaUrl,
    });
    console.log(
      `[twilio-whatsapp] Durable adapter deliver ok accountId=${ctx.accountId ?? "default"} outboundSid=${sid}`,
    );
    return sid;
  } catch (err) {
    console.error(
      `[twilio-whatsapp] Durable adapter deliver failed accountId=${ctx.accountId ?? "default"}:`,
      err,
    );
    throw err;
  }
}

export const twilioWhatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },

  async sendText(ctx) {
    const messageId = await deliver(ctx);
    return {
      channel: "twilio-whatsapp",
      messageId,
    };
  },

  async sendMedia(ctx) {
    const messageId = await deliver(ctx);
    return {
      channel: "twilio-whatsapp",
      messageId,
    };
  },
};

export const twilioWhatsappMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "twilio-whatsapp",
  outbound: twilioWhatsappOutbound,
});
