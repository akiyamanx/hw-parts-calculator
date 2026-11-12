// お試し版ではすべての読み書きに接頭辞を付ける。本番のキー（接頭辞なし）には書かない。
// 接続用クライアントIDだけ、同じオリジンの既存キーを読む（業務Proで保存済みなら使い回せる）。
const AppStorage = (() => {
    const profile = typeof AppProfile !== "undefined" ? AppProfile : { storagePrefix: "", readThroughKeys: [] };
    const P = profile.storagePrefix || "";
    const through = new Set(profile.readThroughKeys || []);
    const raw = () => {
        try { return localStorage; } catch (e) { return null; }
    };
    return {
        getItem(key) {
            const ls = raw();
            if (!ls) return null;
            try {
                const v = ls.getItem(P + key);
                if (v != null) return v;
                if (through.has(key) && P) {
                    const t = ls.getItem(key);
                    if (t != null) return t;
                }
                return null;
            } catch (e) { return null; }
        },
        setItem(key, value) {
            const ls = raw();
            if (!ls) throw new Error("storage_unavailable");
            ls.setItem(P + key, value);
        },
        removeItem(key) {
            const ls = raw();
            if (!ls) return;
            try { ls.removeItem(P + key); } catch (e) { /* ignore */ }
        },
        keys() {
            const ls = raw();
            if (!ls) return [];
            const out = [];
            for (let i = 0; i < ls.length; i++) {
                const k = ls.key(i);
                if (!k) continue;
                if (P) {
                    if (k.indexOf(P) === 0) out.push(k.slice(P.length));
                } else {
                    if (k.indexOf("stgHw:") === 0) continue;
                    out.push(k);
                }
            }
            return out;
        }
    };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AppStorage;
