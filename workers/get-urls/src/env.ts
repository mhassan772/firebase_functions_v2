export interface Env {
  GOOGLE_KEYS: KVNamespace;
  /** JSON key of the service account used for Firestore and Identity Toolkit. */
  GOOGLE_SERVICE_ACCOUNT: string;
  FIREBASE_PROJECT_ID: string;
}
