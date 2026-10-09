import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleMostPopularBooks } from "../../handlers/popularBooksHandlers";

/**
 * Adds new listeners to each book's `listeners_count` and rebuilds
 * `popular_books_v2/popular_books` from listening in the window. See docs/book-chart.md.
 */
export const mostPopularBooksV3 = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("every day 00:05")
  .timeZone("Europe/Berlin")
  .onRun(() => handleMostPopularBooks());
