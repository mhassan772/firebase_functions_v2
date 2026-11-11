/// <reference types="vite/client" />

/// Local runs only (`npm run dev`); a production build never reads them. See the README.
interface ImportMetaEnv {
  /// Auth emulator URL, such as http://127.0.0.1:9096. Turns the emulators on.
  readonly VITE_AUTH_EMULATOR?: string;
  /// Functions emulator URL, such as http://127.0.0.1:5004.
  readonly VITE_FUNCTIONS_EMULATOR?: string;
  /// Firestore emulator URL, such as http://127.0.0.1:8089.
  readonly VITE_FIRESTORE_EMULATOR?: string;
  readonly VITE_PROJECT_ID?: string;
}
