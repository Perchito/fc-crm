// Perchito's Server storage client — copy this file into any repo that stores files
// on the home server. Works in Node 18+ (and edge runtimes) with no dependencies.
//
//   import { homeStorage } from "./home-storage.mjs";
//   const storage = homeStorage({
//     url: process.env.HOME_STORAGE_URL,          // e.g. http://192.168.1.20:9100
//     project: process.env.HOME_STORAGE_PROJECT,  // e.g. "wedding-gallery"
//     key: process.env.HOME_STORAGE_KEY,          // server-side only — never ship to a browser
//   });
//   await storage.put("photos/a.jpg", buffer, "image/jpeg");
//   const res = await storage.get("photos/a.jpg");           // a fetch Response
//   const { objects } = await storage.list("photos/");
//   const link = await storage.signedUrl("photos/a.jpg", { expiresIn: 3600 });          // share / <img src>
//   const upload = await storage.signedUrl("photos/b.jpg", { method: "PUT" });          // browser uploads directly
//   await storage.del("photos/a.jpg");

export function homeStorage({ url, project, key }) {
  if (!url || !project) throw new Error("homeStorage: url and project are required");
  const base = `${url.replace(/\/$/, "")}/v1/${project}`;
  const enc = (path) => String(path).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  const auth = key ? { authorization: `Bearer ${key}` } : {};

  async function call(method, path, init = {}) {
    const r = await fetch(`${base}/${enc(path)}`, { method, ...init, headers: { ...auth, ...init.headers } });
    if (!r.ok && !(method === "GET" && r.status === 404)) {
      const body = await r.json().catch(() => ({}));
      throw new Error(`home storage ${method} ${path}: ${r.status} ${body.error || r.statusText}`);
    }
    return r;
  }

  return {
    /** Public URL (works without a key only when the project has public read on). */
    publicUrl: (path) => `${base}/${enc(path)}`,

    put: (path, body, contentType = "application/octet-stream") =>
      call("PUT", path, { body, headers: { "content-type": contentType }, duplex: "half" }).then((r) => r.json()),

    /** Returns the fetch Response (status 404 if missing) — use .arrayBuffer(), .text(), .body … */
    get: (path, init) => call("GET", path, init),

    exists: (path) => call("HEAD", path).then((r) => r.ok).catch(() => false),

    del: (path) => call("DELETE", path).then(() => true),

    list: async (prefix = "", limit = 1000) => {
      const r = await fetch(`${base}?prefix=${encodeURIComponent(prefix)}&limit=${limit}`, { headers: auth });
      if (!r.ok) throw new Error(`home storage list: ${r.status}`);
      return r.json(); // { objects: [{ path, bytes, updatedAt }], truncated }
    },

    /** A URL that allows one method (GET or PUT) on one file until it expires. Needs the key. */
    signedUrl: async (path, { method = "GET", expiresIn = 3600 } = {}) => {
      if (!key) throw new Error("signedUrl needs the project key");
      const clean = String(path).replace(/^\/+/, "");
      const exp = Math.floor(Date.now() / 1000) + expiresIn;
      const msg = `${method}\n${project}/${clean}\n${exp}`;
      const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
      const sig = btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `${base}/${enc(clean)}?exp=${exp}&sig=${sig}`;
    },
  };
}
