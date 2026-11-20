import * as Ingress from "./ingress.js";
export { TalkToServer } from "./server-object.js";

/** Explicit development entry point, protected by a local credential and loopback hostname. */
export default Ingress.makeWorker(Ingress.localAccess);
