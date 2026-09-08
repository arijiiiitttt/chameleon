import { createApp } from "./app.js";
import { config } from "./config/config.js";

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[chameleon server] listening on :${config.port} (AI_PROVIDER=${config.aiProvider})`);
});
