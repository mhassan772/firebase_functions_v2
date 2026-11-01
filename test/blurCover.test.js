const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const sharp = require("sharp");
const {
  BLURRED_COVERS_BUCKET,
  BLURRED_COVER_CACHE_CONTROL,
  blurredCoverKey,
  createBlurCoverHandler,
  fetchImageWithLimits,
  parseBlurCoverRequest,
} = require("../lib/handlers/blurCoverHandler");

const ADMIN = { auth: { uid: "admin-uid" } };

test("loading the functions does not load sharp until a cover is blurred", () => {
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const loaded = execFileSync(
    process.execPath,
    [
      "-e",
      'require("./lib/index"); process.stdout.write(String(Object.keys(require.cache).some((file) => file.includes("/node_modules/sharp/"))));',
    ],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" }
  );
  assert.equal(loaded, "false");
});
const IMAGE_URL = "https://img.example.com/cover.png";

// A sharp-edged pattern, so the test can tell a blurred output from a merely resized one.
async function checkerboard(width, height, cell = 20) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255;
      pixels.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function harness(overrides = {}) {
  const calls = { admin: [], fetch: [], put: [] };
  const deps = {
    requireAdmin: async (uid) => {
      calls.admin.push(uid);
    },
    fetchImage: async (url) => {
      calls.fetch.push(url);
      return checkerboard(1200, 800);
    },
    putObject: async (object) => {
      calls.put.push(object);
    },
    ...overrides,
  };
  return { handler: createBlurCoverHandler(deps), calls };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("blur cover rejects unauthenticated callers and non-admins before any work", async () => {
  const { handler, calls } = harness({
    requireAdmin: async () => {
      throw new Error("not an admin");
    },
  });
  const request = { kind: "podcast", id: "123", imageUrl: IMAGE_URL };

  await rejectsWith(handler(request, {}), "unauthenticated");
  await rejectsWith(handler(request, ADMIN), "permission-denied");
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.put.length, 0);
});

test("blur cover rejects a bad kind, id or url", async () => {
  const { handler, calls } = harness();
  const bad = [
    null,
    [],
    { kind: "author", id: "1", imageUrl: IMAGE_URL },
    { id: "1", imageUrl: IMAGE_URL },
    { kind: "podcast", id: "", imageUrl: IMAGE_URL },
    { kind: "podcast", id: 123, imageUrl: IMAGE_URL },
    { kind: "episode", id: "12a", imageUrl: IMAGE_URL },
    { kind: "book", id: "../other", imageUrl: IMAGE_URL },
    { kind: "book", id: "a/b", imageUrl: IMAGE_URL },
    { kind: "podcast", id: "1", imageUrl: "" },
    { kind: "podcast", id: "1", imageUrl: "   " },
    { kind: "podcast", id: "1" },
    { kind: "podcast", id: "1", imageUrl: "not a url" },
    { kind: "podcast", id: "1", imageUrl: "ftp://example.com/a.jpg" },
    { kind: "podcast", id: "1", imageUrl: "file:///etc/passwd" },
    { kind: "podcast", id: "1", imageUrl: "data:image/png;base64,AAAA" },
  ];
  for (const data of bad) {
    await rejectsWith(handler(data, ADMIN), "invalid-argument");
  }
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.put.length, 0);
});

test("blur cover accepts each kind with its own id format", () => {
  assert.deepEqual(parseBlurCoverRequest({ kind: "podcast", id: "920666", imageUrl: IMAGE_URL }), {
    kind: "podcast",
    id: "920666",
    imageUrl: IMAGE_URL,
    effect: "blur",
    strength: 5,
    regions: [],
    preview: false,
  });
  assert.equal(parseBlurCoverRequest({ kind: "episode", id: "41928399210", imageUrl: "http://a.b/c" }).kind, "episode");
  const guid = "6f1c2a0e-1b2d-4c3e-9f00-0a1b2c3d4e5f";
  assert.equal(parseBlurCoverRequest({ kind: "book", id: guid, imageUrl: IMAGE_URL }).id, guid);
});

test("blur cover key is versioned by the sha1 of the source picture, so a cover replaced in place gets a new key", () => {
  const picture = Buffer.from("picture-1");
  const version = crypto.createHash("sha1").update(picture).digest("hex").slice(0, 12);
  assert.equal(blurredCoverKey("episode", "77", picture), `images/blurred/episode/77/${version}.jpg`);
  assert.equal(blurredCoverKey("episode", "77", Buffer.from("picture-1")), blurredCoverKey("episode", "77", picture));
  assert.notEqual(blurredCoverKey("episode", "77", picture), blurredCoverKey("episode", "77", Buffer.from("picture-2")));
});

test("blur cover uploads a resized, blurred JPEG and returns its public url", async () => {
  const { handler, calls } = harness();
  const result = await handler({ kind: "book", id: "abc-123", imageUrl: IMAGE_URL }, ADMIN);

  const source = await checkerboard(1200, 800);
  const key = blurredCoverKey("book", "abc-123", source);
  const sourceHash = crypto.createHash("sha1").update(source).digest("hex").slice(0, 12);
  assert.deepEqual(result, { url: `https://images.mantooq.com/${key}`, sourceHash, strength: 5 });
  assert.deepEqual(calls.admin, ["admin-uid"]);
  assert.deepEqual(calls.fetch, [IMAGE_URL]);
  assert.equal(calls.put.length, 1);

  const object = calls.put[0];
  assert.equal(object.Bucket, BLURRED_COVERS_BUCKET);
  assert.equal(object.Bucket, "mantook-book-images-pdf");
  assert.equal(object.Key, key);
  assert.equal(object.ContentType, "image/jpeg");
  assert.equal(object.CacheControl, "public, max-age=31536000, immutable");
  assert.equal(object.CacheControl, BLURRED_COVER_CACHE_CONTROL);

  const metadata = await sharp(object.Body).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 600);
  assert.equal(metadata.height, 400);

  // The checkerboard is pure black and white; a sigma-30 blur leaves it close to uniform grey.
  const stats = await sharp(object.Body).stats();
  for (const channel of stats.channels) {
    assert.ok(channel.stdev < 20, `expected a blurred image, stdev was ${channel.stdev}`);
  }
});

test("blur cover rejects a bad effect, strength, area list or preview flag", async () => {
  const { handler, calls } = harness();
  const base = { kind: "podcast", id: "1", imageUrl: IMAGE_URL };
  const area = { shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const bad = [
    { ...base, effect: "sepia" },
    { ...base, strength: 0 },
    { ...base, strength: 11 },
    { ...base, strength: 2.5 },
    { ...base, strength: "5" },
    { ...base, preview: "yes" },
    { ...base, regions: "all" },
    { ...base, regions: [null] },
    { ...base, regions: [{ ...area, shape: "star" }] },
    { ...base, regions: [{ ...area, x: "0.1" }] },
    { ...base, regions: [{ ...area, w: Number.NaN }] },
    { ...base, regions: [{ ...area, rotation: "10" }] },
    { ...base, regions: [{ ...area, rotation: Number.POSITIVE_INFINITY }] },
    { ...base, regions: [{ ...area, rotation: 400 }] },
    // A tilted area may reach past the edges, but not have its centre outside or be huge.
    { ...base, regions: [{ ...area, x: 0.95, w: 0.2, rotation: 30 }] },
    { ...base, regions: [{ ...area, y: -0.3, h: 0.2, rotation: 30 }] },
    { ...base, regions: [{ ...area, x: -1, w: 2.5, rotation: 30 }] },
    { ...base, regions: [{ ...area, x: -0.01 }] },
    { ...base, regions: [{ ...area, w: 0 }] },
    { ...base, regions: [{ ...area, x: 0.9, w: 0.2 }] },
    { ...base, regions: [{ ...area, y: 0.95, h: 0.1 }] },
    { ...base, regions: Array.from({ length: 21 }, () => area) },
  ];
  for (const data of bad) {
    await rejectsWith(handler(data, ADMIN), "invalid-argument");
  }
  assert.equal(calls.fetch.length, 0);
});

test("blur cover areas are rounded and clamped to the picture's edge", () => {
  const request = parseBlurCoverRequest({
    kind: "podcast",
    id: "1",
    imageUrl: IMAGE_URL,
    effect: "pixelate",
    regions: [{ shape: "ellipse", x: 0.123456, y: 0.5, w: 0.876544 + 1e-7, h: 0.25 }],
    preview: true,
  });
  assert.equal(request.effect, "pixelate");
  assert.equal(request.preview, true);
  assert.deepEqual(request.regions, [{ shape: "ellipse", x: 0.1235, y: 0.5, w: 0.8765, h: 0.25, rotation: 0 }]);
});

test("blur cover lets a tilted area reach past the edges, with its centre inside", () => {
  const request = parseBlurCoverRequest({
    kind: "podcast",
    id: "1",
    imageUrl: IMAGE_URL,
    regions: [
      { shape: "rect", x: 0.6, y: -0.1, w: 0.6, h: 0.5, rotation: -44 },
      { shape: "rect", x: -0.2, y: -0.2, w: 1.4, h: 1.4, rotation: 45 },
      // Turned half a turn, it is upright, so it must lie inside the picture again.
      { shape: "rect", x: 0.6, y: 0.1, w: 0.4, h: 0.5, rotation: 180 },
    ],
  });
  assert.deepEqual(request.regions, [
    { shape: "rect", x: 0.6, y: -0.1, w: 0.6, h: 0.5, rotation: -44 },
    { shape: "rect", x: -0.2, y: -0.2, w: 1.4, h: 1.4, rotation: 45 },
    { shape: "rect", x: 0.6, y: 0.1, w: 0.4, h: 0.5, rotation: 0 },
  ]);
  assert.throws(
    () => parseBlurCoverRequest({ kind: "podcast", id: "1", imageUrl: IMAGE_URL, regions: [{ shape: "rect", x: 0.7, y: 0, w: 0.4, h: 0.5, rotation: 180 }] }),
    /end inside the picture/
  );
});

test("blur cover tilts fold into -89 to 90 whole degrees, since a shape turned half a turn looks the same", () => {
  const tilts = [[0, 0], [12.6, 13], [-45, -45], [90, 90], [-90, 90], [100, -80], [180, 0], [-135, 45], [359, -1]];
  const request = parseBlurCoverRequest({
    kind: "podcast",
    id: "1",
    imageUrl: IMAGE_URL,
    strength: 8,
    regions: tilts.map(([rotation]) => ({ shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, rotation })),
  });
  assert.equal(request.strength, 8);
  assert.deepEqual(request.regions.map((region) => region.rotation), tilts.map(([, folded]) => folded));
});

test("blur cover keys change with the effect, strength and areas, and the whole-picture blur keeps its key", () => {
  const picture = Buffer.from("picture-1");
  const whole = blurredCoverKey("book", "b", picture);
  const area = { shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, rotation: 0 };
  const key = (options, source = picture) => blurredCoverKey("book", "b", source, { effect: "blur", strength: 5, regions: [], ...options });
  assert.equal(key({}), whole);
  assert.equal(whole, `images/blurred/book/b/${crypto.createHash("sha1").update(picture).digest("hex").slice(0, 12)}.jpg`);

  const keys = [
    whole,
    key({ effect: "pixelate" }),
    key({ strength: 8 }),
    key({ regions: [area] }),
    key({ regions: [area], strength: 8 }),
    key({ effect: "pixelate", regions: [area] }),
    key({ regions: [{ ...area, shape: "ellipse" }] }),
    key({ regions: [{ ...area, x: 0.2 }] }),
    key({ regions: [{ ...area, rotation: 15 }] }),
    key({ regions: [area] }, Buffer.from("picture-2")),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(key({ regions: [area] }), key({ regions: [{ ...area }] }));
  // An upright area at the default strength keeps the key it had before tilt and strength existed.
  const before = JSON.stringify({ effect: "blur", regions: [["rect", 0.1, 0.1, 0.2, 0.2]] });
  const beforeVersion = crypto.createHash("sha1").update(picture).update("\n").update(before).digest("hex").slice(0, 12);
  assert.equal(key({ regions: [area] }), `images/blurred/book/b/${beforeVersion}.jpg`);
  assert.match(blurredCoverKey("book", "b", picture, { effect: "blur", strength: 5, regions: [area] }, "png"), /^images\/blurred\/book\/b\/[0-9a-f]{12}\.png$/);
});

// The standard deviation of the pixels in a box, given in fractions of the picture.
async function boxStdev(image, box) {
  const { width, height } = await sharp(image).metadata();
  const region = {
    left: Math.round(box.x * width),
    top: Math.round(box.y * height),
    width: Math.round(box.w * width),
    height: Math.round(box.h * height),
  };
  // stats() reads the input, not the pipeline, so the crop is made first.
  const stats = await sharp(await sharp(image).extract(region).toBuffer()).stats();
  return Math.max(...stats.channels.slice(0, 3).map((channel) => channel.stdev));
}

test("blur cover hides only the chosen areas and keeps the rest sharp at the larger size", async () => {
  const { handler, calls } = harness({ fetchImage: async () => checkerboard(1600, 1000) });
  const regions = [
    { shape: "rect", x: 0.05, y: 0.1, w: 0.3, h: 0.4 },
    { shape: "ellipse", x: 0.6, y: 0.5, w: 0.3, h: 0.4 },
  ];
  const result = await handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL, regions }, ADMIN);

  const object = calls.put[0];
  assert.equal(object.ContentType, "image/jpeg");
  assert.match(object.Key, /^images\/blurred\/podcast\/5\/[0-9a-f]{12}\.jpg$/);
  assert.notEqual(object.Key, blurredCoverKey("podcast", "5", await checkerboard(1600, 1000)));
  assert.equal(result.url, `https://images.mantooq.com/${object.Key}`);
  const metadata = await sharp(object.Body).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 750);

  // Inside each area the black and white squares are gone; away from them the checkerboard is intact.
  assert.ok((await boxStdev(object.Body, { x: 0.1, y: 0.15, w: 0.2, h: 0.3 })) < 25);
  assert.ok((await boxStdev(object.Body, { x: 0.68, y: 0.6, w: 0.14, h: 0.2 })) < 25);
  assert.ok((await boxStdev(object.Body, { x: 0.45, y: 0.05, w: 0.1, h: 0.3 })) > 100);
});

test("blur cover hides more at a higher strength", async () => {
  const picture = await checkerboard(1200, 750, 60);
  const area = { shape: "rect", x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const inside = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  for (const effect of ["blur", "pixelate"]) {
    const stdevs = [];
    for (const strength of [1, 5, 10]) {
      const { handler, calls } = harness({ fetchImage: async () => picture });
      await handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL, effect, strength, regions: [area] }, ADMIN);
      stdevs.push(await boxStdev(calls.put[0].Body, inside));
    }
    assert.ok(stdevs[0] > stdevs[1] && stdevs[1] > stdevs[2], `${effect} stdevs should fall with strength: ${stdevs}`);
  }
});

test("blur cover tilts an area about its centre", async () => {
  // A tall thin bar, turned a quarter turn, lies across the middle of the picture instead.
  const bar = { shape: "rect", x: 0.45, y: 0.1, w: 0.1, h: 0.8 };
  const leftOfCentre = { x: 0.3, y: 0.47, w: 0.05, h: 0.06 };
  const middle = { x: 0.48, y: 0.3, w: 0.04, h: 0.1 };
  const stdevs = async (rotation) => {
    const { handler, calls } = harness({ fetchImage: async () => checkerboard(1600, 1000) });
    await handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL, effect: "pixelate", regions: [{ ...bar, rotation }] }, ADMIN);
    const body = calls.put[0].Body;
    return { left: await boxStdev(body, leftOfCentre), middle: await boxStdev(body, middle) };
  };
  const upright = await stdevs(0);
  assert.ok(upright.left > 100 && upright.middle < 25, JSON.stringify(upright));
  const turned = await stdevs(90);
  assert.ok(turned.left < 25 && turned.middle > 100, JSON.stringify(turned));
});

test("blur cover pixelates in square blocks, over the whole picture or in an area", async () => {
  // Stripes one pixel wide average to grey in every block.
  const width = 480;
  const height = 480;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.fill(i % 2 === 0 ? 0 : 255, i * 3, i * 3 + 3);
  const stripes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();

  const whole = harness({ fetchImage: async () => stripes });
  await whole.handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL, effect: "pixelate" }, ADMIN);
  const wholeBody = whole.calls.put[0].Body;
  assert.equal((await sharp(wholeBody).metadata()).width, 480);
  assert.ok((await boxStdev(wholeBody, { x: 0, y: 0, w: 1, h: 1 })) < 25);

  const area = harness({ fetchImage: async () => stripes });
  await area.handler(
    { kind: "podcast", id: "5", imageUrl: IMAGE_URL, effect: "pixelate", regions: [{ shape: "rect", x: 0, y: 0, w: 0.5, h: 1 }] },
    ADMIN
  );
  const areaBody = area.calls.put[0].Body;
  assert.ok((await boxStdev(areaBody, { x: 0.05, y: 0.05, w: 0.4, h: 0.9 })) < 25);
  assert.ok((await boxStdev(areaBody, { x: 0.6, y: 0.05, w: 0.35, h: 0.9 })) > 60);
});

test("blur cover keeps a transparent picture as PNG when it hides areas", async () => {
  const transparent = await sharp({
    create: { width: 300, height: 200, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const { handler, calls } = harness({ fetchImage: async () => transparent });
  await handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL, regions: [{ shape: "rect", x: 0.1, y: 0.1, w: 0.5, h: 0.5 }] }, ADMIN);

  const object = calls.put[0];
  assert.equal(object.ContentType, "image/png");
  assert.match(object.Key, /\.png$/);
  const metadata = await sharp(object.Body).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.hasAlpha, true);
});

test("blur cover preview returns the picture and stores nothing", async () => {
  const { handler, calls } = harness();
  const result = await handler(
    { kind: "book", id: "abc", imageUrl: IMAGE_URL, preview: true, strength: 7, regions: [{ shape: "ellipse", x: 0.2, y: 0.2, w: 0.3, h: 0.3 }] },
    ADMIN
  );
  assert.equal(calls.put.length, 0);
  assert.equal(result.url, undefined);
  assert.equal(result.strength, 7);
  assert.equal(result.sourceHash, crypto.createHash("sha1").update(await checkerboard(1200, 800)).digest("hex").slice(0, 12));
  const match = /^data:image\/jpeg;base64,(.+)$/.exec(result.preview);
  assert.ok(match, "expected a JPEG data URL");
  assert.equal((await sharp(Buffer.from(match[1], "base64")).metadata()).width, 1200);
});

test("blur cover never enlarges a small image", async () => {
  const { handler, calls } = harness({ fetchImage: async () => checkerboard(200, 300) });
  await handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL }, ADMIN);
  const metadata = await sharp(calls.put[0].Body).metadata();
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 300);
});

test("blur cover reports an unreachable or undecodable image as a failed precondition", async () => {
  const unreachable = harness({
    fetchImage: async () => {
      throw new Error("HTTP 404");
    },
  });
  await rejectsWith(unreachable.handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL }, ADMIN), "failed-precondition");
  assert.equal(unreachable.calls.put.length, 0);

  const garbage = harness({ fetchImage: async () => Buffer.from("<html>not an image</html>") });
  await rejectsWith(garbage.handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL }, ADMIN), "failed-precondition");
  assert.equal(garbage.calls.put.length, 0);
});

test("blur cover reports a storage failure as internal", async () => {
  const { handler } = harness({
    putObject: async () => {
      throw new Error("AccessDenied");
    },
  });
  await rejectsWith(handler({ kind: "podcast", id: "5", imageUrl: IMAGE_URL }, ADMIN), "internal");
});

test("image fetch enforces status, size and timeout limits", async (t) => {
  const png = await checkerboard(40, 40);
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    } else if (req.url === "/missing") {
      res.writeHead(404);
      res.end();
    } else if (req.url === "/large") {
      // No Content-Length, so only the streamed byte count can stop it.
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(600));
      res.end(Buffer.alloc(600));
    } else if (req.url === "/slow") {
      res.writeHead(200);
      res.write(Buffer.alloc(10));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.deepEqual(await fetchImageWithLimits(`${base}/ok`), png);
  await assert.rejects(fetchImageWithLimits(`${base}/missing`), /HTTP 404/);
  await assert.rejects(fetchImageWithLimits(`${base}/large`, 5_000, 1_000), /too large/);
  await assert.rejects(fetchImageWithLimits(`${base}/slow`, 200), /timed out/);
});
