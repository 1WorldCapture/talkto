import { useQuery } from "@tanstack/react-query";
import { request } from "./api.js";
import { useHuman, useServices } from "./session.js";
/** Read the authenticated person's durable setup; an unavailable read is never a fresh start. */
export function useOnboardingState() {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: ["human", user.id, "onboarding", "state"],
    queryFn: ({ signal }) => request(api.onboarding.state(), signal),
    refetchOnMount: "always",
  });
}
