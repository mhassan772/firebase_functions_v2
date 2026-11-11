/// The Firebase app and Auth instance for pages that sign people in, and what the sign-in left.

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserPopupRedirectResolver,
  browserSessionPersistence,
  connectAuthEmulator,
  initializeAuth,
  type Auth,
  type User,
} from "firebase/auth";

import { emulatorSettings, firebaseOptions } from "../firebaseConfig";

export type Provider = "password" | "google" | "apple";

export interface Session {
  app: FirebaseApp;
  auth: Auth;
}

/// What a later step needs from the sign-in, and nothing else.
export interface SignedIn {
  user: User;
  /// Null for a method this page can't confirm again, such as a phone number.
  provider: Provider | null;
  /// Apple's access token, kept in memory only so the deletion can revoke it.
  appleAccessToken?: string;
}

/// The page's own host on accounts.mantooq.com, so the provider window names it and Firebase's
/// `/__/auth/` helper pages are same-origin; elsewhere the configured domain stays.
export const SIGN_IN_HOSTNAME = "accounts.mantooq.com";

export function authDomainFor(location: { hostname: string; host: string }, configured: string | undefined) {
  return location.hostname === SIGN_IN_HOSTNAME ? location.host : configured;
}

/// Maps the ID token's `firebase.sign_in_provider` to the methods this page offers.
export function providerFrom(signInProvider: string | null | undefined): Provider | null {
  switch (signInProvider) {
    case "password":
      return "password";
    case "google.com":
      return "google";
    case "apple.com":
      return "apple";
    default:
      return null;
  }
}

let session: Promise<Session> | null = null;

/// One app per page load. Session persistence: closing the tab signs out.
export function getSession(): Promise<Session> {
  session ??= createSession().catch((error) => {
    session = null;
    throw error;
  });
  return session;
}

async function createSession(): Promise<Session> {
  const options = await firebaseOptions();
  const app = initializeApp({ ...options, authDomain: authDomainFor(location, options.authDomain) });
  const auth = initializeAuth(app, {
    persistence: browserSessionPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  if (import.meta.env.DEV) {
    const emulators = emulatorSettings();
    if (emulators) connectAuthEmulator(auth, emulators.auth, { disableWarnings: true });
  }
  await auth.authStateReady();
  return { app, auth };
}

/// A guest (anonymous) session never counts as signed in.
export function signedInUser(auth: Auth): User | null {
  const user = auth.currentUser;
  return user && !user.isAnonymous ? user : null;
}

/// Rebuilds what a restored session can tell: the method from the ID token, no Apple token.
export async function restoredSignIn(user: User): Promise<SignedIn> {
  const token = await user.getIdTokenResult();
  return { user, provider: providerFrom(token.signInProvider) };
}
