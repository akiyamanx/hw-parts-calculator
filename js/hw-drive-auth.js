// Google Identity Services で Drive のアプリ専用領域(appDataFolder)へ接続する。
// アクセストークンはメモリだけ（localStorage には置かない）。ページを閉じると切れる。
// 接続用クライアントIDだけ端末に保存する（秘密ではない。シークレットは使わない・求めない）。
const HwDriveAuth = (() => {
    const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
    const API = "https://www.googleapis.com/drive/v3/";
    const ID_RE = /^\d+-[\w-]+\.apps\.googleusercontent\.com$/;
    const ID_KEYS = ["hwParts.oauthClientId", "culo_google_calendar_client_id"];
    let token = "", expiry = 0, account = null, clientId = "", generation = 0, preparing;
    const requests = new Set();
    const store = () => (typeof AppStorage !== "undefined" ? AppStorage : null);
    const coded = (message, code) => Object.assign(new Error(message), { code });

    function configured() {
        const S = store();
        if (!S) return "";
        for (const k of ID_KEYS) {
            const v = (S.getItem(k) || "").trim();
            if (ID_RE.test(v)) return v;
        }
        return "";
    }
    function saveClientId(id) {
        const S = store();
        const v = String(id || "").trim();
        if (!ID_RE.test(v)) throw new Error("接続用IDの形が違います（末尾が .apps.googleusercontent.com のものを貼ってください）。");
        S.setItem("hwParts.oauthClientId", v);
    }
    function clearClientId() {
        const S = store();
        if (S) try { S.removeItem("hwParts.oauthClientId"); } catch (e) { /* ignore */ }
    }
    function disconnect() {
        generation++;
        token = "";
        expiry = 0;
        account = null;
        requests.forEach(c => c.abort());
        requests.clear();
    }
    function state() {
        if (token && (Date.now() >= expiry || clientId !== configured())) disconnect();
        return { connected: Boolean(token && account), email: account && account.emailAddress || "", hasClientId: !!configured() };
    }
    function prepare() {
        if (typeof window !== "undefined" && window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
        if (!preparing) preparing = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://accounts.google.com/gsi/client";
            script.async = true;
            const timer = setTimeout(() => { preparing = null; reject(new Error("Googleへの接続準備ができません。通信状態を確認してください。")); }, 15000);
            script.onload = () => { clearTimeout(timer); resolve(); };
            script.onerror = () => { clearTimeout(timer); preparing = null; reject(new Error("Googleの接続画面を読み込めません。")); };
            document.head.appendChild(script);
        });
        return preparing;
    }
    async function request(url, options, consume) {
        consume = consume || (async r => r);
        if (!token || Date.now() >= expiry || clientId !== configured()) { disconnect(); throw coded("共有先への接続が切れました。もう一度接続してください。", "not_connected"); }
        const own = generation, controller = new AbortController();
        requests.add(controller);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
        try {
            const response = await fetch(url, {
                ...(options || {}),
                signal: controller.signal,
                cache: "no-store",
                credentials: "omit",
                headers: { ...((options && options.headers) || {}), Authorization: "Bearer " + token }
            });
            if (own !== generation) throw coded("接続が変更されたため操作を中止しました。", "aborted");
            if (response.status === 401) { disconnect(); throw coded("Googleの許可が切れました。もう一度接続してください。", "auth_expired"); }
            if (!response.ok) {
                throw coded(response.status === 403
                    ? "Google Driveを利用できません。Drive APIの有効化、追加のアクセス許可、保存容量を確認してください。"
                    : "共有先との通信に失敗しました（" + response.status + "）。端末の保存データは変更していません。",
                    response.status === 403 ? "forbidden" : "http_error");
            }
            const result = await consume(response);
            if (own !== generation || clientId !== configured()) throw coded("接続が変更されたため操作を中止しました。", "aborted");
            return result;
        } catch (error) {
            if (error && error.name === "AbortError") throw coded("通信が中断しました。接続を確認してもう一度同期してください。", timedOut ? "timeout" : "aborted");
            throw error;
        } finally {
            clearTimeout(timer);
            requests.delete(controller);
        }
    }
    const appdataUrl = /^https:\/\/www\.googleapis\.com\/(upload\/)?drive\/v3\/files(\/[\w-]+)?(\?[^#\s]*)?$/;
    function appdataRequest(url, options, consume) {
        const method = String((options && options.method) || "GET").toUpperCase();
        if (typeof url !== "string" || !appdataUrl.test(url) || ["GET", "POST", "PATCH", "PUT"].indexOf(method) < 0) {
            return Promise.reject(coded("許可されていない通信先です。", "bad_url"));
        }
        return request(url, options || {}, consume);
    }
    function connect() {
        const id = configured();
        if (!ID_RE.test(id)) return Promise.reject(new Error("先に接続用のクライアントIDを保存してください。業務Proで使っているものと同じで大丈夫です。"));
        if (!(typeof window !== "undefined" && window.google && window.google.accounts && window.google.accounts.oauth2)) {
            prepare().catch(() => {});
            return Promise.reject(new Error("接続を準備しています。少し待ってからもう一度押してください。"));
        }
        disconnect();
        clientId = id;
        const own = generation;
        return new Promise((resolve, reject) => {
            let finished = false;
            const end = (error) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(state()); };
            const timer = setTimeout(() => { if (own === generation) disconnect(); end(new Error("接続を完了できませんでした。もう一度お試しください。")); }, 60000);
            const client = google.accounts.oauth2.initTokenClient({
                client_id: id,
                scope: SCOPE,
                include_granted_scopes: false,
                callback: async (response) => {
                    if (finished) return;
                    if (own !== generation) return end(new Error("接続操作を中止しました。"));
                    if (response.error || !response.access_token) return end(new Error("共有の許可が完了していません。データは送っていません。"));
                    if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) return end(new Error("アプリ専用領域へのアクセスを許可してください。"));
                    token = response.access_token;
                    expiry = Date.now() + Math.max(0, Number(response.expires_in || 0) - 60) * 1000;
                    try {
                        const about = await request(API + "about?fields=user(permissionId,emailAddress)", {}, r => r.json());
                        if (own !== generation) throw new Error("接続操作を中止しました。");
                        if (!about.user || !about.user.permissionId || !about.user.emailAddress) throw new Error("Googleアカウントを確認できません。");
                        account = about.user;
                        end();
                    } catch (error) {
                        if (own === generation) disconnect();
                        end(error);
                    }
                },
                error_callback: () => end(new Error("接続画面を閉じました。必要なときに再接続してください。"))
            });
            try { client.requestAccessToken({ prompt: "select_account" }); } catch (error) { end(error); }
        });
    }
    if (typeof window !== "undefined") window.addEventListener("pagehide", disconnect);
    return { prepare, connect, disconnect, state, configured, saveClientId, clearClientId, appdataRequest };
})();
if (typeof module !== "undefined" && module.exports) module.exports = HwDriveAuth;
