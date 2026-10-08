// Which build of the till the API names to tablets (GET /health, `till`), so
// that a till already installed offers its own update.
//
// Two places say what the newest build is. A release of the till publishes
// till.json beside its APK (.github/workflows/release-apk.yml), and the API
// reads the newest release's copy: publishing a release is then all it takes
// for tablets to be offered it. And a deploy can be told a build
// (LATEST_TILL_VERSION, LATEST_TILL_NAME, TILL_APK_URL, see neon.ts), which is
// what is named while GitHub cannot be reached, or to name a build no release
// published. The newer of the two is the one named.
//
// Nothing here asks anyone anything: hello.ts fetches the file and keeps what
// it read; these are the decisions, kept apart so that they are tested
// (till-release.test.cjs).

// version is the build's versionCode, name what people call it ("0.5.1"),
// url where its APK is downloaded from.
export type Till = { version: number; name: string; url: string };

const WHOLE = 2_000_000_000; // a versionCode is an Android int

// Where the APKs named by the file at `address` may be: for a GitHub release,
// the same repository's release downloads; anywhere else, the same site. A
// till.json naming an APK from somewhere else is not believed. null when the
// address is not an https one.
export function releasesOf(address: string): string | null {
  let at: URL;
  try { at = new URL(address); } catch { return null; }
  if (at.protocol !== "https:") return null;
  const cut = at.pathname.indexOf("/releases/");
  return cut < 0 ? `${at.origin}/` : `${at.origin}${at.pathname.slice(0, cut)}/releases/download/`;
}

// What a release published as till.json, read as a build; null when it is not
// one, or names an APK that is not under `releases`.
export function published(text: string, releases: string | null): Till | null {
  if (!releases || text.length > 4096) return null;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const { version, name, url } = o as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0 || version > WHOLE) return null;
  if (typeof url !== "string" || !/^https:\/\/\S+$/.test(url) || !url.startsWith(releases) || url.includes("..")) return null;
  const called = typeof name === "string" ? name.trim().slice(0, 40) : "";
  return { version, name: called || `build ${version}`, url };
}

// What the deploy was told. Without a version or an https address there is
// no build to name.
export function deployed(env: Record<string, string | undefined>): Till | null {
  const version = Math.trunc(Number(env.LATEST_TILL_VERSION ?? "0")) || 0;
  const url = (env.TILL_APK_URL ?? "").trim();
  if (version <= 0 || !/^https:\/\/\S+$/i.test(url)) return null;
  return { version, name: (env.LATEST_TILL_NAME ?? "").trim() || `build ${version}`, url };
}

// The newer of the two. The same build named by both: what the deploy said
// stands, since it was said on purpose.
export function newest(fromDeploy: Till | null, fromRelease: Till | null): Till | null {
  if (!fromDeploy) return fromRelease;
  if (!fromRelease) return fromDeploy;
  return fromRelease.version > fromDeploy.version ? fromRelease : fromDeploy;
}

// Whether the file is to be read again: ten minutes after a read that worked,
// one minute after one that did not, and at once when it was never read or
// the clock has gone back.
export function stale(now: number, seen: { at: number; ok: boolean } | null): boolean {
  if (!seen || now < seen.at) return true;
  return now - seen.at >= (seen.ok ? 10 : 1) * 60_000;
}
