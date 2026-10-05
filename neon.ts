import { defineConfig } from "@neon/config/v1";

// MIN_TILL_VERSION (in the env file given to `neon deploy --env`, or in the
// shell) is the oldest build of the till the API still talks to: its
// versionCode. A till older than that is answered "must be updated" and keeps
// its sales until it is. It is always sent, as 0 when it is not set, because a
// value left out of a deploy keeps whatever the last deploy gave it: 0 means
// every till is accepted. GET /health shows the value in force as minTill.
const minTill = process.env.MIN_TILL_VERSION?.trim() || "0";

export default defineConfig({
  auth: true,
  preview: {
    functions: {
      api: { name: "api", source: "./hello.ts", env: { MIN_TILL_VERSION: minTill } },
    },
  },
});
