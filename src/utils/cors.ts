import { Response } from "express";

export function setCorsHeaders(res: Response): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function handleOptionsRequest(res: Response): boolean {
  res.status(204).send('');
  return true;
}

