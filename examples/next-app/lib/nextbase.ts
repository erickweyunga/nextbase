import { NextBase } from "@nextbase/nextbase/server";

/** The app's one NextBase instance, shared by the route handler and server components. */
export const nextbase = new NextBase();
