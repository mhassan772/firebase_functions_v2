import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { validateRequestAuthentication } from "../../utils/authentication";
import { handleGetUrls } from "../../handlers/downloadHandlers";
import { GetUrlsRequest } from "../../types";
import { validateGetUrlsRequest } from "../../shared/getUrlsCore";

export const getUrls = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    try {
      const auth = await validateRequestAuthentication(req, res);
      const userId = auth.uid;

      const { books, platform, deviceId } = req.body as GetUrlsRequest;

      const validationError = validateGetUrlsRequest(books, platform);
      if (validationError) {
        res.status(400).json(validationError);
        return;
      }

      const response = await handleGetUrls({ books, platform, deviceId }, userId);
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
