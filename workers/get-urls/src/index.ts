import { refreshGoogleKeys } from "./auth/googleKeys";
import { Env } from "./env";
import { handleGetUrls } from "./handler";

export default {
  fetch(request, env) {
    return handleGetUrls(request, env);
  },

  /** Keeps every signing key Google publishes in KV, so tokens outlive the key's retirement. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      refreshGoogleKeys(env.GOOGLE_KEYS).catch((error) =>
        console.error(JSON.stringify({ event: "googleKeys.refresh.failed", error: String(error) }))
      )
    );
  },
} satisfies ExportedHandler<Env>;
