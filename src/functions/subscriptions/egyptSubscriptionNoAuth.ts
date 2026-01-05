import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { setCorsHeaders, handleOptionsRequest } from "../../utils/cors";
import { handleSubscriptionNoAuth } from "../../handlers/subscriptionHandlers";

export const egyptSubscriptionNoAuth = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      handleOptionsRequest(res);
      return;
    }

    try {
      if (req.method !== 'POST') {
        res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
        return;
      }

      const response = await handleSubscriptionNoAuth(req);
      res.status(200).json(response);
    } catch (error: any) {
      functions.logger.error(error);
      res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
    }
  }
);

