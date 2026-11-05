import { UserRecord } from "firebase-admin/auth";
import * as functions from "firebase-functions";
import { admin } from "../config/admin";
import { GetUrlsRequest, GetUrlsResponse, Recording, Settings } from "../types";
import {
  allowsUnverifiedEmail,
  assertSourcesComplete,
  BookSource,
  buildGroupedResponse,
  buildPolicyResponse,
  buildSuccessResponse,
  emailNotVerifiedError,
  notFoundUserError,
  PUBLIC_DOMAIN,
} from "../shared/getUrlsCore";
import { SigningSecrets, uidHash } from "../shared/audioSigning";
import {
  allowanceFor,
  GrantReason,
  parseUrlPolicy,
  policyApplies,
  summarizeGrants,
} from "../shared/urlPolicy";
import { isPremiumAccount, runGrantTransaction } from "../services/urlGrantsLedger";

/** What the allowance policy needs to know about the request; absent means the policy-free path. */
export interface PolicyContext {
  settings: Settings;
  /** The request carried a valid App Check token. */
  attested: boolean;
  secrets: Omit<SigningSecrets, "keyVersion">;
  nowMs?: number;
}

export async function handleGetUrls(
  request: GetUrlsRequest,
  authId: string,
  publicDomain?: string,
  policyContext?: PolicyContext
): Promise<GetUrlsResponse> {
  const user = await verifyUserEmail(authId, request);

  const bookGuids = request.books.map((b) => b.bookGuid);

  const [books, recordingSnapshots] = await Promise.all([
    getBooksInBatch(bookGuids),
    getRecordingsInBatch(bookGuids),
  ]);

  const sources: BookSource[] = books.map((bookDoc, i) => {
    const recordingDoc = recordingSnapshots[i].docs[0];
    return {
      bookExists: bookDoc.exists,
      recordings: recordingDoc?.exists
        ? (recordingDoc.data()?.recordings as Record<string, Recording> | undefined)
        : null,
    };
  });

  const policy = policyContext ? parseUrlPolicy(policyContext.settings.urlPolicy) : null;
  if (!policyContext || !policy || !policyApplies(policy, request.build_number)) {
    return buildSuccessResponse(buildGroupedResponse(request, sources, publicDomain));
  }

  // A request that fails on the catalogue spends nothing.
  assertSourcesComplete(request, sources);

  const nowMs = policyContext.nowMs ?? Date.now();
  const anonymous = user.providerData.length === 0;
  const createdAtMs = user.metadata.creationTime ? Date.parse(user.metadata.creationTime) : NaN;
  const identity = {
    anonymous,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
    premium: await isPremiumAccount(authId, nowMs),
    attested: policyContext.attested,
  };
  const { tier, attested, allowance } = allowanceFor(identity, policy, nowMs);

  const result = await runGrantTransaction({
    uid: authId,
    deviceId: request.deviceId,
    anonymous,
    createdAtMs: identity.createdAtMs,
    books: request.books.map((book) => ({ guid: book.bookGuid, reason: book.reason as GrantReason })),
    allowance,
    enforce: policy.enforce,
    nowMs,
  });
  functions.logger.info({
    event: "getUrls.allowance",
    uid: authId,
    tier,
    attested,
    anonymous,
    build: request.build_number,
    enforce: policy.enforce,
    ...summarizeGrants(result),
  });

  const issuedAtSec = Math.floor(nowMs / 1000);
  const data = await buildPolicyResponse(request, sources, publicDomain ?? PUBLIC_DOMAIN, {
    decisions: result.decisions,
    signing: { uidHash: await uidHash(authId), issuedAtSec, ttlSec: policy.linkTtlHours * 3600 },
    secrets: { ...policyContext.secrets, keyVersion: policy.keyVersion },
  });
  return buildSuccessResponse(data);
}

async function verifyUserEmail(authId: string, request: GetUrlsRequest): Promise<UserRecord> {
  try {
    const user = await admin.auth().getUser(authId);
    // Listening comes before the account is in force; only a download waits on the verified email.
    if (!user.emailVerified && !allowsUnverifiedEmail(request.books)) {
      throw emailNotVerifiedError();
    }
    return user;
  } catch (error: any) {
    if (error.code === "auth/user-not-found") {
      throw notFoundUserError();
    }
    throw error;
  }
}

async function getBooksInBatch(
  guids: string[]
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  if (guids.length === 0) return [];

  const bookRefs = guids.map((guid) =>
    admin.firestore().collection("books").doc(guid)
  );
  return admin.firestore().getAll(...bookRefs);
}

async function getRecordingsInBatch(
  bookGuids: string[]
): Promise<FirebaseFirestore.QuerySnapshot[]> {
  if (bookGuids.length === 0) return [];

  const queries = bookGuids.map((bookGuid) =>
    admin
      .firestore()
      .collection("book_recordings")
      .where("book_guid", "==", bookGuid)
      .get()
  );
  return Promise.all(queries);
}

export async function getSettings(): Promise<Settings> {
  const docSnapshot = await admin
    .firestore()
    .collection("settings")
    .doc("mantooqAppSettings")
    .get();
  return (docSnapshot.data() as Settings) || {};
}
