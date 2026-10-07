import { Env } from "../env";
import { getGoogleAccessToken } from "./accessToken";

export interface AuthAccount {
  emailVerified: boolean;
  disabled: boolean;
  /** Seconds since the epoch; tokens issued before it were revoked. */
  validSince: number | null;
}

/** Looks up a Firebase Auth account by uid, the REST equivalent of `admin.auth().getUser`. */
export async function lookupAccount(uid: string, env: Env): Promise<AuthAccount | null> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await getGoogleAccessToken(env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ localId: [uid] }),
    }
  );
  if (!response.ok) {
    throw new Error(`Identity Toolkit lookup failed with HTTP ${response.status}`);
  }

  const { users } = (await response.json()) as {
    users?: { emailVerified?: boolean; disabled?: boolean; validSince?: string }[];
  };
  const user = users?.[0];
  if (!user) return null;

  return {
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    validSince: user.validSince ? Number(user.validSince) : null,
  };
}
