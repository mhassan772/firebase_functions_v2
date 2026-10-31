import * as ipaddr from "ipaddr.js";

interface PrefixGroup {
  family: 4 | 6;
  prefix: number;
  offset: number;
  count: number;
}

/** Packed, sorted prefix tables: keep the full dataset in a Buffer, not JS objects. */
export class CountryDatabase {
  readonly metadata: { version: number; revision: string; sourceDate: string; countries: number; groups: PrefixGroup[] };
  private readonly records: Buffer;

  constructor(data: Buffer) {
    const headerSize = data.readUInt32BE(0);
    if (headerSize > 65536 || headerSize + 4 > data.length) throw new Error("Invalid country database header");
    this.metadata = JSON.parse(data.subarray(4, 4 + headerSize).toString("utf8"));
    if (this.metadata.version !== 1 || !Array.isArray(this.metadata.groups)) throw new Error("Invalid country database version");
    this.records = data.subarray(4 + headerSize);
    let end = 0;
    for (const group of this.metadata.groups) {
      const width = group.family === 4 ? 4 : 16;
      if (![4, 6].includes(group.family) || !Number.isInteger(group.prefix) || group.prefix < 0 || group.prefix > width * 8 ||
          !Number.isInteger(group.count) || group.count < 1 || group.offset !== end) throw new Error("Invalid country prefix table");
      end += group.count * (width + 2);
    }
    if (end !== this.records.length) throw new Error("Truncated country database");
    // More-specific network assignments take precedence over broader ones.
    this.metadata.groups.sort((a, b) => b.prefix - a.prefix);
  }

  get(ip: string): string | undefined {
    const address = ipaddr.process(ip);
    if (address.range() !== "unicast") return undefined;
    const family = address.kind() === "ipv4" ? 4 : 6;
    const bytes = Buffer.from(address.toByteArray());
    for (const group of this.metadata.groups) {
      if (group.family !== family) continue;
      const key = Buffer.from(bytes);
      const whole = Math.floor(group.prefix / 8);
      const remainder = group.prefix % 8;
      if (remainder) key[whole] &= (0xff << (8 - remainder));
      key.fill(0, whole + (remainder ? 1 : 0));
      const stride = key.length + 2;
      let low = 0;
      let high = group.count - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const offset = group.offset + middle * stride;
        const order = key.compare(this.records.subarray(offset, offset + key.length));
        if (order === 0) {
          const country = this.records.toString("ascii", offset + key.length, offset + stride);
          return country === "ZZ" ? undefined : country;
        }
        if (order < 0) high = middle - 1;
        else low = middle + 1;
      }
    }
    return undefined;
  }
}
