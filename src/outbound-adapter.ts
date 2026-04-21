import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/channels/plugins/types.adapters.js";
import { resolveTwilioAccount } from "./accounts.js";
import { sendTwilioWhatsappMessage } from "./send.js";

async function deliver(ctx: ChannelOutboundContext): Promise<string> {
  const account = resolveTwilioAccount(ctx.cfg, ctx.accountId);
  const sid = await sendTwilioWhatsappMessage({
    accountSid: account.accountSid,
    authToken: account.authToken,
    from: account.phoneNumber,
    to: ctx.to,
    body: ctx.text || undefined,
    mediaUrl: ctx.mediaUrl,
  });
  return sid;
}

export const twilioWhatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

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
