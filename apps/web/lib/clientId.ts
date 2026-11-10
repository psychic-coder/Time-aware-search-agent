const KEY = "tasa.clientId";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for non-secure contexts (e.g. LAN IP over http)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Anonymous identity. `?client=<uuid>` adopts an existing identity (used to open the seeded demo history).
 */
export function getClientId(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("client");
    if (fromUrl && UUID_RE.test(fromUrl)) {
      localStorage.setItem(KEY, fromUrl.toLowerCase());
      url.searchParams.delete("client");
      window.history.replaceState(null, "", url.toString());
      return fromUrl.toLowerCase();
    }
    const existing = localStorage.getItem(KEY);
    if (existing && UUID_RE.test(existing)) return existing;
    const id = uuid();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return uuid(); // storage disabled: identity lasts for this tab only
  }
}

export function getTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
