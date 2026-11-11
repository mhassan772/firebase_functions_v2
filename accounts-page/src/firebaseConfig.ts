/// The Firebase web config and the local emulator settings both routes start from.

import type { FirebaseOptions } from "firebase/app";

export interface EmulatorSettings {
  projectId: string;
  /// Auth emulator URL, such as http://127.0.0.1:9096.
  auth: string;
  /// Functions emulator URL; absent when only Auth is emulated.
  functions?: string;
  /// Firestore emulator URL; absent when only Auth is emulated.
  firestore?: string;
}

/// Emulator settings for `npm run dev`.
///
/// Callers check `import.meta.env.DEV` first, at the call site: it is a compile-time false in a
/// production build, so the bundler drops the whole branch and no emulator value ships.
export function emulatorSettings(): EmulatorSettings | null {
  if (!import.meta.env.DEV || !import.meta.env.VITE_AUTH_EMULATOR) return null;
  return {
    projectId: import.meta.env.VITE_PROJECT_ID ?? "demo-mantooq",
    auth: import.meta.env.VITE_AUTH_EMULATOR,
    functions: import.meta.env.VITE_FUNCTIONS_EMULATOR || undefined,
    firestore: import.meta.env.VITE_FIRESTORE_EMULATOR || undefined,
  };
}

export async function firebaseOptions(): Promise<FirebaseOptions> {
  if (import.meta.env.DEV) {
    const emulators = emulatorSettings();
    // The emulators ignore the key; a popup still needs some auth domain to be configured.
    if (emulators) return { apiKey: "demo-key", projectId: emulators.projectId, authDomain: location.host };
  }
  // Firebase Hosting serves the project's own web config here, so no key is committed and a
  // crafted link can't point the page at another project.
  const response = await fetch("/__/firebase/init.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`init.json ${response.status}`);
  return (await response.json()) as FirebaseOptions;
}

/// Splits an emulator URL into the host and port the SDKs' connect functions take.
export function hostAndPort(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) };
}
