import * as functions from "firebase-functions";
import { admin } from "../../config/admin";
import { REGION } from "../../config/constants";
import { StoreCountryDeps, handleReportStoreCountry } from "../../handlers/storeCountryHandlers";
import { firestoreStoreCountry } from "../../services/storeCountry";

let deps: StoreCountryDeps | undefined;

/** The live Firestore store, created on first use per instance. */
function storeCountryDeps(): StoreCountryDeps {
  deps ??= { store: firestoreStoreCountry(() => admin.firestore()), now: Date.now };
  return deps;
}

export const reportStoreCountry = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 30 })
  .https.onCall((data, context) => handleReportStoreCountry(data, context, storeCountryDeps()));
