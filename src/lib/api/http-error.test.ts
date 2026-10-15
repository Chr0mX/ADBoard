import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { httpErrorMessage } from "./http-error.ts";

const CLOUDFLARE_PAGE = '<!DOCTYPE html><html lang="en-US"><head><title>adboard.example.com | 522: Connection timed out</title></head><body>…</body></html>';

describe("httpErrorMessage", () => {
  it("keeps plain agent errors", () => {
    assert.equal(httpErrorMessage(400, "adb is not available", "x"), "adb is not available");
  });

  it("reads JSON error bodies", () => {
    assert.equal(httpErrorMessage(401, '{"error":"Sign in to ADBoard."}', "x"), "Sign in to ADBoard.");
  });

  it("replaces Cloudflare HTML pages with one line", () => {
    const message = httpErrorMessage(522, CLOUDFLARE_PAGE, "bootstrap failed");
    assert.match(message, /^Cloudflare could not reach/);
    assert.doesNotMatch(message, /</);
  });

  it("explains proxy failures and timeouts", () => {
    assert.match(httpErrorMessage(502, "<html><body>Bad Gateway</body></html>", "x"), /proxy could not reach ADBoard \(502\)/);
    assert.match(httpErrorMessage(524, CLOUDFLARE_PAGE, "x"), /100 seconds/);
    assert.match(httpErrorMessage(413, "<html><body>413</body></html>", "x"), /100 MB/);
  });

  it("falls back for unknown HTML errors", () => {
    assert.equal(httpErrorMessage(404, "<!DOCTYPE HTML><html>…</html>", "listDevices failed"), "listDevices failed (404)");
  });
});
