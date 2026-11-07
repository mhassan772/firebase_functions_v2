import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { REGION } from "../../config/constants";
import { validateRequestAuthentication } from "../../utils/authentication";
import { handleGetUrls } from "../../handlers/downloadHandlers";
import { GetUrlsRequest } from "../../types";
import {
  audioDomainFor,
  DEFAULT_MAX_BOOKS_PER_REQUEST,
  GetUrlsError,
  validateGetUrlsRequest,
} from "../../shared/getUrlsCore";
import { parseUrlPolicy } from "../../shared/urlPolicy";
import { audioDomainForRequest } from "../../utils/audioCountry";
import { getCachedSettings, isAttestedRequest } from "../../services/urlGrantsLedger";

/** Secret Manager names of the HMAC keys the CDNs check; rotate them with `urlPolicy.keyVersion`. */
export const AUDIO_SIGNING_SECRETS = { cloudflare: "AUDIO_SIGN_CF", bunny: "AUDIO_SIGN_BUNNY" };

export const getUrls = functions
  .region(REGION)
  .runWith({ secrets: [AUDIO_SIGNING_SECRETS.cloudflare, AUDIO_SIGNING_SECRETS.bunny] })
  .https.onRequest(async (req: Request, res: Response) => {
    try {
      const auth = await validateRequestAuthentication(req, res);
      const userId = auth.uid;

      const { books, platform, deviceId, build_number, provider } = req.body as GetUrlsRequest;
      const settings = await getCachedSettings();
      const policy = parseUrlPolicy(settings.urlPolicy);

      const validationError = validateGetUrlsRequest(
        books,
        platform,
        policy?.maxBooksPerRequest ?? DEFAULT_MAX_BOOKS_PER_REQUEST,
        provider
      );
      if (validationError) {
        res.status(400).json(validationError);
        return;
      }

      // A provider the app asked for makes the IP lookup unnecessary.
      const publicDomain = provider ? audioDomainFor(provider, undefined) : audioDomainForRequest(req);
      const appCheckHeader = req.header("X-Firebase-AppCheck");
      const response = await handleGetUrls(
        {
          books,
          platform,
          deviceId,
          build_number: build_number ? String(build_number) : undefined,
          provider,
        },
        userId,
        publicDomain,
        {
          settings,
          attested: await isAttestedRequest(appCheckHeader),
          secrets: {
            cloudflare: process.env[AUDIO_SIGNING_SECRETS.cloudflare] ?? "",
            bunny: process.env[AUDIO_SIGNING_SECRETS.bunny] ?? "",
          },
        }
      );
      res.status(200).json(response);
    } catch (error: any) {
      if (error instanceof GetUrlsError) {
        // A coded answer the client expects, such as an allowance refusal, not a failure of ours.
        functions.logger.warn({ event: "getUrls.refused", ...error.body });
      } else {
        functions.logger.error(error);
      }

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
  });
