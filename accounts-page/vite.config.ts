import { defineConfig, type Plugin } from "vite";

/// Gives `/action` its own copy of the Auth SDK in the production build.
///
/// The SDK is one large module. Shared between two routes it would land whole in a common chunk,
/// so `/action` would download the popup, Google API loader and token revocation code that only
/// `/delete` uses. Marking every Auth module `/action` reaches makes the bundler keep a separate,
/// separately tree-shaken copy. Only one route runs per page load, so the copies never meet;
/// `@firebase/app` and the other shared packages stay single.
function actionOwnAuthCopy(): Plugin {
  const marker = "?route-action";
  const authPackage = /[\\/]node_modules[\\/](@firebase[\\/]auth|firebase[\\/]auth)[\\/]/;
  return {
    name: "mantooq-action-own-auth-copy",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const fromAction = /[\\/]src[\\/]routes[\\/]action\.ts$/.test(importer) && source === "firebase/auth";
      const insideMarkedCopy = importer.endsWith(marker) && authPackage.test(importer);
      if (!fromAction && !insideMarkedCopy) return null;
      const resolved = await this.resolve(source, importer.replace(marker, ""), { ...options, skipSelf: true });
      if (!resolved || resolved.external || !authPackage.test(resolved.id)) return resolved;
      return { ...resolved, id: `${resolved.id}${marker}` };
    },
  };
}

export default defineConfig({
  plugins: [actionOwnAuthCopy()],
  build: {
    // The preload helper's polyfill is only for browsers without module preload, and every
    // browser that runs this page's ES modules has it; leaving it out keeps the entry smaller.
    modulePreload: { polyfill: false },
  },
});
