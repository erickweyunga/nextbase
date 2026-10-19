import { newNextHandler } from "@nextbase/next";
import { nextbase } from "@/lib/nextbase";

export const { GET, POST, PUT, PATCH, DELETE } = newNextHandler(nextbase);
