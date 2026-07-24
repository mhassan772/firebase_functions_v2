export const REGION = "europe-west2";
export const PROJECT_ID = "1008654973131";
export const FIREBASE_PROJECT_ID = "mantooq-test";
export const STORAGE_BUCKET = "mantooq-images-p";
export const AWS_REGION = "eu-west-1";
export const PRESIGNED_URL_EXPIRES_IN = 3600; // 1 hour

export const SUBSCRIPTION_SERVICE_ACCOUNT =
  "subscription-verifier@mantooq-test.iam.gserviceaccount.com";
export const APPLE_BUNDLE_ID = "com.ktc.MantooqAppiOS";
export const APPLE_APP_ID = 1624497481;
export const APPLE_SUBSCRIPTION_PRODUCTS = ["monthly_sub", "yearly_sub"] as const;
export const GOOGLE_PACKAGE_NAME = "ca.basira.mantooqapp";
export const GOOGLE_SUBSCRIPTION_PRODUCTS = ["premium_access"] as const;
export const GOOGLE_SUBSCRIPTION_BASE_PLANS = ["monthly", "yearly"] as const;
export const GOOGLE_PLAY_SUBSCRIPTION_TOPIC =
  "mantooq-play-subscription-notifications";

export const SUBSCRIPTION_SECRETS = {
  appleIssuerId: "APPLE_APP_STORE_ISSUER_ID",
  appleKeyId: "APPLE_APP_STORE_KEY_ID",
  applePrivateKey: "APPLE_APP_STORE_PRIVATE_KEY",
  accountBindingHmacKey: "SUBSCRIPTION_ACCOUNT_BINDING_HMAC_KEY",
} as const;

export const WEB_CORS_ALLOWED_ORIGINS = [
  "http://localhost:5000",
  "https://mantooq-web.onrender.com",
];
