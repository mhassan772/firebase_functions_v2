import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { validateRequestAuthentication } from "../../utils/authentication";
import { handleComment, isUserBanned } from "../../handlers/reviewHandlers";

export const review = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    try {
      const auth = await validateRequestAuthentication(req, res);
      const user_guid = auth.uid;

      const { method, comment, book_rate, narrator_rate, book_guid } = req.body;

      // Validate required fields (comment can be empty string)
      if (!method || !book_guid || comment === undefined || comment === null || !user_guid) {
        res.status(400).json({ code: 400, message: "Missing required fields" });
        return;
      }

      // Validate `method`
      const validMethods = ["update", "put", "delete"];
      if (!validMethods.includes(method.toLowerCase())) {
        res.status(400).json({ code: 400, message: "Invalid method. Allowed values: update, put, delete" });
        return;
      }

      // Validate `narrator_rate` (0-5)
      if (narrator_rate < 0 || narrator_rate > 5) {
        res.status(400).json({ code: 400, message: "narrator_rate must be between 0 and 5" });
        return;
      }

      // Validate `book_rate` (0-5)
      if (book_rate < 0 || book_rate > 5) {
        res.status(400).json({ code: 400, message: "book_rate must be between 0 and 5" });
        return;
      }

      // Validate `comment` (max 2000 characters, can be empty string)
      if (typeof comment !== 'string' || comment.length > 2000) {
        res.status(400).json({ code: 400, message: "comment must be a string with a maximum of 2000 characters" });
        return;
      }

      // Check if user is banned
      const user_banned = await isUserBanned(user_guid);
      if (user_banned) {
        res.status(400).json({ 
          code: 507, 
          message: "The user is banned", 
          refresh_token: false 
        });
        return;
      }

      const response = await handleComment({ method, comment, book_rate, narrator_rate, book_guid, user_guid });
      res.status(200).json(response);
    } catch (error: any) {
      functions.logger.error(error);
      if (!res.headersSent) {
        res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
      }
    }
  }
);

