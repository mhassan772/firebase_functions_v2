// Import config to ensure Firebase Admin is initialized
import "./config/admin";

// Export all functions
export { egyptSubscription } from "./functions/subscriptions/egyptSubscription";
export { egyptSubscriptionNoAuth } from "./functions/subscriptions/egyptSubscriptionNoAuth";
export { restoreSubscriptionMigration } from "./functions/subscriptions/restoreSubscriptionMigration";
export { restoreSubscriptionMigrationNoAuth } from "./functions/subscriptions/restoreSubscriptionMigrationNoAuth";
export { getSubscriptionAccountBinding } from "./functions/subscriptions/getSubscriptionAccountBinding";
export { verifySubscription } from "./functions/subscriptions/verifySubscription";
export { appleSubscriptionNotifications } from "./functions/subscriptions/appleSubscriptionNotifications";
export { googleSubscriptionNotifications } from "./functions/subscriptions/googleSubscriptionNotifications";
export { admin_upload_to_S3 } from "./functions/admin/uploadToS3";
export { review } from "./functions/reviews/review";
export { reviewNoAuth } from "./functions/reviews/reviewNoAuth";
export { like } from "./functions/reviews/like";
export { likeNoAuth } from "./functions/reviews/likeNoAuth";
export { flag } from "./functions/reviews/flag";
export { flagNoAuth } from "./functions/reviews/flagNoAuth";
export { getUrls } from "./functions/downloads/getUrls";
export { getUrlsNoAuth } from "./functions/downloads/getUrlsNoAuth";
export { webDownloads } from "./functions/downloads/webDownloads";
export { reportIssue } from "./functions/issues/reportIssue";
