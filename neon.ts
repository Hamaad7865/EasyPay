import { defineConfig } from "@neon/config/v1";

// MIN_TILL_VERSION (in the env file given to `neon deploy --env`, or in the
// shell) is the oldest build of the till the API still talks to: its
// versionCode. A till older than that is answered "must be updated" and keeps
// its sales until it is. It is always sent, as 0 when it is not set, because a
// value left out of a deploy keeps whatever the last deploy gave it: 0 means
// every till is accepted. GET /health shows the value in force as minTill.
const minTill = process.env.MIN_TILL_VERSION?.trim() || "0";

// The newest build of the till there is to install, for the till's update key.
// On production the API reads it from the newest release by itself (till.json,
// published by the release workflow; see hello.ts), so a till release needs
// no deploy. These three name a build as well, for when that file cannot be
// read or no release published the build: LATEST_TILL_VERSION is its
// versionCode, LATEST_TILL_NAME what people call it ("0.5.1"), TILL_APK_URL
// the https address its APK is downloaded from. Always sent, for the same
// reason as above: left out, they are 0 and empty. GET /health shows what is
// in force as till.
const latestTill = process.env.LATEST_TILL_VERSION?.trim() || "0";
const latestName = process.env.LATEST_TILL_NAME?.trim() || "";
const apkUrl = process.env.TILL_APK_URL?.trim() || "";
// Where till.json is read from. Empty, the branch decides: production reads
// this repository's newest release, any other branch reads nothing. An https
// address reads that file; "off" reads nothing, on production too.
const releaseUrl = process.env.TILL_RELEASE_URL?.trim() || "";

export default defineConfig({
  auth: true,
  preview: {
    functions: {
      api: {
        name: "api",
        source: "./hello.ts",
        env: { MIN_TILL_VERSION: minTill, LATEST_TILL_VERSION: latestTill, LATEST_TILL_NAME: latestName, TILL_APK_URL: apkUrl, TILL_RELEASE_URL: releaseUrl },
      },
    },
  },
});
