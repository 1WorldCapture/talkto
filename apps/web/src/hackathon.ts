/**
 * The hackathon's visit counter (owner decision, November 17, 2026). It sends ship-or-die.com the
 * page path, the referring site, campaign tags and whether the visit came from a paid click; no
 * cookies, and nothing under Global Privacy Control. Loaded only on public pages at talkto.sh, so
 * the dashboard, staging and local builds never run it. The integrity hash pins the script read on
 * November 17, 2026: if ship-or-die.com changes it, the browser refuses to run it until the new
 * version is read and its hash updated here.
 */
const source = "https://www.ship-or-die.com/hackathon/verify.js";
const integrity = "sha384-5eftaEf/Zc9OU/GKwliKiY9PMLWLwxcwtlAtQdAgaTvg82WG+t+l8wwsYB5VFUP0";
const site = "870d8d84433288af3ab7af566d19b8903cfa6ac2";
const host = "talkto.sh";

/** Add the counter to this public page; call after the address bar holds its final URL. */
export function loadVisitCounter() {
  if (location.hostname !== host) return;
  const script = document.createElement("script");
  script.src = source;
  script.integrity = integrity;
  script.crossOrigin = "anonymous";
  script.referrerPolicy = "origin";
  script.defer = true;
  script.dataset.site = site;
  document.head.append(script);
}
