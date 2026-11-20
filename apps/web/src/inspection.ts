import { useEffect, useState } from "react";

/** A response arriving during inspection waits alongside the last displayed snapshot. */
export function useInspection<T>(incoming: T | undefined, held: boolean, blocked = false) {
  const [displayed, setDisplayed] = useState(incoming);
  useEffect(() => {
    if (blocked) setDisplayed(undefined);
    else if (!held || displayed === undefined) setDisplayed(incoming);
  }, [incoming, held, blocked, displayed]);
  return {
    displayed: blocked ? undefined : displayed,
    accept: (confirmed: T | undefined = incoming) => setDisplayed(confirmed),
  };
}
