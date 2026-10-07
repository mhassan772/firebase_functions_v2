import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { handleGetUrls, getSettings } from "../../handlers/downloadHandlers";
import { GetUrlsRequest } from "../../types";
import { validateGetUrlsRequest } from "../../shared/getUrlsCore";

interface GetUrlsNoAuthRequest extends GetUrlsRequest {
  uid: string;
}

export const getUrlsNoAuth = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    try {
      const settings = await getSettings();

      if (!settings.isNoAuthAllowed) {
        res.status(403).json({
          code: 603,
          message: "unauthorized",
        });
        return;
      }

      const { books, platform, deviceId, uid } = req.body as GetUrlsNoAuthRequest;

      if (!uid) {
        res.status(400).json({
          code: 400,
          message: "Missing required field: uid",
        });
        return;
      }

      const validationError = validateGetUrlsRequest(books, platform);
      if (validationError) {
        res.status(400).json(validationError);
        return;
      }

      const response = await handleGetUrls({ books, platform, deviceId }, uid);
      res.status(200).json(response);
    } catch (error: any) {
      functions.logger.error(error);

      try {
        const parsedError = JSON.parse(error.message);
        res.status(400).json(parsedError);
      } catch {
        if (!res.headersSent) {
          res.status(500).json({
            code: 500,
            message: error.message || "Unexpected error",
          });
        }
      }
    }
  }
);
