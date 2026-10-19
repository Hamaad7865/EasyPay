// A stand-in for EasyPay's till service, for this PC only: the one question
// the relay asks it, `GET /guest/pass`, answered from the credential itself.
//
//   Authorization: Device <store>:<word>-anything
//
// says the till is of <store>; a word of "bad" is a till nobody knows (401)
// and "off" a store whose table ordering is switched off. A key of the shape a
// real till has (a device's id and sixty-four hex digits, as the debug build's
// made-up restaurant is given) is taken for the demo store's. The real service
// looks the till up in the database (hello.ts); nothing here is a secret.
//
//   node test/stand-in-api.mjs        listens on 127.0.0.1:8788
import http from "node:http";
import { pathToFileURL } from "node:url";

// Starts it. Answers the server, or null when the port is taken: another
// stand-in is already answering there, which does as well.
export function standInApi(port = 8788) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const say = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method !== "GET" || req.url !== "/guest/pass") return say(404, { error: "not found" });
      const proof = req.headers.authorization || "";
      if (/^Device\s+[0-9a-f]{8}-[0-9a-f-]{27}:[0-9a-f]{64}$/i.test(proof)) return say(200, { store: "demostoreaaaaaaa", ordering: true });
      // "<store>.<till>" is one of several tills of that store
      const m = /^Device\s+([a-z2-7]{16})(?:\.\w{1,16})?:(\w+)-/.exec(proof);
      if (!m || m[2] === "bad") return say(401, { error: "Unauthorized" });
      say(200, { store: m[1], ordering: m[2] !== "off" });
    });
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log((await standInApi()) ? "stand-in for EasyPay's till service on http://127.0.0.1:8788" : "8788 is taken: a stand-in is probably running already");
}
