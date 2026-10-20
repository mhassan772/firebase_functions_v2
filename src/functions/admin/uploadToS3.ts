import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { validateRequestAuthentication } from "../../utils/authentication";
import { setCorsHeaders, handleOptionsRequest } from "../../utils/cors";
import { handleS3Upload } from "../../handlers/s3Handlers";
import { requirePortalRole } from "../../utils/adminRole";

export const admin_upload_to_S3 = functions.region(REGION).https.onRequest(
  async (req: Request, res: Response) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      handleOptionsRequest(res);
      return;
    }

    try {
      const auth = await validateRequestAuthentication(req, res);
      const user_guid = auth.uid;

      if (req.method !== 'POST') {
        res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
        return;
      }

      try {
        await requirePortalRole(user_guid, "content-manager");
      } catch {
        res.status(403).json({
          code: 403,
          message: "Unauthorized: User is not an admin"
        });
        return;
      }

      const response = await handleS3Upload(req);
      res.status(200).json(response);
    } catch (error: any) {
      functions.logger.error(error);
      if (!res.headersSent) {
        res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
      }
    }
  }
);

