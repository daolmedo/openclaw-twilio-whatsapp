import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core.js";
import { twilioWhatsappPlugin } from "./src/channel.js";
import { registerTwilioWhatsappHttpRoutes } from "./src/http-routes.js";

export default defineChannelPluginEntry({
  id: "twilio-whatsapp",
  name: "Twilio WhatsApp",
  description: "WhatsApp channel via Twilio Business API (ISV)",
  plugin: twilioWhatsappPlugin,
  registerFull(api) {
    registerTwilioWhatsappHttpRoutes(api);
  },
});
