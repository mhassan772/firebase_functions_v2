const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const ipaddr = require("ipaddr.js");

function packCountries(countries, revision, sourceDate) {
  const tables = new Map();
  let conflicts = 0;
  for (const country of countries) {
    if (!/^[A-Z]{2}$/.test(country.countryCode)) throw new Error("Invalid country code");
    for (const [field, family] of [["ipv4", 4], ["ipv6", 6]]) {
      for (const cidr of country.prefixes[field]) {
        const [address, prefix] = ipaddr.parseCIDR(cidr);
        const bytes = Buffer.from(address.toByteArray());
        if (bytes.length !== (family === 4 ? 4 : 16)) throw new Error(`Wrong family: ${cidr}`);
        const whole = Math.floor(prefix / 8), remainder = prefix % 8;
        if (remainder) bytes[whole] &= 0xff << (8 - remainder);
        bytes.fill(0, whole + (remainder ? 1 : 0));
        const id = `${family}/${prefix}`;
        if (!tables.has(id)) tables.set(id, new Map());
        const table = tables.get(id), key = bytes.toString("hex"), previous = table.get(key);
        if (previous && previous !== country.countryCode) {
          if (previous !== "ZZ") conflicts++;
          table.set(key, "ZZ"); // Equally specific conflicting registrations are unknown.
        } else table.set(key, country.countryCode);
      }
    }
  }
  const groups = [], chunks = [];
  let offset = 0;
  for (const [id, table] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    const [family, prefix] = id.split("/").map(Number);
    const entries = [...table].sort(([a], [b]) => a.localeCompare(b));
    const chunk = Buffer.concat(entries.map(([key, country]) => Buffer.concat([Buffer.from(key, "hex"), Buffer.from(country)])));
    groups.push({ family, prefix, offset, count: entries.length });
    chunks.push(chunk); offset += chunk.length;
  }
  const metadata = { version: 1, source: "https://github.com/ipverse/geo-ip-blocks", revision, sourceDate, countries: countries.length, conflicts, groups };
  const header = Buffer.from(JSON.stringify(metadata));
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, ...chunks]);
}

if (require.main === module) {
  const [source, revision, sourceDate] = process.argv.slice(2);
  if (!source || !/^[a-f0-9]{40}$/.test(revision || "") || !Number.isFinite(Date.parse(sourceDate))) {
    throw new Error("Usage: node scripts/build-country-database.cjs <extracted-ipverse-directory> <commit-sha> <commit-date>");
  }
  const countries = readdirSync(resolve(source, "country")).sort().map(code =>
    JSON.parse(readFileSync(resolve(source, "country", code, `${code}.json`), "utf8")));
  const result = packCountries(countries, revision, sourceDate);
  writeFileSync(resolve(__dirname, "../data/country-ip.bin"), result);
  console.log(`Packed ${countries.length} countries into ${result.length} bytes.`);
}
module.exports = { packCountries };
