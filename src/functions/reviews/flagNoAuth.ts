import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { handleFlag, isUserBanned } from "../../handlers/reviewHandlers";

export const flagNoAuth = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    try {
      // Step 1: Extract required fields from body
      const { comment_guid, user_guid, method } = req.body;

      // Step 2: Check for missing fields
      if (!comment_guid || !user_guid || !method) {
        res.status(400).json({ code: 400, message: "Missing required fields" });
        return;
      }

      // Step 3: Validate method
      if (method !== "flag" && method !== "unflag") {
        res.status(400).json({ 
          code: 400, 
          message: "Invalid method. Must be 'flag' or 'unflag'." 
        });
        return;
      }

      // Step 4: Check if user is banned
      const user_banned = await isUserBanned(user_guid);
      if (user_banned) {
        res.status(400).json({ 
          code: 507, 
          message: "The user is banned", 
          refresh_token: false 
        });
        return;
      }

      // Step 5: Handle the flag/unflag logic
      const response = await handleFlag(comment_guid, user_guid, method);
      res.status(200).json(response);
    } catch (error: any) {
      functions.logger.error(error);
      res.status(error.code || 500).json({
        code: error.code || 500,
        message: error.message || "Unexpected error",
      });
    }
  }
);

