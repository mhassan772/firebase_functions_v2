import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { validateRequestAuthentication } from "../../utils/authentication";
import { setCorsHeaders, handleOptionsRequest } from "../../utils/cors";
import { handleReportIssue } from "../../handlers/reportIssueHandler";

export const reportIssue = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      handleOptionsRequest(res);
      return;
    }

    try {
      const auth = await validateRequestAuthentication(req, res);
      const user_guid = auth.uid;

      if (req.method !== "POST") {
        res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
        return;
      }

      const response = await handleReportIssue(req, user_guid);
      res.status(200).json(response);
    } catch (error: any) {
      functions.logger.error(error);
      if (!res.headersSent) {
        const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
        res.status(statusCode).json({ code: statusCode, message: error.message || "Unexpected error" });
      }
    }
  }
);
