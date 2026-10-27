// Links never use the spoofable Host header, which could send reset tokens to an
// attacker's site. HTTPS keeps tokens off the wire, except on localhost.
export function checkAppUrl(value: string, option = "appUrl"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${option} is not a URL: ${value}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError(
      `${option} must use HTTPS, so links carrying tokens are not sent in the clear (http is allowed on localhost).`,
    );
  }
  return url;
}
