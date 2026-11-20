import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi";
import { Unauthorized } from "./envelope.js";

/** Bearer security contract. Credential verification is supplied by the runtime entry point. */
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@talkto/Authorization",
  {
    security: {
      bearer: HttpApiSecurity.bearer,
      webSession: HttpApiSecurity.apiKey({ key: "__Host-talkto-session", in: "cookie" }),
    },
    error: Unauthorized,
  },
) {}
