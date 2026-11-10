/// <reference types="vite/client" />

interface ImportMetaEnv {
  /// Auth emulator URL for local runs only, such as http://127.0.0.1:9199.
  readonly VITE_AUTH_EMULATOR?: string;
  readonly VITE_PROJECT_ID?: string;
}
