// DataSync が使う Drive(appDataFolder) アダプタ。
// 認証と通信は HwDriveAuth に任せ、ここでは URL とファイル形式だけを組み立てる。
// トークンは持たない・見ない・ログに出さない。
// ファイルは appProperties の app='HWPartsDataSync1' と channel で区別し、業務Proのファイルとは混ざらない。
const HwDriveAdapter = (() => {
    const APP = "HWPartsDataSync1";
    const PREFIX = "HWParts-data-";
    const API = "https://www.googleapis.com/drive/v3/";
    const UPLOAD = "https://www.googleapis.com/upload/drive/v3/";
    const MAX_BYTES = 4 * 1024 * 1024, MAX_PAGES = 10;
    const ID_RE = /^[\w-]{1,200}$/;
    const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const SAVED_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]{8,16}Z$/;
    const CHANNEL_RE = /^[\w.-]{1,60}$/;
    const CODES = ["not_connected", "auth_expired", "forbidden", "timeout", "http_error", "aborted", "bad_url", "too_large", "bad_response"];
    const err = code => Object.assign(new Error(code), { code });
    const mapErr = e => err(e && CODES.indexOf(e.code) >= 0 ? e.code : "network");

    function create(opts) {
        const transport = opts && opts.transport;
        const channel = String((opts && opts.channel) || "");
        const app = (opts && opts.app) || APP;
        const prefix = (opts && opts.prefix) || PREFIX;
        const maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
        if (!/^HWParts\w{1,40}$/.test(app) || !/^HWParts-[\w-]{1,40}$/.test(prefix)) throw new Error("app invalid");
        if (!transport || typeof transport.appdataRequest !== "function" || typeof transport.state !== "function") throw new Error("transport required");
        if (!CHANNEL_RE.test(channel)) throw new Error("channel invalid");
        const call = async (url, options, consume) => {
            try { return await transport.appdataRequest(url, options || {}, consume); } catch (e) { throw mapErr(e); }
        };
        function available() {
            try { return { connected: !!(transport.state() || {}).connected }; } catch (e) { return { connected: false }; }
        }
        async function list() {
            const q = "appProperties has { key='app' and value='" + app + "' } and appProperties has { key='channel' and value='" + channel + "' } and trashed = false";
            const out = []; let token = "";
            for (let page = 0; page < MAX_PAGES; page++) {
                const params = new URLSearchParams({ spaces: "appDataFolder", q, pageSize: "100", fields: "nextPageToken,files(id,size,modifiedTime,appProperties)" });
                if (token) params.set("pageToken", token);
                const data = await call(API + "files?" + params.toString(), {}, r => r.json());
                if (!data || !Array.isArray(data.files)) throw err("bad_response");
                for (const f of data.files) {
                    const p = f && f.appProperties;
                    if (!f || typeof f.id !== "string" || !ID_RE.test(f.id) || !p || !DEVICE_RE.test(String(p.deviceId || ""))) continue;
                    out.push({
                        id: f.id,
                        deviceId: p.deviceId,
                        savedAt: SAVED_RE.test(String(p.savedAt || "")) ? p.savedAt : "",
                        size: Number(f.size) >= 0 ? Number(f.size) : 0,
                        modified: typeof f.modifiedTime === "string" ? f.modifiedTime.slice(0, 40) : ""
                    });
                }
                token = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
                if (!token) break;
            }
            return out;
        }
        async function read(file) {
            if (!file || typeof file.id !== "string" || !ID_RE.test(file.id)) throw err("bad_response");
            if (Number(file.size) > maxBytes) throw err("too_large");
            return call(API + "files/" + file.id + "?alt=media", {}, async r => {
                const text = await r.text();
                if (typeof text !== "string") throw err("bad_response");
                if (text.length > maxBytes) throw err("too_large");
                return text;
            });
        }
        async function write(args) {
            const a = args || {};
            const fileId = a.fileId == null ? null : a.fileId;
            if (!DEVICE_RE.test(String(a.deviceId || "")) || !SAVED_RE.test(String(a.savedAt || "")) || typeof a.text !== "string") throw err("bad_response");
            if (fileId !== null && (typeof fileId !== "string" || !ID_RE.test(fileId))) throw err("bad_response");
            if (a.text.length > maxBytes) throw err("too_large");
            const props = { app, channel, deviceId: a.deviceId, savedAt: a.savedAt };
            const meta = fileId === null
                ? { name: prefix + a.deviceId + ".json", mimeType: "application/json", parents: ["appDataFolder"], appProperties: props }
                : { appProperties: props };
            let boundary;
            do { boundary = "hwparts" + Math.random().toString(16).slice(2) + Date.now().toString(16); } while (a.text.indexOf(boundary) >= 0);
            const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n"
                + "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + a.text + "\r\n--" + boundary + "--";
            const url = UPLOAD + "files" + (fileId === null ? "" : "/" + fileId) + "?uploadType=multipart&fields=id";
            const res = await call(url, { method: fileId === null ? "POST" : "PATCH", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body }, r => r.json());
            if (!res || typeof res.id !== "string" || !ID_RE.test(res.id)) throw err("bad_response");
            return { id: res.id };
        }
        return { available, list, read, write };
    }
    return { create, APP, PREFIX };
})();
if (typeof module !== "undefined" && module.exports) module.exports = HwDriveAdapter;
