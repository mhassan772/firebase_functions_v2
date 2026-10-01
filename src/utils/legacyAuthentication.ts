import * as functions from "firebase-functions";
import { DecodedIdToken } from "firebase-admin/auth";
import { admin } from "../config/admin";

// Released app versions parse this exact body from a 400 response, so it must
// not change to the 401 shape used by utils/authentication.ts.
const authenticationError = JSON.stringify({ code: 603, message: "unauthorized" });

/**
 * Reads a Firebase ID token from the Authorization header or the `__session` cookie.
 *
 * Used by downloadHttpV3, streamHttp and sampleHttp. Throws an internal
 * HttpsError whose message is the legacy JSON error body.
 */
export async function validateLegacyRequestAuthentication(
  request: functions.https.Request
): Promise<DecodedIdToken> {
  const header = request.headers.authorization;
  const hasBearer = !!header && header.startsWith("Bearer ");
  const sessionCookie = request.cookies?.__session;

  if (!hasBearer && !sessionCookie) {
    throw new functions.https.HttpsError("internal", authenticationError);
  }

  const idToken = hasBearer ? header!.split("Bearer ")[1] : sessionCookie;

  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    throw new functions.https.HttpsError("internal", authenticationError);
  }
}
