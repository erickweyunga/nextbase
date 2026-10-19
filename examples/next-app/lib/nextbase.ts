// Fails the build if a client component imports this module.
import "server-only";
import { NextBase } from "@nextbasejs/core";

/** The app's one NextBase instance, shared by the route handler and server components. */
export const nextbase = new NextBase();
