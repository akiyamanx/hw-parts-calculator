// 本番(/hw-parts-calculator/)とお試し版(/hw-parts-calculator-staging/)は同じオリジン
// (https://akiyamanx.github.io) なので、localStorage と Drive の保存先を分けないと混ざる。
// お試し版のときだけ、保存キーに接頭辞を付け、Drive の channel も別にする。本番のキーは触らない。
const AppProfile = (() => {
    const STAGING_PATH = /^\/hw-parts-calculator-staging(\/|$)/;
    const pathname = (typeof location !== "undefined" && location.pathname) ? location.pathname : "";
    const staging = STAGING_PATH.test(pathname);
    const profile = {
        staging,
        storagePrefix: staging ? "stgHw:" : "",
        channel: staging ? "hw-parts-staging" : "hw-parts-main",
        // 秘密ではない接続用IDだけ、同じオリジンの本番キーを「読むだけ」借りてよい。書き込みはしない。
        readThroughKeys: Object.freeze(["culo_google_calendar_client_id", "hwParts.oauthClientId"])
    };
    if (staging && typeof document !== "undefined" && document.addEventListener) {
        const paint = () => {
            if (document.title && document.title.indexOf("【お試し版】") !== 0) {
                document.title = "【お試し版】" + document.title;
            }
            if (document.getElementById("stagingBanner") || !document.body) return;
            const bar = document.createElement("div");
            bar.id = "stagingBanner";
            bar.setAttribute("role", "status");
            bar.textContent = "お試し版です（本番とは別のデータ・Googleドライブの保存先も別）";
            document.body.insertBefore(bar, document.body.firstChild);
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paint);
        else paint();
    }
    return profile;
})();
if (typeof module !== "undefined" && module.exports) module.exports = AppProfile;
