import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import * as ipaddr from "ipaddr.js";
import { CountryDatabase } from "./countryDatabase";
import { audioDomainForCountry } from "../shared/getUrlsCore";

export const COUNTRY_DATABASE_PATH = resolve(__dirname, "../../data/country-ip.bin");

interface CountryLookup { get(ip: string): string | undefined; }
interface ClientRequest {
  headers: { [name: string]: string | string[] | undefined };
  socket: { remoteAddress?: string };
}

/** Country routing is a delivery preference, never an authentication decision. */
export function clientPublicIp(request: ClientRequest): string | undefined {
  // Google's Functions ingress supplies X-Forwarded-For, client first:
  // https://cloud.google.com/functions/docs/reference/headers
  // Do not scan onward to a proxy's address when the client is invalid/private.
  const forwarded = request.headers["x-forwarded-for"];
  const firstHeader = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = (firstHeader !== undefined ? firstHeader.split(",")[0] : request.socket.remoteAddress)?.trim();
  if (!candidate || !isIP(candidate) || candidate.includes("%")) return undefined;
  const address = ipaddr.process(candidate);
  return address.range() === "unicast" ? address.toString() : undefined;
}

/** Load lazily once per warm instance; failures also log only once per instance. */
export function createAudioDomainResolver(
  load: () => CountryLookup,
  report: (error: unknown) => void = (error) => console.error("Audio country database unavailable", error),
): (request: ClientRequest) => string {
  let reader: CountryLookup | null | undefined;
  let reported = false;
  return (request) => {
    const ip = clientPublicIp(request);
    if (!ip) return audioDomainForCountry(undefined);
    try {
      if (reader === undefined) {
        reader = null;
        reader = load();
      }
      return audioDomainForCountry(reader?.get(ip));
    } catch (error) {
      if (!reported) {
        reported = true;
        report(error);
      }
      return audioDomainForCountry(undefined);
    }
  };
}

export const audioDomainForRequest = createAudioDomainResolver(
  () => new CountryDatabase(readFileSync(COUNTRY_DATABASE_PATH)),
);
