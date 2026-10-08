import { defineConfig } from "@neon/config/v1";

// MIN_TILL_VERSION (in the env file given to `neon deploy --env`, or in the
// shell) is the oldest build of the till the API still talks to: its
// versionCode. A till older than that is answered "must be updated" and keeps
// its sales until it is. It is always sent, as 0 when it is not set, because a
// value left out of a deploy keeps whatever the last deploy gave it: 0 means
// every till is accepted. GET /health shows the value in force as minTill.
const minTill = process.env.MIN_TILL_VERSION?.trim() || "0";

// The newest build of the till there is to install, for the till's update key:
// LATEST_TILL_VERSION is its versionCode, LATEST_TILL_NAME what people call it
// ("0.4.0"), TILL_APK_URL the https address its APK is downloaded from. Always
// sent, for the same reason: left out, they are 0 and empty, and no till is
// offered an update. GET /health shows what is in force as till.
const latestTill = process.env.LATEST_TILL_VERSION?.trim() || "0";
const latestName = process.env.LATEST_TILL_NAME?.trim() || "";
const apkUrl = process.env.TILL_APK_URL?.trim() || "";

export default defineConfig({
  auth: true,
  preview: {
    functions: {
      api: {
        name: "api",
        source: "./hello.ts",
        env: { MIN_TILL_VERSION: minTill, LATEST_TILL_VERSION: latestTill, LATEST_TILL_NAME: latestName, TILL_APK_URL: apkUrl },
      },
    },
  },
});
