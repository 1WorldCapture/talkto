import * as Hosted from "../src/hosted.js";

/** The hosted Worker's HTTP handler alone, for asset routing tests without the Durable Objects. */
export default Hosted.makeWorker(Hosted.workosAuthentication);
