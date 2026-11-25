import { OpenApi } from "effect/unstable/httpapi";
import { Api } from "./api.js";
import * as Account from "./account.js";
import * as AgentInvites from "./agent-invites.js";
import * as ApiKeys from "./api-keys.js";
import * as Billing from "./billing.js";
import * as Email from "./email.js";
import * as Feedback from "./feedback.js";
import * as Guests from "./guests.js";
import * as Onboarding from "./onboarding.js";
import * as P from "./platform.js";
import * as Share from "./share.js";
import * as SignIns from "./sign-ins.js";
import * as Starter from "./starter.js";

/**
 * The whole public HTTP contract as one OpenAPI document: what the Worker serves at /openapi.json
 * and what the docs site's API reference is generated from, so the two never disagree.
 */
export const document = () => {
  const core = OpenApi.fromApi(Api);
  const parts = [
    OpenApi.fromApi(P.Api),
    OpenApi.fromApi(P.AuthApi),
    OpenApi.fromApi(Billing.Api),
    OpenApi.fromApi(Onboarding.Api),
    OpenApi.fromApi(Starter.Api),
    OpenApi.fromApi(Account.Api),
    OpenApi.fromApi(Email.Api),
    OpenApi.fromApi(SignIns.Api),
    OpenApi.fromApi(Share.Api),
    OpenApi.fromApi(Feedback.Api),
    OpenApi.fromApi(Guests.Api),
    OpenApi.fromApi(ApiKeys.Api),
    OpenApi.fromApi(AgentInvites.Api),
  ];
  return {
    ...core,
    paths: Object.assign({}, core.paths, ...parts.map((part) => part.paths)),
    components: {
      ...core.components,
      schemas: Object.assign(
        {},
        core.components?.schemas,
        ...parts.map((part) => part.components?.schemas),
      ),
    },
  };
};
