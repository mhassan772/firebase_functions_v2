import { Firestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { admin } from "../config/admin";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 20;

/** Buckets of `recentBooksCount`; `max` is exclusive and absent on the last one. */
const HISTOGRAM_BUCKETS: { key: string; min: number; max?: number }[] = [
  { key: "0", min: 0, max: 1 },
  { key: "1-2", min: 1, max: 3 },
  { key: "3-5", min: 3, max: 6 },
  { key: "6-10", min: 6, max: 11 },
  { key: "11-25", min: 11, max: 26 },
  { key: "26-50", min: 26, max: 51 },
  { key: "51+", min: 51 },
];

export interface UrlPolicyDigest {
  day: string;
  topAccounts: {
    uid: string;
    anonymous: boolean;
    recentBooksCount: number;
    recentSamplesCount: number;
  }[];
  guestLedgersFirstSeen: number;
  devicesWithManyGuests: { deviceId: string; guestUidsCount: number }[];
  histogram: Record<string, number>;
  generatedAt: Timestamp;
}

/** Formats the UTC date of `date` as yyyymmdd, the digest's document id. */
export function digestDayId(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Builds the day's allowance digest from the URL ledgers without writing it.
 *
 * "Active" means a ledger updated in the 24 hours before `now`; the guest count
 * covers the UTC calendar day of `now`.
 */
export async function buildUrlPolicyDigest(db: Firestore, now: Date): Promise<UrlPolicyDigest> {
  const since = Timestamp.fromMillis(now.getTime() - DAY_MS);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const grants = db.collection("url_grants");
  const active = grants.where("updatedAt", ">=", since);

  const [topSnapshot, guestCount, devicesSnapshot, bucketCounts] = await Promise.all([
    active.orderBy("recentBooksCount", "desc").limit(TOP_LIMIT).get(),
    grants
      .where("anonymous", "==", true)
      .where("firstGrantAt", ">=", Timestamp.fromDate(dayStart))
      .where("firstGrantAt", "<", Timestamp.fromDate(dayEnd))
      .count()
      .get(),
    db.collection("url_grants_devices")
      .where("guestUidsCount", ">", 2)
      .orderBy("guestUidsCount", "desc")
      .limit(TOP_LIMIT)
      .get(),
    Promise.all(HISTOGRAM_BUCKETS.map(async (bucket) => {
      let q = active.where("recentBooksCount", ">=", bucket.min);
      if (bucket.max !== undefined) {
        q = q.where("recentBooksCount", "<", bucket.max);
      }
      return (await q.count().get()).data().count;
    })),
  ]);

  const histogram: Record<string, number> = {};
  HISTOGRAM_BUCKETS.forEach((bucket, i) => {
    histogram[bucket.key] = bucketCounts[i];
  });

  return {
    day: digestDayId(now),
    topAccounts: topSnapshot.docs.map((d) => ({
      uid: d.id,
      anonymous: d.get("anonymous") === true,
      recentBooksCount: d.get("recentBooksCount") ?? 0,
      recentSamplesCount: d.get("recentSamplesCount") ?? 0,
    })),
    guestLedgersFirstSeen: guestCount.data().count,
    devicesWithManyGuests: devicesSnapshot.docs.map((d) => ({
      deviceId: d.id,
      guestUidsCount: d.get("guestUidsCount") ?? 0,
    })),
    histogram,
    generatedAt: Timestamp.fromDate(now),
  };
}

/** Builds the digest and stores it at `url_policy_digest/{yyyymmdd}`, replacing a rerun's copy. */
export async function handleUrlPolicyDigest(
  db: Firestore = admin.firestore(),
  now: Date = new Date()
): Promise<UrlPolicyDigest> {
  const digest = await buildUrlPolicyDigest(db, now);
  await db.collection("url_policy_digest").doc(digest.day).set(digest);
  const top = digest.topAccounts[0];
  functions.logger.info(
    `url policy digest ${digest.day}: top=${top ? `${top.uid}:${top.recentBooksCount}` : "none"}` +
      ` newGuests=${digest.guestLedgersFirstSeen}` +
      ` devicesWithManyGuests=${digest.devicesWithManyGuests.length}` +
      ` histogram=${JSON.stringify(digest.histogram)}`
  );
  return digest;
}
