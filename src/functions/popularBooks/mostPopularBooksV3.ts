import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleMostPopularBooks } from "../../handlers/popularBooksHandlers";

/**
 * Rebuilds `popular_books_v2/popular_books` daily and prunes old download audit records.
 */
export const mostPopularBooksV3 = functions
  .region(REGION)
  .pubsub.schedule("every day 00:05")
  .timeZone("Europe/Berlin")
  .onRun(() => handleMostPopularBooks());
