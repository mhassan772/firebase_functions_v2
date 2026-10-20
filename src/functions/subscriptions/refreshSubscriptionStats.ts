import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { refreshSubscriptionStats as refreshStats } from "../../services/subscriptions/stats";

/**
 * Rebuilds `subscription_stats/current` for the admin dashboard and records the
 * day's totals in `subscription_stats_daily`. Admins can also run it from the
 * portal through `adminManageSubscription`'s `refreshStats` action.
 *
 * Runs once a day just before Cairo midnight, because the run records the
 * active count of that moment as the day's total.
 */
export const refreshSubscriptionStats = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "512MB" })
  .pubsub.schedule("55 23 * * *")
  .timeZone("Africa/Cairo")
  .onRun(async () => {
    await refreshStats();
  });
