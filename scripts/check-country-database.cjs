const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { CountryDatabase } = require("../lib/utils/countryDatabase");

const path = resolve(__dirname, "../data/country-ip.bin");
try {
  const reader = new CountryDatabase(readFileSync(path));
  const { countries, revision, sourceDate, groups } = reader.metadata;
  if (countries < 200 || !/^[a-f0-9]{40}$/.test(revision) || !Number.isFinite(Date.parse(sourceDate)) ||
      !groups.some(g => g.family === 4) || !groups.some(g => g.family === 6)) {
    throw new Error("Expected the full IPverse country database with IPv4 and IPv6 support.");
  }
  for (const [ip, expected] of [
    ["197.32.0.1", "EG"], ["2c0f:fc88::1", "EG"],
    ["41.96.0.1", "DZ"], ["2001:4340::1", "DZ"],
    ["77.42.128.1", "LB"], ["2001:67c:1150::1", "LB"],
    ["8.8.8.8", "US"], ["2001:4860:4860::8888", "US"],
  ]) {
    const country = reader.get(ip);
    if (country !== expected) throw new Error(`Country check failed for ${ip}: expected ${expected}, got ${country}. Review database before deployment.`);
  }
  console.log(`Country database checked: ${countries} countries, IPverse revision ${revision}, dated ${sourceDate}`);
  if (Date.now() - Date.parse(sourceDate) > 14 * 86400000) {
    console.warn("Country database is more than 14 days old. Refresh from IPverse before deploying.");
  }
} catch (error) {
  console.error(`Country database check failed: ${error.message}\nRebuild ${path} from IPverse. See data/README.md.`);
  process.exitCode = 1;
}
