import { Env } from "../env";
import { beginTransaction, commit, FirestoreError, FirestoreWrite } from "./firestore";

/**
 * Runs [body] inside a Firestore transaction and commits the writes it returns.
 *
 * Reads made with the transaction id are locked until the commit; a commit that another
 * transaction invalidated fails with ABORTED, and the body is run once more from a fresh
 * transaction, as the Admin SDK does.
 */
export async function runTransaction<T>(
  env: Env,
  body: (transaction: string) => Promise<{ writes: FirestoreWrite[]; result: T }>
): Promise<T> {
  let attempt = 0;
  for (;;) {
    const transaction = await beginTransaction(env);
    const { writes, result } = await body(transaction);
    try {
      await commit(env, writes, transaction);
      return result;
    } catch (error) {
      if (error instanceof FirestoreError && error.grpcStatus === "ABORTED" && attempt === 0) {
        attempt++;
        continue;
      }
      throw error;
    }
  }
}
