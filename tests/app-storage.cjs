// お試し版の保存キー接頭辞。本番キーを誤って上書きしないこと。架空データのみ。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");

function load(pathname, seed = {}) {
    const mem = new Map(Object.entries(seed));
    const localStorage = {
        get length() { return mem.size; },
        key(i) { return [...mem.keys()][i]; },
        getItem(k) { return mem.has(k) ? mem.get(k) : null; },
        setItem(k, v) { mem.set(k, String(v)); },
        removeItem(k) { mem.delete(k); }
    };
    const ctx = vm.createContext({ location: { pathname }, document: { readyState: "complete", addEventListener() {}, getElementById: () => null, title: "見積り・請求書", body: null }, localStorage, console });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js/app-profile.js"), "utf8") + "\n" + fs.readFileSync(path.join(ROOT, "js/app-storage.js"), "utf8") + "\nglobalThis.AppProfile=AppProfile;globalThis.AppStorage=AppStorage;", ctx);
    return { mem, profile: vm.runInContext("AppProfile", ctx), storage: vm.runInContext("AppStorage", ctx) };
}

test("お試し版は接頭辞付きで書き、本番キーは読まない（接続用IDだけ読む）", () => {
    const { mem, profile, storage } = load("/hw-parts-calculator-staging/", {
        "hwParts.workState.v1": "PROD_HW",
        "culo_google_calendar_client_id": "1234567890-abc.apps.googleusercontent.com"
    });
    assert.equal(profile.staging, true);
    assert.equal(profile.channel, "hw-parts-staging");
    storage.setItem("hwParts.workState.v1", "STAGING_HW");
    assert.equal(mem.get("hwParts.workState.v1"), "PROD_HW");
    assert.equal(mem.get("stgHw:hwParts.workState.v1"), "STAGING_HW");
    assert.equal(storage.getItem("hwParts.workState.v1"), "STAGING_HW");
    assert.equal(storage.getItem("culo_google_calendar_client_id"), "1234567890-abc.apps.googleusercontent.com");
});

test("本番パスでは接頭辞なし。お試し版のキーは見えない", () => {
    const { mem, profile, storage } = load("/hw-parts-calculator/", {
        "stgHw:hwParts.workState.v1": "STAGING_HW",
        "hwParts.workState.v1": "PROD_HW"
    });
    assert.equal(profile.staging, false);
    assert.equal(profile.channel, "hw-parts-main");
    assert.equal(storage.getItem("hwParts.workState.v1"), "PROD_HW");
    assert.ok(!storage.keys().includes("stgHw:hwParts.workState.v1"));
    storage.setItem("genParts.docs.v1", "[]");
    assert.equal(mem.get("genParts.docs.v1"), "[]");
    assert.equal(mem.get("stgHw:hwParts.workState.v1"), "STAGING_HW");
});

test("お試し版のchannelは業務Proと衝突しない", () => {
    const { profile } = load("/hw-parts-calculator-staging/");
    assert.equal(profile.channel, "hw-parts-staging");
    assert.notEqual(profile.channel, "gyomupro-staging");
    assert.notEqual(profile.channel, "gyomupro-main");
});
