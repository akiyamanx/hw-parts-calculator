// [端末間の自動同期 画面] 上部の帯で状態を出し、自動で同期する。
//   いつ同期するか: Googleドライブにつないだとき・アプリに戻ったとき・変更の約2秒後・「今すぐ同期」。
//   つなぐ許可（トークン）はこの画面の中だけ。アプリを開くたびに「接続して同期」を1回押す。
//   一度に多くの部材・集計・書類が消えたときは確認する。
// 失敗は帯に出して、端末の保存データは消さない。ログにはコードだけ（中身・トークンは出さない）。
const HwDataSyncUI = (() => {
    function createPoller(o) {
        const base = o.baseMs || 20000, max = o.maxMs || 300000;
        let lastSig = null, pendingSig = null, interval = base, deferred = false, running = false;
        async function check() {
            if (running) return "busy";
            if (!o.isVisible() || !o.isConnected()) return "paused";
            if (o.isBusy && o.isBusy()) return "busy";
            running = true;
            try {
                if (deferred) { if (o.isEditing()) return "deferred"; lastSig = pendingSig; }
                else {
                    const r = await o.core.remoteSignature();
                    if (!r || !r.ok) { interval = Math.min(interval * 2, max); return "error"; }
                    interval = base;
                    if (r.sig === lastSig) return "same";
                    if (o.isEditing()) { deferred = true; pendingSig = r.sig; return "deferred"; }
                    lastSig = r.sig;
                }
                deferred = false;
                const res = await o.runSync();
                if (!res || !res.ok) { lastSig = null; if (res && /timeout|network|http_error|forbidden/.test(res.code || "")) interval = Math.min(interval * 2, max); return "sync_failed"; }
                return "synced";
            } finally { running = false; }
        }
        return { check, delay: () => interval, isDeferred: () => deferred, reset: () => { lastSig = null; interval = base; } };
    }

    let core = null, bar, textEl, btn, lastFp = "", wasConnected = false, timer = null, debounce = null, hiddenByUser = false, lastMsg = "";
    const MSG = {
        not_connected: "Googleドライブに未接続です。",
        local_corrupt: "この端末の保存データを読めないため、同期を止めています。",
        state_corrupt: "同期の記録を読めません。",
        backup_failed: "初回の控えを保存できないため、同期を止めています。",
        busy_local: "同期中に編集されたので、少し後でやり直します。",
        write_failed: "この端末へ書き込めませんでした（空き容量を確認）。",
        timeout: "通信に時間がかかっています。",
        auth_expired: "Googleの許可が切れました。もう一度接続してください。",
        forbidden: "Google Driveを利用できません。",
        network: "通信できませんでした。",
        http_error: "通信できませんでした。",
        unexpected: "同期できませんでした。",
        busy: ""
    };
    const WARN = {
        too_large: "データが大きすぎて、この端末の変更を送れません。",
        push_failed: "この端末の変更を送れませんでした（次に再送します）。",
        newer_version: "新しい版のアプリのデータがあります。アプリを更新してください。",
        file_invalid: "読めないファイルがありました（その分は使っていません）。",
        file_unreadable: "一部のファイルを読めませんでした。",
        records_dropped: "形式の正しくない記録を使いませんでした。"
    };
    const connected = () => { try { return typeof HwDriveAuth !== "undefined" && HwDriveAuth.state().connected; } catch (e) { return false; } };
    const hm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
    function layoutBars() {
        const stg = document.getElementById("stagingBanner");
        const sh = stg ? stg.offsetHeight : 0;
        if (bar) bar.style.top = sh + "px";
        const h = sh + (bar && !bar.hidden ? bar.offsetHeight : 0);
        document.documentElement.style.setProperty("--hw-sync-top", h + "px");
    }
    function show(text, kind) {
        if (!bar) return;
        lastMsg = text;
        textEl.textContent = text;
        bar.dataset.kind = kind || "";
        const c = connected();
        btn.textContent = c ? "今すぐ同期" : "接続して同期";
        bar.hidden = hiddenByUser && kind !== "error";
        layoutBars();
    }
    function isEditing() {
        if (typeof window !== "undefined" && window.HwApp && typeof window.HwApp.isEditing === "function") {
            try { if (window.HwApp.isEditing()) return true; } catch (e) { /* 下の判定へ */ }
        }
        if (typeof document === "undefined") return false;
        const a = document.activeElement;
        if (a && !(bar && bar.contains(a))) {
            const tag = a.tagName;
            if (a.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !/^(button|submit|checkbox|radio|range|file|reset|image)$/i.test(a.type || ""))) return true;
        }
        for (const id of ["dlg", "sheet", "cv", "genSet", "docEd", "docPv", "printView", "ptOv", "refPane"]) {
            const m = document.getElementById(id);
            if (m && m.classList && m.classList.contains("open")) return true;
            if (m && m.style && m.style.display && m.style.display !== "none" && id === "dlg") return true;
        }
        return false;
    }
    function keepScroll(fn) {
        const y = window.scrollY, saved = [];
        for (const el of document.querySelectorAll("body *")) if (el.scrollTop > 0) saved.push([el, el.scrollTop]);
        try { return fn(); } finally {
            const back = () => { window.scrollTo(0, y); for (const [el, t] of saved) if (el.isConnected) el.scrollTop = t; };
            back(); requestAnimationFrame(back);
        }
    }
    let toastEl = null, toastTimer = null;
    function toast(text) {
        if (!toastEl) {
            toastEl = document.createElement("div"); toastEl.id = "dataSyncToast"; toastEl.setAttribute("role", "status");
            toastEl.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);max-width:92vw;white-space:nowrap;padding:8px 14px;border-radius:18px;background:rgba(20,40,60,.88);color:#fff;font:13px/1.4 sans-serif;z-index:9500;pointer-events:none;transition:opacity .3s;opacity:0;";
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text; toastEl.style.opacity = "1";
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 2500);
    }
    function refreshApp() {
        keepScroll(() => {
            try {
                if (typeof window !== "undefined" && window.HwApp && typeof window.HwApp.refreshFromStorage === "function") window.HwApp.refreshFromStorage();
            } catch (e) { console.error("hwsync: refresh_failed"); }
        });
    }
    let deferredLocal = false;
    async function syncNow(opt, how) {
        if (!core) return null;
        if (how && how.auto && isEditing()) { deferredLocal = true; return { ok: false, code: "editing" }; }
        deferredLocal = false;
        if (!connected()) { show("自動同期: Googleドライブに未接続（この端末だけに保存中）", "warn"); return null; }
        show("同期中…", "");
        let r = await core.sync(opt);
        if (!r.ok && r.code === "mass_delete") {
            const yes = confirm("この端末で部材・集計・書類が" + r.count + "件まとめて消えています。\n\nOK: もう1台からも消す\nキャンセル: 消さずに、もう1台から戻す");
            r = await core.sync({ massDelete: yes ? "allow" : "restore" });
        }
        if (r.code === "busy_local") schedule();
        if (r.ok && poller) poller.reset();
        lastFp = core.fingerprint();
        if (r.ok) {
            const s = r.stats; const bits = [];
            if (s.first) bits.push("初回の突き合わせをしました（同期前の控えあり）");
            if (s.added) bits.push("他の端末から" + s.added + "件追加");
            if (s.changed) bits.push(s.changed + "件更新");
            if (s.conflicts) bits.push("食い違い" + s.conflicts + "項目は空欄でない方を採用");
            const w = (r.warnings || []).map(x => WARN[x]).filter(Boolean);
            show("同期済み " + hm(Date.now()) + (bits.length ? " — " + bits.join("・") : "") + (w.length ? " ⚠ " + w.join(" ") : ""), w.length ? "warn" : "ok");
            if (s.writes) { refreshApp(); if (how && how.auto && (s.added || s.changed || s.deletedHere)) toast("他の端末の変更を反映しました"); }
            if ((r.warnings || []).length) console.error("hwsync: " + (r.warnings || []).join(","));
        } else if (r.code !== "busy") {
            show("同期できませんでした: " + (MSG[r.code] || MSG.unexpected), "error");
            if (r.code) console.error("hwsync: " + r.code);
        }
        return r;
    }
    function askClientId() {
        const existing = typeof HwDriveAuth !== "undefined" && HwDriveAuth.configured();
        if (existing) return Promise.resolve(true);
        return new Promise((resolve) => {
            const v = window.prompt("Googleの接続用クライアントIDを貼ってください。\n業務Proで使っているものと同じで大丈夫です（末尾が .apps.googleusercontent.com）。\nパスワードやシークレットは不要です。空欄でやめる。", "");
            if (!v) { resolve(false); return; }
            try { HwDriveAuth.saveClientId(v); resolve(true); }
            catch (e) { show(String((e && e.message) || "保存できませんでした。").slice(0, 160), "error"); resolve(false); }
        });
    }
    async function onButton() {
        if (connected()) { syncNow(); return; }
        if (typeof HwDriveAuth === "undefined") return;
        const ok = await askClientId();
        if (!ok) { show("自動同期: 接続用IDがまだないので、この端末だけに保存中", "warn"); return; }
        try { await HwDriveAuth.prepare(); await HwDriveAuth.connect(); } catch (e) { show(String((e && e.message) || "接続できませんでした。").slice(0, 160), "error"); return; }
        wasConnected = true; syncNow();
    }
    function schedule() { clearTimeout(debounce); debounce = setTimeout(() => { debounce = null; syncNow(null, { auto: true }); }, 2000); }
    function tick() {
        if (!core) return;
        const c = connected();
        if (c && !wasConnected) { wasConnected = true; syncNow(null, { auto: true }); return; }
        if (deferredLocal && c && !isEditing()) { syncNow(null, { auto: true }); return; }
        if (poller && poller.isDeferred() && !isEditing()) { poller.check(); }
        if (!c && wasConnected) { wasConnected = false; show("自動同期: 接続が切れました（この端末だけに保存中）", "warn"); }
        const fp = core.fingerprint();
        if (fp === lastFp) return;
        lastFp = fp;
        const cp = core.checkpoint();
        if (cp && cp.code === "mass_delete" && !c) show("部材・集計・書類が" + cp.count + "件まとめて消えています。接続して同期するときに確認します。", "warn");
        if (c) schedule();
    }
    let poller = null, loopTimer = null;
    async function loop() {
        clearTimeout(loopTimer);
        try { await poller.check(); } catch (e) { /* 次の回で */ }
        loopTimer = setTimeout(loop, document.visibilityState === "visible" ? poller.delay() : 60000);
    }
    function kick() { if (poller) { clearTimeout(loopTimer); loopTimer = setTimeout(loop, 500); } }
    function afterRestore() { if (core) core.rebase(); }
    function downloadBeforeSync() {
        try {
            const b = core && core.exportBeforeSync ? core.exportBeforeSync() : null;
            if (!b) { alert("この端末には、初回同期の前の記録はまだありません。"); return; }
            const blob = new Blob([JSON.stringify(b)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = "HWParts-before-sync.json"; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) { alert("書き出せませんでした。"); }
    }
    function init() {
        if (typeof HwDataSync === "undefined" || typeof AppStorage === "undefined") return;
        try {
            const channel = (typeof AppProfile !== "undefined" && AppProfile.channel) || "hw-parts-staging";
            const adapter = (typeof HwDriveAdapter !== "undefined" && typeof HwDriveAuth !== "undefined")
                ? HwDriveAdapter.create({ transport: HwDriveAuth, channel, app: HwDataSync.APP, prefix: "HWParts-data-", maxBytes: HwDataSync.MAX_FILE_BYTES }) : null;
            core = HwDataSync.create({ storage: AppStorage, adapter });
        } catch (e) { core = null; console.error("hwsync: init_failed"); return; }
        bar = document.createElement("div");
        bar.id = "dataSyncBar";
        bar.setAttribute("role", "status");
        textEl = document.createElement("span"); textEl.id = "dataSyncText";
        btn = document.createElement("button"); btn.type = "button"; btn.id = "dataSyncBtn"; btn.addEventListener("click", onButton);
        const hide = document.createElement("button"); hide.type = "button"; hide.id = "dataSyncHide"; hide.textContent = "隠す"; hide.title = "この表示を隠す（失敗のときは再表示）";
        hide.addEventListener("click", () => { hiddenByUser = true; bar.hidden = bar.dataset.kind !== "error"; layoutBars(); });
        const dl = document.createElement("button"); dl.type = "button"; dl.id = "beforeSyncDownload"; dl.textContent = "初回同期前の控えを書き出す";
        dl.addEventListener("click", downloadBeforeSync);
        bar.appendChild(textEl); bar.appendChild(btn); bar.appendChild(dl); bar.appendChild(hide);
        const staging = document.getElementById("stagingBanner");
        if (staging && staging.nextSibling) staging.parentNode.insertBefore(bar, staging.nextSibling);
        else document.body.insertBefore(bar, document.body.firstChild);
        const st = core.status();
        show(st.everSynced ? "自動同期: 接続すると、もう1台と自動で揃えます" : "自動同期: 接続すると、もう1台と部材・集計・書類・自社情報を自動で揃えます（初回は合わせる前に控えを取ります）", "warn");
        lastFp = "";
        timer = setInterval(tick, 3000);
        poller = createPoller({ core, isVisible: () => document.visibilityState === "visible", isConnected: connected, isEditing, runSync: () => syncNow(null, { auto: true }) });
        loop();
        layoutBars();
        window.addEventListener("resize", layoutBars);
        document.addEventListener("focusout", () => setTimeout(() => { if (!isEditing()) { if (deferredLocal) syncNow(null, { auto: true }); else if (poller.isDeferred()) poller.check(); } }, 300));
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") { if (connected()) syncNow(null, { auto: true }); kick(); layoutBars(); }
            else { try { core.checkpoint(); } catch (e) { /* 次で */ } }
        });
        if (typeof HwDriveAuth !== "undefined" && HwDriveAuth.configured()) HwDriveAuth.prepare().catch(() => {});
    }
    const start = () => setTimeout(init, 0);
    if (typeof document !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
    return { createPoller, syncNow, afterRestore, downloadBeforeSync, status: () => core ? core.status() : null, _core: () => core, _isEditing: () => isEditing() };
})();
if (typeof module !== "undefined" && module.exports) module.exports = HwDataSyncUI;
