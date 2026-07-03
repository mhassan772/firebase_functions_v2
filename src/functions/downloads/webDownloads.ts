import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { validateRequestAuthentication } from "../../utils/authentication";
import { setWebCorsHeaders, handleOptionsRequest } from "../../utils/cors";
import { handleGetUrls } from "../../handlers/downloadHandlers";
import { GetUrlsRequest } from "../../types";

export const webDownloads = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    setWebCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      handleOptionsRequest(res);
      return;
    }

    try {
      if (req.method !== "POST") {
        res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
        return;
      }

      const auth = await validateRequestAuthentication(req, res);
      const userId = auth.uid;

      const { books, platform, deviceId } = req.body as GetUrlsRequest;

      if (!books || !Array.isArray(books) || books.length === 0) {
        res.status(400).json({
          code: 400,
          message: "Missing or invalid 'books' field. Expected non-empty array.",
        });
        return;
      }

      if (!platform) {
        res.status(400).json({
          code: 400,
          message: "Missing required field: platform",
        });
        return;
      }

      const validReasons = ["download", "stream", "sample"];
      for (const book of books) {
        if (!book.bookGuid) {
          res.status(400).json({
            code: 400,
            message: "Each book must have a 'bookGuid' field",
          });
          return;
        }
        if (!book.quality) {
          res.status(400).json({
            code: 400,
            message: "Each book must have a 'quality' field",
          });
          return;
        }
        if (!book.reason || !validReasons.includes(book.reason)) {
          res.status(400).json({
            code: 400,
            message: "Each book must have a 'reason' field with value: download, stream, or sample",
          });
          return;
        }
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
