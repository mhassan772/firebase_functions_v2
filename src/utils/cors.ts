import { Request, Response } from "express";
import { WEB_CORS_ALLOWED_ORIGINS } from "../config/constants";

export function setCorsHeaders(res: Response): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function setWebCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (origin && WEB_CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set(
    "Access-Control-Allow-Headers",
    "authorization, content-type, version, platform, followRedirects"
  );
}

export function handleOptionsRequest(res: Response): boolean {
  res.status(204).send('');
  return true;
}

