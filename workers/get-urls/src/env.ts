export interface Env {
  GOOGLE_KEYS: KVNamespace;
  /** JSON key of the service account used for Firestore and Identity Toolkit. */
  GOOGLE_SERVICE_ACCOUNT: string;
  FIREBASE_PROJECT_ID: string;
  /** The project number, which App Check tokens name as issuer and audience. */
  FIREBASE_PROJECT_NUMBER: string;
  /** HMAC keys the CDNs check signed links with; see `src/shared/audioSigning.ts`. */
  AUDIO_SIGN_CF?: string;
  AUDIO_SIGN_BUNNY?: string;
}
