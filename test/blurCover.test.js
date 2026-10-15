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

  const key = blurredCoverKey("book", "abc-123", await checkerboard(1200, 800));
  assert.deepEqual(result, { url: `https://images.mantooq.com/${key}` });
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
